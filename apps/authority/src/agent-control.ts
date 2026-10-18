import { createHash,randomUUID,timingSafeEqual } from 'node:crypto';
import type { Express,Request,Response,NextFunction } from 'express';
import { z } from 'zod';
import { onboardingSchemas as schemas,type AgentInstance,type Principal,type ProvisionAgentInput } from '../../../packages/contracts/src/index.js';
import { AccountService } from './accounts.js';
import { AuthorityEngine,Denial,deny } from './engine.js';
import { vaultCredentialStore,type CredentialStore } from './credential-store.js';

export interface RunnerAdmission { id:string;keyHash:string;organizationIds:string[] }
export interface AgentControlOptions { credentials?:CredentialStore;mcpUrl:string;runners:RunnerAdmission[];onboardingRunnerId?:string }
type AgentRow={id:string;connection_id:string;organization_id:string;requester_account_id:string;parent_principal_id:string;parent_grant_id:string;idempotency_key:string;request_json:string;state:AgentInstance['state'];execution_state:AgentInstance['execution_state'];child_principal_id:string|null;child_grant_id:string|null;secret_reference:string;cleanup_pending:number;created_at:string;updated_at:string};
type JobRow={id:string;agent_id:string;launch_id:string;runner_id:string|null;claim_id:string|null;claim_key:string|null;lease_expires_at:string|null;attempts:number;delivered:number;outcome:'COMPLETED'|'FAILED'|null;result_fingerprint:string|null};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

export class AgentControl {
  constructor(readonly engine:AuthorityEngine,readonly options:AgentControlOptions){
    if(options.onboardingRunnerId&&!options.runners.some(r=>r.id===options.onboardingRunnerId))throw new Error('Trusted onboarding runner must be configured');
  }
  private get db(){return this.engine.db;}
  private async connection(p:Principal){
    const c=await new AccountService(this.db,this.engine.now).connectionForPrincipal(p.id);
    if(!c||c.organization_id!==p.organization_id||c.state==='REVOKED'||c.revoked_at||c.account_state!=='ACTIVE'||c.membership_state!=='ACTIVE'||!c.principal_active)deny('INVALID_CALLER','Active connection required',401);
    if(c.state!=='ACTIVE'||!c.grant_id)deny('INSUFFICIENT_SCOPE','Trusted connection consent required');
    await this.engine.chain(c.grant_id,p);
    return c;
  }
  private async row(id:string){return await this.db.prepare('SELECT * FROM managed_agents WHERE id=?').get(id) as AgentRow|undefined;}
  private async owned(p:Principal,id:string){const c=await this.connection(p),row=await this.row(id);if(!row||row.connection_id!==c.id)deny('INVALID_CALLER','Agent unavailable',404);return row;}
  private async output(row:AgentRow):Promise<AgentInstance>{
    const request=JSON.parse(row.request_json) as ProvisionAgentInput;
    return schemas.agent_data.parse({agent_id:row.id,organization_id:row.organization_id,connection_id:row.connection_id,requester_account_id:row.requester_account_id,display_name:request.display_name,template_id:request.template_id,state:row.state,execution_state:row.execution_state,simulated:true,authority:row.child_grant_id?{principal_id:row.child_principal_id,grant_id:row.child_grant_id,scope:(await this.engine.grant(row.child_grant_id)).scope}:null});
  }
  private async stop(row:AgentRow,state:'FAILED'|'REVOKED'){
    if(row.state==='REVOKED'||(row.state==='FAILED'&&state==='FAILED'))return;
    if(row.child_grant_id)await this.db.prepare('UPDATE grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(this.engine.time(),row.child_grant_id);
    await this.db.prepare('UPDATE managed_agents SET state=?,execution_state=?,cleanup_pending=1,updated_at=? WHERE id=?').run(state,row.execution_state==='COMPLETED'?'COMPLETED':state==='REVOKED'?'STOPPED':'FAILED',this.engine.time(),row.id);
    await this.engine.audit(await this.db.prepare('SELECT id,organization_id,kind,role FROM principals WHERE id=?').get(row.parent_principal_id),state==='REVOKED'?'agent.revoke':'agent.fail','DENY',row.child_grant_id??row.parent_grant_id,undefined,row.id);
  }
  private async reconcile(row:AgentRow){
    if(row.state==='FAILED'||row.state==='REVOKED')return row;
    let invalid=false;
    try{
      await this.connection(await this.engine.principal(row.parent_principal_id));
      if(row.child_grant_id)await this.engine.chain(row.child_grant_id,await this.engine.principal(row.child_principal_id!));
    }catch(error){if(!(error instanceof Denial))throw error;invalid=true;}
    const job=await this.db.prepare('SELECT * FROM agent_jobs WHERE agent_id=?').get(row.id) as JobRow|undefined;
    if(invalid||(row.state==='PENDING'&&Date.parse(row.created_at)+300000<=this.engine.now().getTime())||(job&&!job.outcome&&job.lease_expires_at&&Date.parse(job.lease_expires_at)<=this.engine.now().getTime()&&(job.delivered===1||job.attempts>=3)))await this.stop(row,'FAILED');
    return (await this.row(row.id))!;
  }
  private async cleanup(id:string){
    const row=await this.row(id);
    if(!row?.cleanup_pending||!this.options.credentials)return;
    try{await this.options.credentials.remove(row.secret_reference);}catch{return;}
    await this.db.prepare('UPDATE managed_agents SET cleanup_pending=0 WHERE id=?').run(id);
  }
  async advance(id:string){
    let row=await this.db.transaction(async()=>this.reconcile((await this.row(id))!)).immediate();
    if(row.state!=='PENDING'){await this.cleanup(id);return;}
    if(!this.options.credentials)return;
    let secret:string;
    try{secret=await this.options.credentials.ensure(row.secret_reference);}catch{return;}
    try{
      await this.db.transaction(async()=>{
        row=(await this.row(id))!;
        if(row.state!=='PENDING'){if(['FAILED','REVOKED'].includes(row.state))await this.db.prepare('UPDATE managed_agents SET cleanup_pending=1 WHERE id=?').run(id);return;}
        const p=await this.engine.principal(row.parent_principal_id);await this.connection(p);
        const request=JSON.parse(row.request_json) as ProvisionAgentInput;
        const issued=await this.engine.provisionChildInTransaction(p,row.parent_grant_id,request.requested_scope,hash(secret),`managed-${id}`);
        await this.db.prepare("UPDATE managed_agents SET state='PROVISIONING',child_principal_id=?,child_grant_id=?,updated_at=? WHERE id=?").run(issued.principal.id,issued.grant.id,this.engine.time(),id);
        await this.db.prepare('INSERT INTO agent_jobs(id,agent_id,launch_id) VALUES(?,?,?)').run(randomUUID(),id,randomUUID());
        await this.engine.audit(p,'agent.provision','ALLOW',issued.grant.id,undefined,id);
      }).immediate();
    }catch(error){
      if(!(error instanceof Denial))throw error;
      await this.db.transaction(async()=>this.stop((await this.row(id))!,'FAILED')).immediate();
    }
    await this.cleanup(id);
  }
  async provision(p:Principal,input:unknown){
    const request=schemas.provision_request.parse(input),json=JSON.stringify(request);
    if(!this.options.credentials)deny('SERVICE_UNAVAILABLE','Private credential delivery is not configured',503);
    const id=await this.transition(async()=>{
      const c=await this.connection(p);
      if(this.options.onboardingRunnerId){
        const account=await this.db.prepare("SELECT id FROM accounts WHERE id=? AND personal_organization_id=? AND state='ACTIVE'").get(c.account_id,c.organization_id);
        if(!account)deny('INVALID_CALLER','Only a verified personal workspace can receive automatic runner assignment');
        await this.db.prepare('INSERT INTO runner_workspace_assignments(organization_id,runner_id,account_id,created_at) VALUES(?,?,?,?) ON CONFLICT(organization_id) DO NOTHING').run(c.organization_id,this.options.onboardingRunnerId,c.account_id,this.engine.time());
        const assigned=await this.db.prepare('SELECT runner_id,account_id FROM runner_workspace_assignments WHERE organization_id=?').get(c.organization_id);
        if(assigned.runner_id!==this.options.onboardingRunnerId||assigned.account_id!==c.account_id)deny('SERVICE_UNAVAILABLE','Trusted runner assignment requires operator review',503);
      }
      const previous=await this.db.prepare('SELECT * FROM managed_agents WHERE connection_id=? AND idempotency_key=?').get(c.id,request.idempotency_key) as AgentRow|undefined;
      if(previous){if(previous.request_json!==json)deny('ALREADY_EXECUTED','Provisioning key is bound to another request',409);return previous.id;}
      const minute=new Date(this.engine.now().getTime()-60000).toISOString();
      await this.db.prepare('DELETE FROM agent_provision_attempts WHERE connection_id=? AND created_at<=?').run(c.id,minute);
      await this.db.prepare('INSERT INTO agent_provision_attempts(id,connection_id,created_at) VALUES(?,?,?)').run(randomUUID(),c.id,this.engine.time());
      const attempts=await this.db.prepare('SELECT COUNT(*) AS n FROM agent_provision_attempts WHERE connection_id=?').get(c.id);
      if(Number(attempts.n)>5)deny('INSUFFICIENT_SCOPE','Connection provisioning rate reached');
      this.engine.subset(request.requested_scope,c.scope!);
      if(Date.parse(request.requested_scope.expires_at)>this.engine.now().getTime()+3600000||request.requested_scope.max_delegation_depth>2)deny('OUTSIDE_PARENT_SCOPE','Child lifetime or delegation depth exceeds service policy');
      if(Date.parse(request.requested_scope.expires_at)<=this.engine.now().getTime())deny('GRANT_EXPIRED','Child scope expired');
      const rows=await this.db.prepare('SELECT * FROM managed_agents WHERE connection_id=? ORDER BY created_at,id').all(c.id) as AgentRow[];
      const live:AgentRow[]=[];for(const row of rows)live.push(await this.reconcile(row));
      if(live.filter(r=>!['FAILED','REVOKED'].includes(r.state)).length>=10||live.filter(r=>['PENDING','PROVISIONING'].includes(r.state)).length>=3)deny('INSUFFICIENT_SCOPE','Connection agent capacity reached');
      const id=randomUUID();
      await this.db.prepare("INSERT INTO managed_agents(id,connection_id,organization_id,requester_account_id,parent_principal_id,parent_grant_id,idempotency_key,request_json,state,execution_state,secret_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'PENDING','NOT_STARTED',?,?,?)").run(id,c.id,c.organization_id,c.account_id,p.id,c.grant_id,request.idempotency_key,json,`agentpass-child-${id}`,this.engine.time(),this.engine.time());
      await this.engine.audit(p,'agent.intent','ALLOW',c.grant_id!,undefined,id);return id;
    });
    await this.advance(id);return this.output((await this.row(id))!);
  }
  async get(p:Principal,id:string){await this.owned(p,id);await this.advance(id);return this.output(await this.owned(p,id));}
  async list(p:Principal,input:unknown){
    const {cursor,limit=20}=schemas.list_request.parse(input),c=await this.connection(p);
    let boundary:AgentRow|undefined;
    if(cursor){boundary=await this.row(cursor);if(!boundary||boundary.connection_id!==c.id)deny('INVALID_CALLER','Cursor unavailable',404);}
    const rows=await this.db.prepare('SELECT * FROM managed_agents WHERE connection_id=? ORDER BY created_at,id').all(c.id) as AgentRow[];
    const candidates=rows.filter(r=>!boundary||r.created_at>boundary.created_at||(r.created_at===boundary.created_at&&r.id>boundary.id));
    const selected=candidates.slice(0,limit),agents=[];for(const row of selected)agents.push(await this.get(p,row.id));
    return {agents,next_cursor:candidates.length>limit?selected.at(-1)!.id:null};
  }
  async revoke(p:Principal,id:string,input:unknown){
    schemas.revoke_agent_request.parse({...(input as object),agent_id:id});
    await this.db.transaction(async()=>{await this.stop(await this.owned(p,id),'REVOKED');}).immediate();
    await this.cleanup(id);return this.output((await this.row(id))!);
  }
  authenticateRunner(token:string|undefined){
    if(!token)deny('INVALID_CALLER','Runner authentication required',401);
    const digest=Buffer.from(hash(token),'hex');
    const matches=this.options.runners.filter(r=>timingSafeEqual(Buffer.from(r.keyHash,'hex'),digest));
    if(matches.length!==1)deny('INVALID_CALLER','Runner authentication required',401);
    return matches[0];
  }
  private async runnerAdmitted(runner:RunnerAdmission,organizationId:string){
    if(runner.organizationIds.includes(organizationId))return true;
    return !!await this.db.prepare('SELECT organization_id FROM runner_workspace_assignments WHERE organization_id=? AND runner_id=?').get(organizationId,runner.id);
  }
  private async admitted(runner:RunnerAdmission,job:JobRow){
    const row=await this.row(job.agent_id);
    if(!row||!await this.runnerAdmitted(runner,row.organization_id))deny('INVALID_CALLER','Job unavailable',404);
    return row;
  }
  private async transition<T>(fn:()=>Promise<T>):Promise<T>{
    const outcome=await this.db.transaction(async()=>{try{return {value:await fn()};}catch(error){if(error instanceof Denial)return {denial:error};throw error;}}).immediate();
    if('denial' in outcome)throw outcome.denial;
    return outcome.value;
  }
  private async active(runner:RunnerAdmission,id:string,claimId:string,terminalReplay=false){
    const job=await this.db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(id) as JobRow|undefined;
    if(!job||job.runner_id!==runner.id||job.claim_id!==claimId)deny('INVALID_CALLER','Job unavailable',404);
    const row=await this.reconcile(await this.admitted(runner,job));
    if(['FAILED','REVOKED'].includes(row.state)||(!terminalReplay&&job.outcome)||!job.lease_expires_at||Date.parse(job.lease_expires_at)<=this.engine.now().getTime())deny('INVALID_CALLER','Claim is no longer live',403);
    return {job,row};
  }
  private async claimed(job:JobRow){
    const row=(await this.row(job.agent_id))!,request=JSON.parse(row.request_json) as ProvisionAgentInput;
    return {job:{job_id:job.id,agent_id:row.id,claim_id:job.claim_id!,launch_id:job.launch_id,template_id:request.template_id,task:request.task,grant_id:row.child_grant_id!,lease_expires_at:job.lease_expires_at!}};
  }
  async claim(runner:RunnerAdmission,input:unknown){
    const {idempotency_key}=schemas.runner_claim_request.parse(input);
    const pending=await this.db.prepare("SELECT id,organization_id FROM managed_agents WHERE state='PENDING' OR cleanup_pending=1").all();
    for(const row of pending)if(await this.runnerAdmitted(runner,row.organization_id))await this.advance(row.id);
    return this.transition(async()=>{
      const previous=await this.db.prepare('SELECT job_id,claim_id FROM agent_job_claims WHERE runner_id=? AND idempotency_key=?').get(runner.id,idempotency_key);
      if(previous){const {job}=await this.active(runner,previous.job_id,previous.claim_id);return this.claimed(job);}
      const jobs=await this.db.prepare('SELECT * FROM agent_jobs WHERE outcome IS NULL ORDER BY id').all() as JobRow[];
      for(const job of jobs){
        let row=await this.row(job.agent_id);if(!row||!await this.runnerAdmitted(runner,row.organization_id))continue;
        row=await this.reconcile(row);if(row.state!=='PROVISIONING')continue;
        if(job.lease_expires_at&&Date.parse(job.lease_expires_at)>this.engine.now().getTime())continue;
        const claimId=randomUUID(),expiry=new Date(Math.min(this.engine.now().getTime()+30000,Date.parse((await this.engine.grant(row.child_grant_id!)).scope.expires_at))).toISOString();
        await this.db.prepare('UPDATE agent_jobs SET runner_id=?,claim_id=?,claim_key=?,lease_expires_at=?,attempts=attempts+1 WHERE id=?').run(runner.id,claimId,idempotency_key,expiry,job.id);
        await this.db.prepare('INSERT INTO agent_job_claims(runner_id,idempotency_key,job_id,claim_id) VALUES(?,?,?,?)').run(runner.id,idempotency_key,job.id,claimId);
        await this.engine.audit(await this.engine.principal(row.parent_principal_id),'agent.claim','ALLOW',row.child_grant_id!,undefined,row.id);
        return this.claimed((await this.db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(job.id)) as JobRow);
      }
      return {job:null};
    });
  }
  async deliver(runner:RunnerAdmission,id:string,input:unknown){
    const {claim_id}=schemas.runner_credential_request.parse(input);
    if(!this.options.credentials)deny('SERVICE_UNAVAILABLE','Private credential delivery unavailable',503);
    const reference=await this.transition(async()=>{
      const {row}=await this.active(runner,id,claim_id);
      // Persist delivery before reading the secret; a lost reply must never permit reassignment.
      await this.db.prepare('UPDATE agent_jobs SET delivered=1 WHERE id=?').run(id);return row.secret_reference;
    });
    const credential=await this.options.credentials.read(reference);
    return this.transition(async()=>{
      const {row}=await this.active(runner,id,claim_id);
      const child=await this.engine.authenticate(credential);if(child.id!==row.child_principal_id)deny('INVALID_CALLER','Credential binding unavailable');
      return schemas.runner_credential_data.parse({credential,mcp_url:this.options.mcpUrl,expires_at:(await this.engine.grant(row.child_grant_id!)).scope.expires_at});
    });
  }
  async heartbeat(runner:RunnerAdmission,id:string,input:unknown){
    const {claim_id}=schemas.runner_heartbeat_request.parse(input);
    return this.transition(async()=>{
      const {row}=await this.active(runner,id,claim_id);
      const expiry=new Date(Math.min(this.engine.now().getTime()+30000,Date.parse((await this.engine.grant(row.child_grant_id!)).scope.expires_at))).toISOString();
      await this.db.prepare('UPDATE agent_jobs SET lease_expires_at=? WHERE id=?').run(expiry,id);return {stop:false,lease_expires_at:expiry};
    });
  }
  async ready(p:Principal,id:string,input:unknown){
    const {claim_id}=schemas.child_ready_request.parse(input);
    return this.transition(async()=>{
      const job=await this.db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(id) as JobRow|undefined;
      if(!job||job.claim_id!==claim_id||job.delivered!==1||job.outcome||!job.lease_expires_at||Date.parse(job.lease_expires_at)<=this.engine.now().getTime())deny('INVALID_CALLER','Live delivered claim required');
      const row=await this.reconcile((await this.row(job.agent_id))!);
      if(row.child_principal_id!==p.id||row.organization_id!==p.organization_id||!['PROVISIONING','READY'].includes(row.state))deny('INVALID_CALLER','Child identity does not match job');
      await this.engine.chain(row.child_grant_id!,p);
      await this.db.prepare("UPDATE managed_agents SET state='READY',execution_state='RUNNING',updated_at=? WHERE id=?").run(this.engine.time(),row.id);
      await this.engine.audit(p,'agent.ready','ALLOW',row.child_grant_id!,undefined,row.id);return this.output((await this.row(row.id))!);
    });
  }
  async result(runner:RunnerAdmission,id:string,input:unknown){
    const result=schemas.runner_result_request.parse(input),fingerprint=hash(JSON.stringify(result));
    return this.transition(async()=>{
      const {job,row}=await this.active(runner,id,result.claim_id,true);
      if(job.result_fingerprint){if(job.result_fingerprint!==fingerprint)deny('ALREADY_EXECUTED','Result already recorded',409);return this.output(row);}
      if(result.outcome==='COMPLETED'&&row.state!=='READY')deny('INVALID_REQUEST','Child readiness is required before completion');
      await this.db.prepare('UPDATE agent_jobs SET outcome=?,result_fingerprint=? WHERE id=?').run(result.outcome,fingerprint,id);
      if(result.outcome==='FAILED')await this.stop(row,'FAILED');
      else await this.db.prepare("UPDATE managed_agents SET execution_state='COMPLETED',updated_at=? WHERE id=?").run(this.engine.time(),row.id);
      // Raw runner summaries are untrusted and may contain provider credentials; persist only outcome/hash.
      await this.engine.audit(await this.engine.principal(row.child_principal_id!),'agent.result',result.outcome,row.child_grant_id!,undefined,row.id);
      return this.output((await this.row(row.id))!);
    });
  }
}

export function mountAgentControl(app:Express,engine:AuthorityEngine,options:AgentControlOptions){
  const control=new AgentControl(engine,options);
  const route=(fn:(req:Request,res:Response)=>Promise<unknown>)=>async(req:Request,res:Response,next:NextFunction)=>{try{res.setHeader('Cache-Control','no-store');res.json({status:'OK',data:await fn(req,res)});}catch(error){next(error);}};
  const runner=(req:Request)=>control.authenticateRunner(req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1]);
  app.post('/v1/agents',route((req,res)=>control.provision(res.locals.principal,req.body)));
  app.get('/v1/agents',route((req,res)=>control.list(res.locals.principal,{...req.query,...(typeof req.query.limit==='string'&&/^\d+$/.test(req.query.limit)?{limit:Number(req.query.limit)}:{})})));
  app.get('/v1/agents/:agent_id',route((req,res)=>control.get(res.locals.principal,String(req.params.agent_id))));
  app.post('/v1/agents/:agent_id/revoke',route((req,res)=>control.revoke(res.locals.principal,String(req.params.agent_id),req.body)));
  app.post('/v1/agent-runs/:job_id/ready',route((req,res)=>control.ready(res.locals.principal,String(req.params.job_id),req.body)));
  app.post('/internal/agent-jobs/claim',route(req=>control.claim(runner(req),req.body)));
  app.post('/internal/agent-jobs/:job_id/credential',route(req=>control.deliver(runner(req),String(req.params.job_id),req.body)));
  app.post('/internal/agent-jobs/:job_id/heartbeat',route(req=>control.heartbeat(runner(req),String(req.params.job_id),req.body)));
  app.post('/internal/agent-jobs/:job_id/result',route(req=>control.result(runner(req),String(req.params.job_id),req.body)));
  return control;
}

export function agentControlFromEnvironment(engine:AuthorityEngine,env:NodeJS.ProcessEnv=process.env):AgentControlOptions{
  const runners=z.array(z.object({id:z.string().min(1).max(128),keyHash:z.string().regex(/^[a-f0-9]{64}$/),organizationIds:z.array(z.string().min(1))}).strict()).parse(JSON.parse(env.AGENTPASS_RUNNERS_JSON??'[]'));
  const onboardingRunnerId=env.AGENTPASS_ONBOARDING_RUNNER_ID;
  if(onboardingRunnerId&&!runners.some(r=>r.id===onboardingRunnerId))throw new Error('Trusted onboarding runner must be configured');
  if(runners.some(r=>r.organizationIds.length===0&&r.id!==onboardingRunnerId))throw new Error('Runner requires explicit organizations or trusted onboarding assignment');
  if(new Set(runners.map(r=>r.id)).size!==runners.length||new Set(runners.map(r=>r.keyHash)).size!==runners.length)throw new Error('Runner admissions must be unique');
  const mcpUrl=env.MCP_PUBLIC_URL??'http://127.0.0.1:3001/mcp',url=new URL(mcpUrl);
  if(url.protocol!=='https:'&&!(env.NODE_ENV!=='production'&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('Private worker MCP endpoint requires HTTPS or local development loopback');
  if(env.AGENTPASS_CREDENTIAL_STORE&&env.AGENTPASS_CREDENTIAL_STORE!=='vault')throw new Error('Only Vault credential storage is supported');
  if(env.AGENTPASS_CREDENTIAL_STORE==='vault'&&!env.DATABASE_URL)throw new Error('Vault requires PostgreSQL');
  return {credentials:env.AGENTPASS_CREDENTIAL_STORE==='vault'?vaultCredentialStore(engine.db):undefined,mcpUrl,runners,...(onboardingRunnerId?{onboardingRunnerId}:{})};
}

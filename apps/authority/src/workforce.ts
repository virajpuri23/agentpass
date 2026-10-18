import { createHash, randomUUID } from 'node:crypto';
import type { Grant, Principal } from '../../../packages/contracts/src/index.js';
import { workforceActionSchema, type WorkforceActionInput, type WorkforceAction, type WorkforceDecision, type WorkforceScope } from '../../../packages/contracts/src/workforce.js';
import { AuthorityEngine, Denial, deny } from './engine.js';
import { pathWithin, resolveWorkforcePath, validScopePath } from './workforce-paths.js';
import { setAuditContext } from './audit.js';

export interface WorkforceExecutionContext {
  input:WorkforceActionInput;
  principal:Principal;
  execution_id:string;
  paths:string[];
}
export interface WorkforceResource {
  resource:string;
  organization_id:string;
  owner_principal_id:string;
  repo_root?:string;
  allowed_actions:readonly WorkforceAction[];
  execute:(context:WorkforceExecutionContext)=>Promise<Record<string,unknown>>;
}
export interface WorkforceOptions {resources:WorkforceResource[]}

const requestedPaths = (input:WorkforceActionInput):string[] => input.action === 'repo.read' || input.action === 'repo.write' ? [input.parameters.path] : input.action === 'security.audit.run' ? input.parameters.paths : [];
function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export class WorkforceGateway {
  private resources:Map<string,WorkforceResource>;
  constructor(private engine:AuthorityEngine,options:WorkforceOptions = {resources:[]}) {
    this.resources = new Map(options.resources.map(resource=>[resource.resource,resource]));
    if (this.resources.size !== options.resources.length) throw new Error('Duplicate workforce resource registration');
  }
  private supports(grant:Grant,input:WorkforceActionInput,resource:WorkforceResource,action=input.action) {
    const scope = grant.scope.resources?.find(r=>r.resource===input.resource && r.organization_id===resource.organization_id && r.owner_principal_id===resource.owner_principal_id);
    return Boolean(scope && grant.organization_id===resource.organization_id && grant.scope.actions.includes(action) && requestedPaths(input).every(path=>validScopePath(path) && scope.paths.some(allowed=>pathWithin(path,allowed))));
  }
  private required(input:WorkforceActionInput,chain:Grant[],resource:WorkforceResource,action=input.action):WorkforceScope {
    return {actions:[action],supplier_ids:[],sku_ids:[],max_per_action_cents:0,total_budget_cents:0,expires_at:chain[0].scope.expires_at,max_delegation_depth:0,max_executions:1,
      resources:[{resource:input.resource,organization_id:resource.organization_id,owner_principal_id:resource.owner_principal_id,paths:requestedPaths(input)}]};
  }
  private async evaluate(p:Principal,input:WorkforceActionInput):Promise<{decision:WorkforceDecision;chain:Grant[];resource:WorkforceResource;paths:string[]}> {
    const chain = await this.engine.chain(input.grant_id,p);
    const resource = this.resources.get(input.resource);
    if (!resource) deny('INSUFFICIENT_SCOPE','Resource is unavailable');
    const paths = requestedPaths(input);
    if (!paths.every(path=>validScopePath(path) && !path.endsWith('/'))) deny('INSUFFICIENT_SCOPE','Repository path is not permitted');
    const allowed = resource.allowed_actions.includes(input.action) && chain.every(g=>this.supports(g,input,resource));
    if (!allowed) {
      const parents = chain.slice(1);
      const recoverable = resource.allowed_actions.includes(input.action) && parents.length>0 && parents.every(g=>this.supports(g,input,resource)) && chain[0].scope.max_delegation_depth >= 0;
      const decision:WorkforceDecision = {status:recoverable?'AUTHORITY_REQUIRED':'DENY',code:recoverable?'INSUFFICIENT_SCOPE':'OUTSIDE_PARENT_SCOPE',reason:recoverable?'Action requires additional authority':'Action is outside available parent authority',next_action:recoverable?'request_authority':'contact_owner'};
      if (recoverable) {
        decision.required_scope = this.required(input,chain,resource);
        const pending = await this.engine.db.prepare("SELECT id,requested_scope_json FROM authority_requests WHERE requester_principal_id=? AND parent_grant_id=? AND status IN ('PENDING','COUNTEROFFERED') ORDER BY created_at DESC").all(p.id,chain[0].parent_grant_id);
        for (const row of pending) {
          const scope = JSON.parse(row.requested_scope_json);
          if (canonical(scope)===canonical(decision.required_scope)) {decision.status='REQUEST_PENDING';decision.request_id=row.id;decision.next_action='get_authority_request';break;}
        }
      } else if (input.action==='deploy.production' && resource.allowed_actions.includes('deploy.preview') && (parents.length ? parents : chain).every(g=>this.supports(g,input,resource,'deploy.preview'))) {
        decision.suggested_action='deploy.preview';decision.next_action='request_authority';decision.required_scope=this.required(input,chain,resource,'deploy.preview');
      }
      return {decision,chain,resource,paths:[]};
    }
    for (const grant of chain) {
      const usage = await this.engine.db.prepare('SELECT COUNT(*) AS n FROM workforce_usage WHERE grant_id=?').get(grant.id);
      if (!grant.scope.max_executions || Number(usage.n)>=grant.scope.max_executions) deny('BUDGET_EXCEEDED','Execution quota exhausted');
    }
    const absolutePaths:string[]=[];
    if (paths.length) {
      if (!resource.repo_root) deny('SERVICE_UNAVAILABLE','Repository gateway is unavailable',503);
      try {for (const path of paths) absolutePaths.push(await resolveWorkforcePath(resource.repo_root,path,input.action==='repo.write'));}
      catch {deny('INSUFFICIENT_SCOPE','Repository path is not permitted');}
    }
    return {decision:{status:'ALLOW',code:'AUTHORIZED',reason:'Current authority permits this exact action'},chain,resource,paths:absolutePaths};
  }
  private async outcome(p:Principal,input:WorkforceActionInput,fn:()=>Promise<WorkforceDecision>) {
    setAuditContext({action:input.action,grantId:input.grant_id});
    let decision:WorkforceDecision;
    try {decision=await fn();}
    catch (error) {
      if (!(error instanceof Denial)) throw error;
      decision={status:'DENY',code:error.result.code,reason:error.result.reason,next_action:error.result.next_action};
    }
    await this.engine.audit(p,input.action,decision.status,input.grant_id,decision.status==='ALLOW'?undefined:decision.code as any,decision.execution_id??decision.request_id);
    return decision;
  }
  async verify(p:Principal,value:WorkforceActionInput) {
    const input=workforceActionSchema.parse(value);
    return this.outcome(p,input,async()=>(await this.evaluate(p,input)).decision);
  }
  async execute(p:Principal,value:WorkforceActionInput):Promise<WorkforceDecision> {
    const input=workforceActionSchema.parse(value);
    return this.outcome(p,input,async()=>{
      const hash=createHash('sha256').update(canonical(input)).digest('hex');
      const reservation = await this.engine.db.transaction(async()=>{
        // Recheck the live chain even for completed replays.
        await this.engine.chain(input.grant_id,p);
        const previous = await this.engine.db.prepare('SELECT * FROM workforce_executions WHERE principal_id=? AND idempotency_key=?').get(p.id,input.idempotency_key);
        if (previous) {
          if (previous.request_hash!==hash) deny('ALREADY_EXECUTED','Idempotency key is bound to another action',409);
          // Revalidate scope/policy/path on replay without charging another quota unit.
          const checked=await this.evaluateReplay(p,input);
          if (checked.status!=='ALLOW') return {decision:checked};
          return {decision:previous.status==='COMPLETED' ? JSON.parse(previous.result_json) as WorkforceDecision : {status:'REQUEST_PENDING',code:'EXECUTION_PENDING',reason:'Execution outcome is pending',next_action:'retry',execution_id:previous.id} as WorkforceDecision};
        }
        const checked=await this.evaluate(p,input);
        if (checked.decision.status!=='ALLOW') return {decision:checked.decision};
        const execution_id=randomUUID();
        await this.engine.db.prepare("INSERT INTO workforce_executions(id,principal_id,grant_id,idempotency_key,request_hash,status,created_at) VALUES(?,?,?,?,?,'PENDING',?)").run(execution_id,p.id,input.grant_id,input.idempotency_key,hash,this.engine.time());
        for (const grant of checked.chain) await this.engine.db.prepare('INSERT INTO workforce_usage(execution_id,grant_id) VALUES(?,?)').run(execution_id,grant.id);
        return {checked,execution_id};
      }).immediate();
      if ('decision' in reservation) return reservation.decision!;
      const {checked,execution_id}=reservation;
      // A trusted adapter receives only this validated operation, never a reusable permission ticket.
      await this.evaluateReplay(p,input);
      if (requestedPaths(input).length) {
        try {for (const path of requestedPaths(input)) await resolveWorkforcePath(checked.resource.repo_root!,path,input.action==='repo.write');}
        catch {deny('INSUFFICIENT_SCOPE','Repository path is not permitted');}
      }
      let result:Record<string,unknown>;
      try {result=await checked.resource.execute({input,principal:p,execution_id,paths:checked.paths});}
      // shortcut: uncertain external outcomes stay pending; add trusted reconciliation before automatic retries.
      catch {return {status:'REQUEST_PENDING',code:'EXECUTION_PENDING',reason:'Execution outcome is pending',next_action:'retry',execution_id};}
      if (!result || typeof result!=='object' || Array.isArray(result)) throw new Error('Invalid protected adapter result');
      const decision:WorkforceDecision={status:'ALLOW',code:'EXECUTED',reason:'Protected action completed',execution_id,result};
      await this.engine.db.transaction(async()=>{
        await this.engine.db.prepare("UPDATE workforce_executions SET status='COMPLETED',result_json=? WHERE id=? AND status='PENDING'").run(JSON.stringify(decision),execution_id);
      }).immediate();
      return decision;
    });
  }
  private async evaluateReplay(p:Principal,input:WorkforceActionInput):Promise<WorkforceDecision> {
    const chain=await this.engine.chain(input.grant_id,p);
    const resource=this.resources.get(input.resource);
    if (!resource || !resource.allowed_actions.includes(input.action) || !chain.every(g=>this.supports(g,input,resource))) deny('INSUFFICIENT_SCOPE','Current authority does not permit this action');
    // A replay returns its original result; it performs no filesystem access or new side effect.
    return {status:'ALLOW',code:'AUTHORIZED',reason:'Current authority permits this exact action'};
  }
}

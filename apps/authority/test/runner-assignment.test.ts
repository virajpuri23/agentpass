import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { afterEach,beforeEach,expect,it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { migrateStore } from '../../../db/migrations.js';
import { sqliteStore } from '../../../db/store.js';
import { postgresStore } from '../../../db/postgres.js';
import { AccountService } from '../src/accounts.js';
import { AgentControl,agentControlFromEnvironment } from '../src/agent-control.js';
import { ConsentService } from '../src/consent.js';
import { AuthorityEngine } from '../src/engine.js';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';

let db:ReturnType<typeof openDatabase>,engine:AuthorityEngine;
const runner={id:'trusted-pool',keyHash:createHash('sha256').update('fixture-runner').digest('hex'),organizationIds:[] as string[]};
const scope:AuthorityScope={actions:['supplier.quote.request'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:0,total_budget_cents:0,expires_at:'2026-10-18T01:00:00Z',max_delegation_depth:2};
const secrets=new Map<string,string>();
const credentials={async ensure(ref:string){if(!secrets.has(ref))secrets.set(ref,randomBytes(32).toString('base64url'));return secrets.get(ref)!;},async read(ref:string){return secrets.get(ref)!;},async remove(ref:string){secrets.delete(ref);}};
const control=(id=runner.id)=>new AgentControl(engine,{mcpUrl:'https://agentpass.example/mcp',runners:[runner,{...runner,id:'other-pool',keyHash:'b'.repeat(64)}],onboardingRunnerId:id,credentials});
const input=()=>({idempotency_key:randomUUID(),display_name:'Fixture child',task:'Quote only',requested_scope:{...scope,max_delegation_depth:1},template_id:'sourcing-v1'});
async function account(subject:string,consent=true){
  const account=await new AccountService(engine.db,engine.now).bootstrap({issuer:'https://fixture.example/auth/v1',subject,client_id:'host-client'});
  if(consent){const service=new ConsentService(engine,()=>scope,engine.now),request=await service.request(account.account_id,account.connection.id,scope);await service.approve(account.account_id,request.id);}
  return account;
}
beforeEach(async()=>{
  db=openDatabase(':memory:');const store=sqliteStore(db);await migrateStore(store,'sqlite');secrets.clear();
  engine=new AuthorityEngine(store,{async policy(){return true;},async quote(){throw Error('unused');},async getQuote(){throw Error('unused');},async fulfill(){throw Error('unused');}},()=>new Date('2026-10-18T00:30:00Z'));
});
afterEach(()=>db.close());
it('assigns a consented fresh workspace once and admits its configured runner after restart',async()=>{
  const first=await account('person-one'),principal=await engine.principal(first.connection.principal_id),request=input();
  const agent=await control().provision(principal,request);expect(agent.state).toBe('PROVISIONING');
  expect((await control().provision(principal,request)).agent_id).toBe(agent.agent_id);
  expect(db.prepare('SELECT * FROM runner_workspace_assignments').all()).toMatchObject([{organization_id:first.organization.id,account_id:first.account_id,runner_id:runner.id}]);
  expect((await control().claim({...runner,id:'unassigned'}, {idempotency_key:'other'})).job).toBeNull();
  const restarted=control(),claim=(await restarted.claim(runner,{idempotency_key:'claim'})).job!;
  expect(claim.agent_id).toBe(agent.agent_id);expect((await restarted.deliver(runner,claim.job_id,{claim_id:claim.claim_id})).credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
it('does not assign before consent and rejects a conflicting runner or account/organization binding',async()=>{
  const pending=await account('pending',false);
  await expect(control().provision(await engine.principal(pending.connection.principal_id),input())).rejects.toMatchObject({result:{code:'INSUFFICIENT_SCOPE'}});
  expect(db.prepare('SELECT * FROM runner_workspace_assignments').all()).toHaveLength(0);
  const first=await account('first'),second=await account('second'),principal=await engine.principal(first.connection.principal_id);
  await control().provision(principal,input());
  await expect(control('other-pool').provision(principal,input())).rejects.toMatchObject({result:{code:'SERVICE_UNAVAILABLE'}});
  expect(()=>db.prepare('INSERT INTO runner_workspace_assignments(organization_id,runner_id,account_id,created_at) VALUES(?,?,?,?)').run(second.organization.id,runner.id,first.account_id,engine.time())).toThrow();
  expect(db.prepare('SELECT * FROM runner_workspace_assignments').all()).toHaveLength(1);
});
it('accepts empty admissions only for a server-configured trusted pool and rejects missing runner identity',()=>{
  const env={MCP_PUBLIC_URL:'https://agentpass.example/mcp',AGENTPASS_RUNNERS_JSON:JSON.stringify([runner]),AGENTPASS_ONBOARDING_RUNNER_ID:runner.id};
  expect(agentControlFromEnvironment(engine,env).onboardingRunnerId).toBe(runner.id);
  expect(()=>agentControlFromEnvironment(engine,{...env,AGENTPASS_ONBOARDING_RUNNER_ID:'missing'})).toThrow();
  expect(()=>agentControlFromEnvironment(engine,{...env,AGENTPASS_ONBOARDING_RUNNER_ID:undefined})).toThrow();
});
it.skipIf(!process.env.AGENTPASS_RUNNER_TEST_DATABASE_URL)('persists a private assignment and runner admission across PostgreSQL connections',async()=>{
  const url=new URL(process.env.AGENTPASS_RUNNER_TEST_DATABASE_URL!);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.pathname.endsWith('_test'))throw Error('Disposable local database required');
  const pg=postgresStore(url.href),now=()=>new Date('2026-10-18T00:30:00Z');let organizationId:string,agentId:string;
  const options={mcpUrl:'https://agentpass.example/mcp',runners:[runner],onboardingRunnerId:runner.id,credentials};
  try{
    await pg.migrate();await migrateStore(pg.store,'postgres');
    const service=new AccountService(pg.store,now),created=await service.bootstrap({issuer:'https://fixture.example/auth/v1',subject:randomUUID(),client_id:'pg-host'}),pgEngine=new AuthorityEngine(pg.store,engine.supplier,now);
    const consent=new ConsentService(pgEngine,()=>scope,now),request=await consent.request(created.account_id,created.connection.id,scope);await consent.approve(created.account_id,request.id);
    organizationId=created.organization.id;agentId=(await new AgentControl(pgEngine,options).provision(await pgEngine.principal(created.connection.principal_id),input())).agent_id;
    expect((await pg.store.prepare("SELECT relrowsecurity FROM pg_class WHERE oid='agentpass.runner_workspace_assignments'::regclass").get()).relrowsecurity).toBe(true);
  }finally{await pg.close();}
  const reopened=postgresStore(url.href);
  try{
    expect(await reopened.store.prepare('SELECT runner_id FROM runner_workspace_assignments WHERE organization_id=?').get(organizationId!)).toEqual({runner_id:runner.id});
    expect((await new AgentControl(new AuthorityEngine(reopened.store,engine.supplier,now),options).claim(runner,{idempotency_key:randomUUID()})).job?.agent_id).toBe(agentId!);
  }finally{await reopened.close();}
});

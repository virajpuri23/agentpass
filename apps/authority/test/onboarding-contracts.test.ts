import { readFileSync } from 'node:fs';
import { createHash,randomBytes } from 'node:crypto';
import { describe,it,expect } from 'vitest';
import { proposalSchemas as s,proposalBundle } from './contracts/onboarding-proposal.js';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { sqliteStore } from '../../../db/store.js';
import { AuthorityEngine } from '../src/engine.js';
import type { SupplierService } from '../src/supplier.js';

const fixture=JSON.parse(readFileSync(new URL('../../../fixtures/onboarding-v1.proposal.json',import.meta.url),'utf8'));
describe('A9 proposed onboarding contract (FIXTURE; not OAuth/runner verification)',()=>{
  it('keeps the portable JSON Schema bundle synchronized with the review validators',()=>{
    expect(JSON.parse(readFileSync(new URL('../../../contracts/proposals/onboarding-v1.schema.json',import.meta.url),'utf8'))).toEqual(proposalBundle());
  });
  it('accepts the bounded context, provisioning and private runner lifecycle fixtures',()=>{
    s.context_request.parse({});s.context_data.parse(fixture.context);s.provision_request.parse(fixture.provision);s.agent_data.parse(fixture.agent);
    s.list_request.parse({limit:20});s.list_data.parse({agents:[fixture.agent],next_cursor:null});s.get_request.parse({agent_id:fixture.agent.agent_id});
    s.runner_claim_request.parse({idempotency_key:'claim-one'});s.runner_claim_data.parse(fixture.claim);s.runner_claim_data.parse({job:null});
    s.runner_heartbeat_request.parse(fixture.ready);s.runner_heartbeat_data.parse({stop:false,lease_expires_at:fixture.claim.job.lease_expires_at});
    s.child_ready_request.parse(fixture.ready);s.runner_result_request.parse(fixture.result);s.revoke_agent_request.parse(fixture.revoke);
    s.revoke_connection_request.parse({reason:'disconnect',idempotency_key:'disconnect-one'});s.revoke_connection_data.parse({connection_id:fixture.context.connection.id,state:'REVOKED'});
  });
  it('rejects model-selected identity, authority approval, secret references and arbitrary runtimes',()=>{
    for(const extra of [{organization_id:'other'},{requester_account_id:'other'},{principal_id:'owner-1'},{role:'OWNER'},{parent_grant_id:'other'},{approved:true},{credential:'do-not-send'},{secret_ref:'other'},{image:'arbitrary'}])expect(s.provision_request.safeParse({...fixture.provision,...extra}).success).toBe(false);
    expect(s.provision_request.safeParse({...fixture.provision,template_id:'arbitrary-code'}).success).toBe(false);
    expect(s.context_request.safeParse({organization_id:'other'}).success).toBe(false);
    expect(s.revoke_connection_request.safeParse({reason:'disconnect',idempotency_key:'one',connection_id:'other'}).success).toBe(false);
    expect(s.runner_claim_request.safeParse({idempotency_key:'one',runner_id:'other'}).success).toBe(false);
    expect(s.child_ready_request.safeParse({...fixture.ready,principal_id:'other',authenticated:true}).success).toBe(false);
  });
  it('rejects oversized tasks/pages, unsupported states and secrets on model-visible records',()=>{
    expect(s.provision_request.safeParse({...fixture.provision,task:'x'.repeat(4001)}).success).toBe(false);
    for(const limit of [0,51,1.5])expect(s.list_request.safeParse({limit}).success).toBe(false);
    expect(s.agent_data.safeParse({...fixture.agent,state:'RUNNING'}).success).toBe(false);
    expect(s.agent_data.safeParse({...fixture.agent,state:'READY',authority:null}).success).toBe(false);
    s.agent_data.parse({...fixture.agent,state:'PENDING',authority:null});
    expect(s.agent_data.safeParse({...fixture.agent,credential:'secret'}).success).toBe(false);
    expect(s.runner_claim_data.safeParse({job:{...fixture.claim.job,credential:'secret'}}).success).toBe(false);
    expect(s.context_data.safeParse({...fixture.context,connection:{...fixture.context.connection,grant_id:null}}).success).toBe(false);
  });
  it('bridges the proposal scope to actual canonical child issuance and denies widening/revoked access',async()=>{
    const db=openDatabase(':memory:');const keys={'owner-1':'a9-fixture-owner','buyer-agent':'a9-fixture-buyer','sourcing-agent':'a9-fixture-source','supplier-agent':'a9-fixture-seller'};
    const now=new Date('2026-10-17T22:00:00.000Z');seedDatabase(db,keys,now);
    const supplier:SupplierService={policy:async()=>true,quote:async()=>{throw new Error('Not used');},getQuote:async()=>{throw new Error('Not used');},fulfill:async()=>{throw new Error('Not used');}};
    const engine=new AuthorityEngine(sqliteStore(db),supplier,()=>now);
    try {
      const parent=await engine.authenticate(keys['buyer-agent']);const request=s.provision_request.parse(fixture.provision);
      const secret=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(secret).digest('hex');
      const issued=await engine.provisionChild(parent,fixture.context.connection.grant_id,request.requested_scope,hash,request.idempotency_key);
      expect(issued.principal.organization_id).toBe(parent.organization_id);expect(issued.principal.role).toBe('SERVICE');expect(issued.principal.id).not.toBe(parent.id);
      expect(await engine.authenticate(secret)).toEqual(issued.principal);expect(await engine.provisionChild(parent,fixture.context.connection.grant_id,request.requested_scope,hash,request.idempotency_key)).toEqual(issued);
      for(const widened of [{actions:['supplier.margin.read']},{supplier_ids:['foreign']},{total_budget_cents:100001},{max_delegation_depth:2}])await expect(engine.provisionChild(parent,fixture.context.connection.grant_id,{...request.requested_scope,...widened} as any,'1'.repeat(64),'widen')).rejects.toMatchObject({result:{code:'OUTSIDE_PARENT_SCOPE'}});
      await engine.revoke(parent,issued.grant.id);await expect(engine.authenticate(secret)).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
      expect(JSON.stringify(issued)).not.toContain(secret);
    } finally {db.close();}
  });
});

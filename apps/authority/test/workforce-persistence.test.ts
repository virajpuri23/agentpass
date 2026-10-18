import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { sqliteStore } from '../../../db/store.js';
import { seedDatabase } from '../../../db/seed.js';
import { seedWorkforceRoot } from '../../../db/seed-workforce.js';
import { workforceScope, workforceKeys, workforceRootId, listenWorkforceApp, workforceRequest } from './fixtures/workforce.js';
import { postgresStore } from '../../../db/postgres.js';
import { seedPostgres } from '../../../db/seed-postgres.js';
import { createAuthorityApp } from '../src/app.js';
import type { SupplierService } from '../src/supplier.js';

const supplier:SupplierService={async policy(){return false;},async quote(){throw new Error('unused');},async getQuote(){throw new Error('unused');},async fulfill(){throw new Error('unused');}};
const seedKeys=Object.fromEntries(Object.entries(workforceKeys).filter(([id])=>['owner-1','buyer-agent','sourcing-agent','supplier-agent'].includes(id)));
const input=()=>({grant_id:workforceRootId,owner_principal_id:'owner-1',subject_principal_id:'buyer-agent',scope:workforceScope({actions:['deploy.preview'],paths:[],max_delegation_depth:2,max_executions:1,expires_at:new Date(Date.now()+600000).toISOString()})});

describe('workforce persistence and root bootstrap',()=>{
  it('requires a persisted owner and preserves revoked roots, scopes and consumed quotas',async()=>{
    const db=openDatabase(':memory:');const store=sqliteStore(db);
    try {
      seedDatabase(db,seedKeys);
      const root=input();
      expect(await seedWorkforceRoot(store,root)).toMatchObject({created:true});
      db.prepare("INSERT INTO workforce_executions(id,principal_id,grant_id,idempotency_key,request_hash,status,created_at) VALUES('used','buyer-agent',?,'used','hash','PENDING',?)").run(root.grant_id,new Date().toISOString());
      db.prepare("INSERT INTO workforce_usage(execution_id,grant_id) VALUES('used',?)").run(root.grant_id);
      db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(new Date().toISOString(),root.grant_id);
      expect(await seedWorkforceRoot(store,root)).toMatchObject({created:false});
      expect(db.prepare('SELECT revoked_at FROM grants WHERE id=?').get(root.grant_id)).toHaveProperty('revoked_at',expect.any(String));
      await expect(seedWorkforceRoot(store,{...root,scope:{...root.scope,max_executions:2}})).rejects.toThrow('refusing to overwrite');
      await expect(seedWorkforceRoot(store,{...root,grant_id:'forged-owner',owner_principal_id:'buyer-agent'})).rejects.toThrow();
      const scope={...root.scope,resources:[{...root.scope.resources[0],owner_principal_id:'buyer-agent'}]};
      await expect(seedWorkforceRoot(store,{...root,grant_id:'forged-resource',scope})).rejects.toThrow();
      await expect(seedWorkforceRoot(store,{...root,grant_id:'expired',scope:{...root.scope,expires_at:new Date(0).toISOString()}})).rejects.toThrow();
      expect(db.prepare('SELECT COUNT(*) n FROM grants').get()).toEqual({n:2});
      expect(db.prepare('SELECT COUNT(*) n FROM workforce_usage').get()).toEqual({n:1});
    } finally {db.close();}
  });

  it.skipIf(!process.env.AGENTPASS_TEST_DATABASE_URL)('serializes generic quota and idempotency across PostgreSQL replicas',async()=>{
    const url=new URL(process.env.AGENTPASS_TEST_DATABASE_URL!);
    if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.pathname.endsWith('_test')) throw new Error('Disposable local _test database required');
    const primary=postgresStore(url.href);const replica=postgresStore(url.href);
    const listeners:Array<Awaited<ReturnType<typeof listenWorkforceApp>>>=[];
    try {
      await primary.migrate();await primary.store.exec('TRUNCATE organizations CASCADE');await seedPostgres(primary,seedKeys);
      const root=input();await seedWorkforceRoot(primary.store,root);
      let calls=0;
      const resources=[{resource:'demo-project',organization_id:'buyer-co',owner_principal_id:'owner-1',allowed_actions:['deploy.preview'] as const,execute:async()=>({simulated:true,call:++calls})}];
      for (const db of [primary.store,replica.store]) listeners.push(await listenWorkforceApp(createAuthorityApp({db,supplier,workforce:{resources}})));
      const action=(key:string)=>({grant_id:root.grant_id,resource:'demo-project',action:'deploy.preview',parameters:{environment:'preview',artifact_digest:'a'.repeat(64)},idempotency_key:key});
      const results=await Promise.all(listeners.map((api,index)=>workforceRequest(api.baseUrl,'/v1/actions/execute',action(`pg-${index}`),workforceKeys['buyer-agent'])));
      expect(results.map(r=>r.body.status).sort()).toEqual(['ALLOW','DENY']);
      expect(results.find(r=>r.body.status==='DENY')?.body.code).toBe('BUDGET_EXCEEDED');expect(calls).toBe(1);
      const winner=results.findIndex(r=>r.body.status==='ALLOW');
      const replay=await workforceRequest(listeners[1-winner].baseUrl,'/v1/actions/execute',action(`pg-${winner}`),workforceKeys['buyer-agent']);
      expect(replay.body).toEqual(results[winner].body);expect(calls).toBe(1);
      expect(Number((await primary.store.prepare('SELECT COUNT(*) n FROM workforce_usage').get()).n)).toBe(1);
    } finally {await Promise.all(listeners.map(api=>api.close()));await primary.close();await replica.close();}
  });
});

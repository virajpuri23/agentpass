import { beforeEach, afterEach, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../src/app.js';
import type { SupplierService } from '../src/supplier.js';
const keys={'owner-1':'workflow-owner','buyer-agent':'workflow-buyer','sourcing-agent':'workflow-lead','supplier-agent':'workflow-seller'};
let db:ReturnType<typeof openDatabase>,server:Server,url:string;
const expires_at=new Date(Date.now()+3600000).toISOString();
const scope={actions:['supplier.quote.request','supplier.purchase.execute'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:500,total_budget_cents:1000,expires_at,max_delegation_depth:1};
const quote={quote_id:'workflow-quote',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:2,unit_price_cents:170,total_cents:340,currency:'USD' as const,expires_at};
const supplier:SupplierService={policy:async()=>true,quote:async()=>quote,getQuote:async()=>quote,fulfill:async()=>({order_id:'workflow-simulated-order'})};
async function call(path:string,body?:unknown,key:string=keys['buyer-agent']){const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {http:response.status,...await response.json()};}
beforeEach(async()=>{db=openDatabase(':memory:');seedDatabase(db,keys);server=createServer(createAuthorityApp({db,supplier}));server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));url=`http://127.0.0.1:${(server.address() as any).port}`;});
afterEach(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();});
async function workflow(){
 const lead=(await call('/v1/grants/grant-root-buyer/delegate',{recipient_principal_id:'sourcing-agent',scope})).data;
 const secret=randomBytes(32).toString('base64url');
 const child=(await call(`/v1/grants/${lead.id}/provision-child`,{scope:{...scope,actions:['supplier.quote.request'],max_per_action_cents:0,total_budget_cents:0,max_delegation_depth:0},credential_hash:createHash('sha256').update(secret).digest('hex'),idempotency_key:'workflow-child'},keys['sourcing-agent'])).data;
 const request=(await call('/v1/authority/requests',{parent_grant_id:lead.id,requested_scope:{...scope,max_delegation_depth:0,total_budget_cents:600},reason:'private workflow negotiation'},secret)).data;
 await call(`/v1/authority/requests/${request.request_id}/respond`,{decision:'COUNTEROFFER',offered_scope:{...scope,max_delegation_depth:0,max_per_action_cents:400,total_budget_cents:500}},keys['sourcing-agent']);
 const purchaseGrant=(await call(`/v1/authority/requests/${request.request_id}/accept`,{idempotency_key:'accept'},secret)).data;
 const purchase={grant_id:purchaseGrant.id,action:'supplier.purchase.execute',supplier_id:'supplier-co',sku_id:'PACK-500',quote_id:quote.quote_id,idempotency_key:'workflow-purchase'};
 const receipt=await call('/v1/actions/execute',purchase,secret);expect(receipt.data).toMatchObject({amount_cents:340,simulated:true});
 expect((await call('/v1/actions/execute',{...purchase,idempotency_key:'over'},secret)).code).toBe('BUDGET_EXCEEDED');
 return {lead,child,purchaseGrant,secret};
}
it('shows persisted descendants, child denials, negotiation, receipt and shared spending to the lead',async()=>{
 const w=await workflow();
 const state=await call(`/v1/workflows/${w.lead.id}`,undefined,keys['sourcing-agent']);expect(state.http).toBe(200);
 expect(state.data.grants.map((g:any)=>g.id).sort()).toEqual([w.lead.id,w.child.grant.id,w.purchaseGrant.id].sort());
 expect(state.data.budgets.find((b:any)=>b.grant_id===w.lead.id)).toMatchObject({remaining_budget_cents:660,committed_cents:340,reserved_cents:0});
 expect(state.data.budgets.find((b:any)=>b.grant_id===w.purchaseGrant.id)).toMatchObject({remaining_budget_cents:160,committed_cents:340});
 expect(state.data.activity.some((e:any)=>e.principal_id===w.child.principal.id&&e.reason_code==='BUDGET_EXCEEDED')).toBe(true);
 expect(state.data.requests[0]).toMatchObject({status:'ACCEPTED',offered_scope:{total_budget_cents:500}});expect(state.data.receipts).toHaveLength(1);
 expect(JSON.stringify(state)).not.toMatch(/workflow-(owner|buyer|lead|seller)|credential_hash|key_hash/);
 await call(`/v1/grants/${w.child.grant.id}/revoke`,{reason:'complete'},keys['sourcing-agent']);
 const revoked=(await call(`/v1/workflows/${w.lead.id}`,undefined,keys['sourcing-agent'])).data;
 expect(revoked.budgets.find((b:any)=>b.grant_id===w.child.grant.id)).toMatchObject({remaining_budget_cents:null,authority_code:'GRANT_REVOKED'});
 expect(revoked.budgets.find((b:any)=>b.grant_id===w.purchaseGrant.id).committed_cents).toBe(340);
});
it('denies guessed parent/sibling and cross-organization workflows and preserves parties-only negotiations',async()=>{
 const w=await workflow();
 const missing=await call('/v1/workflows/unknown',undefined,keys['supplier-agent']);
 for(const token of [keys['supplier-agent'],w.secret]){const response=await call(`/v1/workflows/${w.lead.id}`,undefined,token);expect(response.http).toBe(404);expect(response.code).toBe(missing.code);expect(response.reason).toBe(missing.reason);}
 const buyer=(await call(`/v1/workflows/${w.lead.id}`)).data;expect(buyer.requests).toEqual([]);expect(JSON.stringify(buyer)).not.toContain('private workflow negotiation');
 const own=(await call(`/v1/workflows/${w.child.grant.id}`,undefined,w.secret)).data;expect(own.grants).toHaveLength(1);expect(own.receipts).toEqual([]);
 const sibling=(await call('/v1/grants/grant-root-buyer/delegate',{recipient_principal_id:'sourcing-agent',scope:{...scope,max_delegation_depth:0}})).data;
 const restricted=(await call(`/v1/workflows/${w.lead.id}`,undefined,keys['sourcing-agent'])).data;expect(restricted.grants.some((g:any)=>g.id===sibling.id)).toBe(false);
});

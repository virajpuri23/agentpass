/** Repeatable hosted integration check. Consumes $5.10 of simulated root budget; never resets data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { postgresStore } from '../../db/postgres.js';
import type { ApiResult, AuthorityScope, Grant, PurchaseReceipt, SupplierQuote } from '../../packages/contracts/src/index.js';

const url = 'https://fast-steel-94x84.run.mcp-use.com/mcp';
const run = `verify-${randomUUID()}`;
const clients: Client[] = [];
const secrets = ['BUYER_API_KEY','SOURCING_API_KEY','SUPPLIER_API_KEY','DATABASE_URL'].map(name => {
  const value = process.env[name];
  assert(value, `${name} is required in the private environment`);
  return value;
});
const database = new URL(process.env.DATABASE_URL!);
assert(database.username.endsWith('.ebkcaqaybuklllefvuyv'), 'Use the dedicated AgentPass demo database');
const pg = postgresStore(process.env.DATABASE_URL!);
let stage = 'preflight';
let buyer: Client | undefined;
let parent: Grant | undefined;
const report: Record<string, unknown> = { run, url, simulated: true };

async function connect(key: string) {
  const client = new Client({name:'agentpass-hosted-verification',version:'1.0.0'});
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {headers:{authorization:`Bearer ${key}`},redirect:'error'},
  }));
  return client;
}
async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  stage = `${name}:${args.action ?? args.decision ?? ''}`;
  const result = await client.callTool({name,arguments:args});
  const serialized = JSON.stringify(result);
  assert(!secrets.some(secret => serialized.includes(secret)), 'Credential leaked in MCP result');
  assert(!/"(?:internal_unit_cost_cents|margin_cents|stock_quantity)"/.test(serialized), 'Supplier private field leaked');
  assert(result.structuredContent, 'MCP result requires structuredContent');
  return {result,value:result.structuredContent as unknown as ApiResult<T>};
}
async function ok<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const {value} = await call<T>(client,name,args);
  if (value.status !== 'OK') assert.fail(`${name}: ${value.code}`);
  return value.data;
}
async function denied(client: Client, name: string, args: Record<string, unknown>, code: string) {
  const {value} = await call(client,name,args);
  assert(value.status !== 'OK' && value.code === code, `Expected ${code}`);
  return value;
}

try {
  stage = 'database preflight';
  await pg.store.prepare('SELECT 1 FROM agentpass.principals LIMIT 1').get();
  const baseline = await pg.store.prepare("SELECT COALESCE(SUM(amount_cents),0)::int AS spent FROM ledger_entries WHERE grant_id='grant-root-buyer' AND state IN ('RESERVED','COMMITTED')").get();
  for (const token of [undefined,'invalid-verification-key']) {
    const response = await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'});
    assert.equal(response.status,401);
  }
  buyer = await connect(process.env.BUYER_API_KEY!);
  const sourcing = await connect(process.env.SOURCING_API_KEY!);
  const stranger = await connect(process.env.SUPPLIER_API_KEY!);
  const tools = (await buyer.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['describe_authority','get_my_grants','request_authority','get_authority_request','respond_authority_request','accept_authority_offer','delegate_authority','execute_action','revoke_authority'].sort());
  assert(tools.every(tool => tool.outputSchema));
  await ok(buyer,'describe_authority');
  const snapshot = await call<{grants:Grant[]}>(buyer,'get_my_grants');
  assert(snapshot.value.status === 'OK');
  const root = snapshot.value.data.grants.find(grant => grant.id === 'grant-root-buyer');
  assert(root, 'Seeded buyer root is required');
  const meta = snapshot.result._meta as {principal_id:string;inspector:{budgets:{grant_id:string;remaining_budget_cents:number;authority_code:string}[]}};
  assert.equal(meta.principal_id,'buyer-agent');
  const budget = meta.inspector.budgets.find(item => item.grant_id === root.id);
  assert(budget?.authority_code === 'ACTIVE' && budget.remaining_budget_cents >= 510, 'At least $5.10 of active root budget is required; do not reset or widen the root');
  const expires = new Date(Math.min(Date.now()+15*60_000, Date.parse(root.scope.expires_at))).toISOString();
  const scope = (amount:number,actions:AuthorityScope['actions']=['supplier.purchase.execute'],depth=0): AuthorityScope => ({actions,supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:amount,total_budget_cents:amount,expires_at:expires,max_delegation_depth:depth});
  parent = await ok<Grant>(buyer,'delegate_authority',{parent_grant_id:root.id,recipient_principal_id:'buyer-agent',scope:scope(510,['supplier.quote.request','supplier.purchase.execute'],1)});
  const quoteGrant = await ok<Grant>(buyer,'delegate_authority',{parent_grant_id:parent.id,recipient_principal_id:'sourcing-agent',scope:scope(0,['supplier.quote.request'])});
  const quote = (quantity:number) => ok<SupplierQuote>(sourcing,'execute_action',{grant_id:quoteGrant.id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity,idempotency_key:`${run}-quote-${randomUUID()}`});
  const firstQuote = await quote(1);
  assert.equal(firstQuote.total_cents,170);
  const purchase = (grant:string,quoteId:string,key:string) => ({grant_id:grant,quote_id:quoteId,idempotency_key:`${run}-${key}`,action:'supplier.purchase.execute',supplier_id:'supplier-co',sku_id:'PACK-500'});
  const missing = await denied(sourcing,'execute_action',purchase(quoteGrant.id,firstQuote.quote_id,'missing'),'INSUFFICIENT_SCOPE');
  assert.equal(missing.status,'AUTHORITY_REQUIRED');
  assert.equal(missing.next_action,'request_authority');
  assert.equal(missing.required_scope?.total_budget_cents,170);
  const request = await ok<{request_id:string}>(sourcing,'request_authority',{parent_grant_id:parent.id,requested_scope:scope(120000),reason:`Hosted simulated verification ${run}`});
  await denied(stranger,'get_authority_request',{request_id:request.request_id},'INVALID_CALLER');
  await denied(sourcing,'respond_authority_request',{request_id:request.request_id,decision:'COUNTEROFFER',offered_scope:scope(340)},'INVALID_CALLER');
  await denied(buyer,'respond_authority_request',{request_id:request.request_id,decision:'COUNTEROFFER',offered_scope:scope(120000)},'OUTSIDE_PARENT_SCOPE');
  await ok(buyer,'respond_authority_request',{request_id:request.request_id,decision:'COUNTEROFFER',offered_scope:scope(340)});
  const grant = await ok<Grant>(sourcing,'accept_authority_offer',{request_id:request.request_id,idempotency_key:`${run}-accept`});
  const receipt = await ok<PurchaseReceipt>(sourcing,'execute_action',purchase(grant.id,firstQuote.quote_id,'purchase'));
  assert.equal(receipt.amount_cents,170); assert.equal(receipt.simulated,true); assert.equal(receipt.outcome,'COMPLETED');
  assert.deepEqual(await ok(sourcing,'execute_action',purchase(grant.id,firstQuote.quote_id,'purchase')),receipt);
  await denied(sourcing,'execute_action',{...purchase(grant.id,firstQuote.quote_id,'margin'),action:'supplier.margin.read'},'SELLER_POLICY_DENIED');
  await denied(stranger,'execute_action',purchase(grant.id,firstQuote.quote_id,'impersonation'),'INVALID_CALLER');
  const sibling = await ok<Grant>(buyer,'delegate_authority',{parent_grant_id:parent.id,recipient_principal_id:'sourcing-agent',scope:scope(340)});
  const otherSibling = await ok<Grant>(buyer,'delegate_authority',{parent_grant_id:parent.id,recipient_principal_id:'sourcing-agent',scope:scope(340)});
  const [q1,q2] = await Promise.all([quote(2),quote(2)]);
  assert.equal(q1.total_cents,340); assert.equal(q2.total_cents,340);
  const race = await Promise.all([call<PurchaseReceipt>(sourcing,'execute_action',purchase(sibling.id,q1.quote_id,'race-a')),call<PurchaseReceipt>(sourcing,'execute_action',purchase(otherSibling.id,q2.quote_id,'race-b'))]);
  assert.equal(race.filter(item => item.value.status === 'OK').length,1);
  assert.equal(race.filter(item => item.value.status === 'DENIED' && item.value.code === 'BUDGET_EXCEEDED').length,1);
  await ok(buyer,'revoke_authority',{grant_id:grant.id,reason:`Verification complete ${run}`});
  await denied(sourcing,'execute_action',purchase(grant.id,firstQuote.quote_id,'revoked'),'GRANT_REVOKED');
  const expiry = new Date(Date.now()+2500).toISOString();
  const expired = await ok<Grant>(buyer,'delegate_authority',{parent_grant_id:parent.id,recipient_principal_id:'sourcing-agent',scope:{...scope(0,['supplier.quote.request']),expires_at:expiry}});
  await delay(Math.max(0,Date.parse(expiry)-Date.now()+100));
  await denied(sourcing,'execute_action',{grant_id:expired.id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:1,idempotency_key:`${run}-expired`},'GRANT_EXPIRED');
  stage = 'persisted outcome verification';
  const persisted = await pg.store.prepare("SELECT p.id,p.amount_cents,p.receipt_json,o.id AS order_id,COUNT(l.id)::int AS debits FROM purchases p JOIN supplier.orders o ON o.request_id=p.id AND o.id=p.supplier_order_id AND o.quote_id=p.quote_id JOIN ledger_entries l ON l.purchase_id=p.id AND l.state='COMMITTED' WHERE p.idempotency_key LIKE ? AND p.status='COMPLETED' GROUP BY p.id,o.id").all(`${run}-%`);
  assert.equal(persisted.length,2);
  assert.equal(persisted.reduce((total,row) => total+row.amount_cents,0),510);
  assert(persisted.every(row => row.debits === 3));
  assert.deepEqual(JSON.parse(persisted.find(row => row.id === receipt.request_id)!.receipt_json),receipt);
  const pending = await pg.store.prepare("SELECT COUNT(*)::int AS n FROM purchases WHERE idempotency_key LIKE ? AND status!='COMPLETED'").get(`${run}-%`);
  assert.equal(pending.n,0);
  const rootSpend = await pg.store.prepare("SELECT COALESCE(SUM(amount_cents),0)::int AS spent FROM ledger_entries WHERE grant_id=? AND state IN ('RESERVED','COMMITTED')").get(root.id);
  assert.equal(rootSpend.spent-baseline.spent,510,'Unexpected concurrent demo spending; inspect before rerunning');
  const events = await pg.store.prepare('SELECT action,decision,reason_code FROM audit_events WHERE grant_id IN (SELECT id FROM grants WHERE parent_grant_id=?) OR grant_id=?').all(parent.id,parent.id);
  for (const decision of ['PENDING','COUNTEROFFER','RESERVED','COMPLETED','REVOKED']) assert(events.some(event => event.decision===decision),`Missing audit decision ${decision}`);
  for (const code of ['INVALID_CALLER','INSUFFICIENT_SCOPE','OUTSIDE_PARENT_SCOPE','SELLER_POLICY_DENIED','BUDGET_EXCEEDED','GRANT_REVOKED','GRANT_EXPIRED']) assert(events.some(event => event.reason_code===code),`Missing audit denial ${code}`);
  Object.assign(report,{status:'PASSED',request_id:request.request_id,parent_grant_id:parent.id,receipt_ids:persisted.map(row=>JSON.parse(row.receipt_json).receipt_id),orders:2,committed_ancestor_debits:6,spent_cents:510,root_remaining_cents:root.scope.total_budget_cents-rootSpend.spent});
} catch (error) {
  Object.assign(report,{status:'FAILED',stage,reason:error instanceof assert.AssertionError ? error.message : 'Transport or database operation failed'});
  process.exitCode=1;
} finally {
  if (buyer && parent) {
    try { await ok(buyer,'revoke_authority',{grant_id:parent.id,reason:`Verification cleanup ${run}`}); report.cleanup='REVOKED'; }
    catch { report.status='FAILED'; report.cleanup='FAILED'; process.exitCode=1; }
  }
  await Promise.allSettled(clients.map(client=>client.close()));
  await pg.close();
  console.log(JSON.stringify(report,null,2));
}

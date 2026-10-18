import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initial,advance,probe,ROOT,OFFER,PRICE} from '../dist/scenario.mjs';
const complete=()=>Array.from({length:5}).reduce(s=>advance(s),initial());
test('negotiation authorizes a bounded simulated purchase with one ancestor debit',()=>{
 let s=initial();s=advance(s);assert.equal(s.result.status,'AUTHORITY_REQUIRED');assert.equal(s.spent,0);
 s=advance(s);assert.equal(s.result.data.requested_scope.total_budget_cents,120000);assert.equal(s.childBudget,0);
 s=advance(s);assert.equal(s.result.data.offered_scope.total_budget_cents,OFFER);assert.ok(OFFER<=ROOT);
 s=advance(s);assert.equal(s.childBudget,OFFER);assert.equal(s.spent,0);
 s=advance(s);assert.equal(s.spent,PRICE);assert.equal(s.ledger.length,1);assert.equal(s.receipt.simulated,true);
 const replay=probe(s,'replay');assert.deepEqual(replay.receipt,s.receipt);assert.equal(replay.spent,PRICE);assert.equal(replay.ledger.length,1);
});
test('overspend, changed replays, and revoked replays do not change balances',()=>{
 const s=complete();
 for(const [kind,code] of [['overspend','BUDGET_EXCEEDED'],['changed-replay','ALREADY_EXECUTED'],['revoke','GRANT_REVOKED']]){
  const denied=probe(s,kind);assert.equal(denied.result.code,code);assert.equal(denied.spent,PRICE);assert.equal(denied.ledger.length,1);
 }
 const revoked=probe(s,'revoke');assert.equal(probe(revoked,'replay').result.code,'GRANT_REVOKED');
 assert.equal(s.revoked,false);
});

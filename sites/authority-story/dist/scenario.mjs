// Illustrative browser state only. Real authorization belongs to AgentPass's server.
export const ROOT=100000, OFFER=90000, PRICE=85000;
const expiry=new Date(Date.now()+10*60*1000).toISOString();
const scope=amount=>({actions:['supplier.purchase.execute'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:amount,total_budget_cents:amount,max_delegation_depth:0,expires_at:expiry});
export function initial(){return {phase:0,spent:0,childBudget:0,revoked:false,receipt:null,ledger:[],events:[{title:'Quote received',detail:'Supplier offers 500 units for $850.',status:'OK'}],result:{status:'OK',data:{quote_id:'quote-850',total_cents:PRICE,currency:'USD',simulated:true}}};}
function event(s,title,detail,result){s.events.push({title,detail,status:result.status});s.result=result;return s;}
function purchase(s,amount,key){
  if(s.revoked)return event(s,'Access stopped','The revoked ancestor chain blocks this attempt.',{status:'DENIED',code:'GRANT_REVOKED',reason:'The purchase grant has been revoked'});
  if(!s.childBudget)return event(s,'Purchase blocked','Quote-only access cannot authorize a purchase.',{status:'AUTHORITY_REQUIRED',code:'INSUFFICIENT_SCOPE',reason:'Current grant allows quotes only',next_action:'request_authority',required_scope:scope(PRICE)});
  const previous=s.ledger.find(entry=>entry.key===key);
  if(previous){if(previous.amount!==amount)return event(s,'Replay rejected','The same key cannot identify a changed purchase.',{status:'DENIED',code:'ALREADY_EXECUTED',reason:'Idempotency key is bound to different input'});return event(s,'Same receipt, one debit','The original purchase key returns the existing receipt.',{status:'OK',data:{...s.receipt}});}
  if(amount>ROOT-s.spent||amount>s.childBudget-s.spent)return event(s,'Overspend blocked','A new $200 quote exceeds the remaining child and parent budgets.',{status:'DENIED',code:'BUDGET_EXCEEDED',reason:'Insufficient remaining authority; ledger unchanged'});
  s.spent+=amount;s.ledger.push({key,amount});s.receipt={receipt_id:'illustrative-receipt-001',order_id:'illustrative-order-001',amount_cents:amount,currency:'USD',simulated:true};
  return event(s,'Simulated purchase completed','$850 charged once to the shared ancestor budget.',{status:'OK',data:{...s.receipt}});
}
export function advance(state){
  const s=structuredClone(state);
  switch(s.phase){
    case 0:purchase(s,PRICE,'purchase-001');break;
    case 1:event(s,'Child requests $1,200','The request does not create permission or reset budget.',{status:'OK',data:{request_id:'illustrative-request-001',status:'PENDING',requested_scope:scope(120000)}});break;
    case 2:event(s,'Parent counteroffers $900','The offer stays within the parent’s $1,000 authority.',{status:'OK',data:{status:'COUNTEROFFERED',offered_scope:scope(OFFER)}});break;
    case 3:s.childBudget=OFFER;event(s,'Child accepts bounded authority','Supplier + SKU restricted; purchase cap $900; temporary expiry.',{status:'OK',data:{grant_id:'illustrative-child-purchase',scope:scope(OFFER)}});break;
    case 4:purchase(s,PRICE,'purchase-001');break;
    default:return s;
  }
  s.phase++;return s;
}
export function probe(state,kind){
  const s=structuredClone(state);
  if(s.phase<5)return s;
  if(kind==='replay')return purchase(s,PRICE,'purchase-001');
  if(kind==='changed-replay')return purchase(s,20000,'purchase-001');
  if(kind==='overspend')return purchase(s,20000,'purchase-002');
  if(kind==='revoke'){
    s.revoked=true;s.phase=6;
    event(s,'Grant revoked','The issuer removes future purchase authority.',{status:'OK',data:{revoked:true}});
    return purchase(s,PRICE,'purchase-after-revocation');
  }
  return s;
}

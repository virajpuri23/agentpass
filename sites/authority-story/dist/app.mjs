import {initial,advance,probe,ROOT} from './scenario.mjs';
const $=id=>document.getElementById(id);
const dollars=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(cents/100);
let state=initial();
const actions=['Attempt purchase →','Request $1,200 →','See parent counteroffer →','Accept $900 grant →','Execute $850 purchase →'];
function render(){
 $('root-balance').textContent=dollars(ROOT-state.spent);
 $('child-balance').textContent=dollars(Math.max(0,state.childBudget-state.spent));
 $('spent').textContent=dollars(state.spent);
 $('debits').textContent=`${state.ledger.length} ledger debit${state.ledger.length===1?'':'s'}`;
 $('child-note').textContent=state.revoked?'revoked; cannot spend':state.childBudget?'from the $900 child grant':'quote-only authority';
 $('grant-label').textContent=state.revoked?'Authority revoked':state.childBudget?'Purchase cap $900':'Quote access only';
 $('child-node').className=state.revoked?'revoked':state.childBudget?'granted':'';
 $('budget-fill').style.width=`${(ROOT-state.spent)/ROOT*100}%`;
 const last=state.events.at(-1);
 $('event-title').textContent=last.title;$('event-detail').textContent=last.detail;
 $('step-counter').textContent=state.revoked?'REVOKED':`${String(Math.min(state.phase+1,6)).padStart(2,'0')} / 06`;
 $('response-status').textContent=state.result.status;$('response-json').textContent=JSON.stringify(state.result,null,2);
 $('advance').hidden=state.phase>=5;$('advance').textContent=actions[state.phase]??'Complete';
 $('probes').hidden=state.phase<5;$('revoke').disabled=state.revoked;
 $('event-log').replaceChildren(...state.events.map((event,index)=>{const li=document.createElement('li'),n=document.createElement('span');n.textContent=String(index+1).padStart(2,'0');li.append(n,document.createTextNode(event.title));return li;}));
 const current=document.querySelector('.current-event');current.classList.remove('changed');void current.offsetWidth;current.classList.add('changed');
}
$('advance').addEventListener('click',()=>{state=advance(state);render();});
$('reset').addEventListener('click',()=>{state=initial();render();});
for(const kind of ['replay','overspend','revoke'])$(kind).addEventListener('click',()=>{state=probe(state,kind);render();});
render();

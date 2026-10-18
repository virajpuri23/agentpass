const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
let snapshot, selectedId, config, runs=[], selectedRun=new URLSearchParams(location.hash.slice(1)).get('run')||'', workflowChoices=[], selectedWorkflow=new URLSearchParams(location.hash.slice(1)).get('workflow')||'', deniedOnly=true;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => cents == null ? 'Unavailable' : new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
const date = value => new Date(value).toLocaleString();
const pretty = value => escape(JSON.stringify(value,null,2));
let noticeTimer;
const message = text => {clearTimeout(noticeTimer);notice.textContent=text;noticeTimer=setTimeout(()=>{notice.textContent='';},8000);};
async function api(path,body) {
  const response = await fetch('/console-api/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'content-type':'application/json',...(selectedRun?{'x-agentpass-run-id':selectedRun}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result = await response.json();
  if (!response.ok || result.status && result.status!=='OK') {
    const error = new Error(`${result.code ?? 'SERVICE_UNAVAILABLE'}: ${result.reason ?? 'Service unavailable'}`);
    error.code=result.code; throw error;
  }
  return result;
}
function setupMarkup() {
  return `<section class="setup"><span class="eyebrow">Connect an MCP client</span><h2>Use your own agent identity</h2><p class="muted">Endpoint</p><pre>${escape(config.mcp_url)}</pre><label>Client<select id="client"><option value="inspector">mcp-use Inspector</option><option value="cli">mcp-use CLI</option><option value="vscode">VS Code (input-capable sessions)</option></select></label><div id="client-instructions"></div><p class="muted"><small>Keep each principal’s credential in private client settings. Never paste it into a model prompt. OAuth-only clients and Manufact public chat are unverified.</small></p></section>`;
}
function showClientInstructions() {
  const selected = document.querySelector('#client')?.value;
  const endpoint = config.mcp_url;
  const instructions = document.querySelector('#client-instructions');
  if (!instructions) return;
  if (selected==='cli') instructions.innerHTML=`<p>Set <code>AGENTPASS_KEY</code> privately in your shell, then connect. The CLI stores headers in its private user configuration.</p><pre>${escape('npx mcp-use@2.8.2 client connect agentpass '+endpoint+' --no-oauth -H "Authorization: Bearer $AGENTPASS_KEY"\nnpx mcp-use@2.8.2 client agentpass tools call get_my_grants')}</pre><a href="https://github.com/mcp-use/mcp-use/blob/main/docs/typescript/tooling/client-cli.mdx" target="_blank" rel="noreferrer">Official CLI documentation ↗</a>`;
  else if (selected==='vscode') instructions.innerHTML=`<p>Add this to your private VS Code <code>mcp.json</code>. Start AgentPass and supply your credential in the masked input. Input variables are not forwarded to Copilot harness sessions; use an input-capable session.</p><pre>${pretty({servers:{agentpass:{type:'http',url:endpoint,headers:{Authorization:'Bearer ${input:agentpass-key}'}}},inputs:[{id:'agentpass-key',type:'promptString',description:'Your AgentPass credential',password:true}]})}</pre><a href="https://code.visualstudio.com/docs/agents/reference/mcp-configuration" target="_blank" rel="noreferrer">Official configuration reference ↗</a>`;
  else instructions.innerHTML=`<ol><li>Open your local mcp-use Inspector.</li><li>Add the endpoint above using HTTP transport.</li><li>In Connection Settings, add the custom header <code>Authorization</code> with <code>Bearer &lt;your credential&gt;</code>.</li><li>Save, open Tools, and call <code>get_my_grants</code>. Confirm the expected principal in the Authority Inspector.</li></ol><p class="muted">An unauthenticated initial connection is expected to fail. No one-click compatibility is claimed.</p>`;
}
function connectPage(result) {
  app.innerHTML=`<div class="connect"><section><span class="eyebrow">Scoped authority for agents</span><h1>Give agents room.<br>Keep the boundaries.</h1><p class="intro muted">Connect with your assigned identity. See exactly what your agents can do, who delegated it, and what needs your decision.</p><ol class="steps"><li>Verify your identity and grants</li><li>Connect your MCP client</li><li>Inspect authority before taking action</li></ol><p class="muted"><small>Orders and payments are simulated. Connecting never runs a purchase.</small></p></section><section class="connection-form"><span class="eyebrow">01 / Verify connection</span><h2>Connect as your principal</h2><p class="muted">Use an existing credential supplied by your organization. This page never selects an owner or buyer key for you.</p><form id="login"><label>Your agent credential<input id="credential" name="credential" type="password" autocomplete="off" spellcheck="false" required maxlength="1024"></label><button>Verify identity & grants →</button><p id="login-error" role="alert"></p></form><div id="connection-result">${result ? `<div class="success"><strong>Authenticated connection verified</strong><p>${escape(result.principal_id)} · ${escape(result.organization_id)} · ${escape(result.role)}</p><p>${result.grants.length ? `${result.grants.length} held grant(s) read successfully.` : 'Authenticated with no grants. Ask your parent or owner for authority.'}</p><a href="/console${selectedWorkflow?'#workflow='+encodeURIComponent(selectedWorkflow):''}">Open authority console →</a></div>`:''}</div>${setupMarkup()}<p class="muted"><small>Human OAuth sign-in: not configured. Provider setup and verified identity mapping are required.</small></p></section></div>`;
  showClientInstructions();
  document.querySelector('#client').onchange=showClientInstructions;
  document.querySelector('#login').onsubmit=async event => {
    event.preventDefault();
    const input=document.querySelector('#credential');const credential=input.value;input.value='';
    const button=event.target.querySelector('button');button.disabled=true;
    document.querySelector('#login-error').textContent='Verifying authenticated read…';
    try {const result=await api('session',{credential});if(location.pathname==='/console')await refresh();else connectPage(result.data);}
    catch(error){document.querySelector('#login-error').textContent=error.message;document.querySelector('#login-error').className='error';}
    finally{button.disabled=false;}
  };
}
const principalLabel = id => id.startsWith('agent-')?'Agent …'+id.slice(-8):id;
const grantState = grant => snapshot.budgets.find(b=>b.grant_id===grant.id);
function graphNode(grant,seen=new Set()) {
  if (seen.has(grant.id)) return '';
  const next=new Set(seen);next.add(grant.id);
  const children=snapshot.grants.filter(g=>g.parent_grant_id===grant.id);
  return `<button class="grant-node ${grant.id===selectedId?'selected':''}" data-grant="${escape(grant.id)}" aria-pressed="${grant.id===selectedId}"><span class="eyebrow">${grant.parent_grant_id?'Delegated grant':'Root allocation'}</span><h3 title="${escape(grant.subject_principal_id)}">${escape(principalLabel(grant.subject_principal_id))}</h3><span class="badge">${escape(grantState(grant)?.authority_code ?? 'UNAVAILABLE')}</span><small>${money(grant.scope.total_budget_cents)} total · ${grant.scope.actions.length} actions · depth ${grant.scope.max_delegation_depth}${selectedWorkflow?' · '+money(grantState(grant)?.committed_cents)+' spent':''}</small><span class="grant-id">${escape(grant.id)}</span></button>${children.length?`<div class="branch">${children.map(child=>`<div class="connector">delegated by ${escape(child.issuer_principal_id)}</div>${graphNode(child,next)}`).join('')}</div>`:''}`;
}
function scopeDetails(scope) {
  return `<dl><dt>Permitted actions</dt><dd>${scope.actions.map(escape).join('<br>')||'None'}</dd><dt>Resources</dt><dd>Suppliers: ${scope.supplier_ids.map(escape).join(', ')||'None'}<br>SKUs: ${scope.sku_ids.map(escape).join(', ')||'None'}</dd><dt>Limits</dt><dd>${money(scope.max_per_action_cents)} per action<br>${money(scope.total_budget_cents)} aggregate<br>${scope.max_delegation_depth} further delegation levels</dd><dt>Expires</dt><dd>${escape(date(scope.expires_at))}</dd></dl>`;
}
function grantDetails() {
  const grant=snapshot.grants.find(g=>g.id===selectedId);
  if(!grant)return '<p class="empty">Select a visible grant to inspect its scope.</p>';
  const budget=grantState(grant),remaining=budget?.remaining_budget_cents;
  const revoke=(snapshot.principal.role==='OWNER'||grant.issuer_principal_id===snapshot.principal.id)&&!grant.revoked_at;
  return `<span class="eyebrow">02 / Grant detail</span><h2>${escape(grant.subject_principal_id)}</h2><p class="grant-id">${escape(grant.id)}</p><span class="eyebrow">Effective remaining budget</span><div class="money">${money(remaining)}</div><p class="muted"><small>Includes ancestor limits and reserved spending.</small></p><meter class="budget" min="0" max="${Math.max(1,grant.scope.total_budget_cents)}" value="${remaining??0}">Remaining ${money(remaining)}</meter>${selectedWorkflow?`<dl><dt>Committed simulated spend</dt><dd>${money(budget?.committed_cents)}</dd><dt>Reserved</dt><dd>${money(budget?.reserved_cents)}</dd></dl><p class="muted"><small>Revoked or expired grants cannot spend unused allocation. The same purchase appears on each ancestor ledger.</small></p>`:''}${scopeDetails(grant.scope)}<dl><dt>Issuer → subject</dt><dd>${escape(grant.issuer_principal_id)} → ${escape(grant.subject_principal_id)}</dd><dt>Parent grant</dt><dd>${grant.parent_grant_id ? snapshot.grants.some(g=>g.id===grant.parent_grant_id)?`<button class="secondary" data-grant="${escape(grant.parent_grant_id)}">Inspect parent</button>`:`${escape(grant.parent_grant_id)} (outside visible grants)` : 'Root allocation'}</dd><dt>Revocation</dt><dd>${grant.revoked_at?escape(date(grant.revoked_at)):'No direct revocation'} · ${escape(budget?.authority_code)}</dd></dl>${revoke?'<button class="secondary" id="revoke">Review revocation…</button>':''}`;
}
function requestMarkup(request) {
  const isChild=request.requester_principal_id===snapshot.principal.id;
  const parent=snapshot.grants.find(g=>g.id===request.parent_grant_id);
  const canRespond=parent?.subject_principal_id===snapshot.principal.id&&request.status==='PENDING'&&!isChild;
  const canAccept=isChild&&request.status==='COUNTEROFFERED';
  return `<article class="request"><div class="welcome"><strong>${escape(request.requester_principal_id)}</strong><span class="badge">${escape(request.status)}</span></div><p>${escape(request.reason)}</p><p class="grant-id">${escape(request.id)}</p><div class="scope-compare"><div><span class="eyebrow">Requested</span>${scopeDetails(request.requested_scope)}</div><div><span class="eyebrow">Offered</span>${request.offered_scope?scopeDetails(request.offered_scope):'<p class="muted">Awaiting parent decision</p>'}</div></div>${request.issued_grant_id?`<button class="secondary" data-grant="${escape(request.issued_grant_id)}">Inspect issued grant</button>`:''}${canRespond?`<details><summary>Counteroffer a narrower scope</summary><form data-respond="${escape(request.id)}"><label>Offered scope (JSON)<textarea name="scope" required>${pretty({...request.requested_scope,max_per_action_cents:Math.min(request.requested_scope.max_per_action_cents,parent.scope.max_per_action_cents),total_budget_cents:Math.min(request.requested_scope.total_budget_cents,parent.scope.total_budget_cents),expires_at:new Date(Math.min(Date.parse(request.requested_scope.expires_at),Date.parse(parent.scope.expires_at))).toISOString(),max_delegation_depth:Math.min(request.requested_scope.max_delegation_depth,parent.scope.max_delegation_depth-1)})}</textarea></label><button>Send counteroffer</button></form></details><button class="secondary" data-reject="${escape(request.id)}">Reject request</button>`:''}${canAccept?`<p class="muted">Review the offered scope above. Acceptance issues this exact authority to your identity.</p><button data-accept="${escape(request.id)}">Accept offered scope</button>`:''}</article>`;
}
function requestForm() {
  const eligible=snapshot.grants.filter(g=>g.subject_principal_id===snapshot.principal.id&&g.parent_grant_id&&grantState(g)?.authority_code==='ACTIVE');
  if(!eligible.length)return '<p class="empty">A live delegated child grant is required to request more authority.</p>';
  const g=eligible.find(g=>g.id===selectedId)||eligible[0];
  const scope={...g.scope,actions:['supplier.purchase.execute'],max_per_action_cents:120000,total_budget_cents:120000,max_delegation_depth:0};
  return `<details><summary>Request additional authority (optional)</summary><p class="muted">This creates a real permission request. It never purchases anything.</p><form id="request-form"><label>Existing delegated grant<select name="grant">${eligible.map(x=>`<option value="${escape(x.id)}" ${x.id===g.id?'selected':''}>${escape(x.id)}</option>`).join('')}</select></label><label>Requested scope (JSON)<textarea name="scope" required>${pretty(scope)}</textarea></label><label>Reason<input name="reason" required maxlength="2000" placeholder="Why does your agent need this scope?"></label><button>Send permission request</button></form></details>`;
}
function workflowToolbar() {
  const choices=workflowChoices.filter(g=>g.scope.max_delegation_depth>0||g.id===selectedWorkflow);
  const root=snapshot.budgets.find(b=>b.grant_id===selectedWorkflow);
  return `<section class="workflow-picker"><label>Inspect a delegation workflow<select id="workflow-select"><option value="">All visible authority</option>${choices.map(g=>`<option value="${escape(g.id)}" ${g.id===selectedWorkflow?'selected':''}>${escape(principalLabel(g.subject_principal_id))} · ${money(g.scope.total_budget_cents)} · ${escape(g.id)}</option>`).join('')}</select></label><p class="muted">Workflow access follows a grant you hold or issued. Negotiations remain private to their parties.</p>${selectedWorkflow?`<div class="workflow-stats"><div><small>Authenticated agents</small><strong>${new Set(snapshot.grants.map(g=>g.subject_principal_id)).size}</strong></div><div><small>Completed simulated spend</small><strong>${money(snapshot.receipts.reduce((sum,r)=>sum+r.amount_cents,0))}</strong></div><div><small>Lead available authority</small><strong>${money(root?.remaining_budget_cents)}</strong></div><div><small>Denied actions recorded</small><strong>${(selectedRun?[...snapshot.activity].reverse():snapshot.activity).filter(e=>e.decision==='DENY').length}</strong></div></div><details><summary>Demo this workflow through Codex</summary><p>Ask Codex: “Show this AgentPass workflow and explain its delegation, budgets, and denials.”</p><pre>get_workflow {"root_grant_id":"${escape(selectedWorkflow)}"}</pre><p class="muted">Read-only. Refreshing never launches agents or executes a purchase.</p></details>`:''}</section>`;
}
function consolePage() {
  const {principal,grants,visibility}=snapshot;
  selectedId=grants.some(g=>g.id===selectedId)?selectedId:grants[0]?.id;
  const runToolbar=`<section class="run-picker"><label for="run-select">Inspect a run</label><select id="run-select"><option value="">All visible activity</option>${runs.map(r=>`<option value="${escape(r.run_id)}" ${selectedRun===r.run_id?'selected':''}>${escape(date(r.started_at))} · ${escape(r.run_id)} · ${escape(r.event_count)} events</option>`).join('')}</select><p class="muted"><small>${selectedRun?'Showing persisted events for this run. Grants, budgets and request states are current snapshots.':'Choose a recorded run to follow its grant chain and decisions. Untagged historical activity is available in the all-activity view.'} Run IDs group evidence; they never grant access.</small></p>${selectedRun?`<p><strong>${snapshot.activity.length} recorded events · ${snapshot.receipts.length} completed simulated purchase(s) · ${money(snapshot.receipts.reduce((sum,r)=>sum+r.amount_cents,0))} spent</strong></p><pre>MCP: get_run {"run_id":"${escape(selectedRun)}"}
CLI: npm run agent:runs -- --url ${escape(config.mcp_url)} --run ${escape(selectedRun)}</pre>`:''}</section>`;
  const roots=grants.filter(g=>!grants.some(p=>p.id===g.parent_grant_id));
  app.innerHTML=`<section class="welcome"><div><span class="eyebrow">Authority workspace</span><h1>${selectedWorkflow?'Delegation workflow':'Authority console'}</h1><p class="muted">Inspect delegated scope. Review requests. Keep authority in view.</p></div><div class="actions"><button class="secondary" id="refresh">Refresh snapshot ↻</button><button class="secondary" id="logout">Disconnect</button></div></section><div class="identity"><strong>${escape(principal.id)}</strong><span>${escape(principal.organization_id)}</span><span class="badge">${escape(principal.kind)} · ${escape(principal.role)}</span><small>Snapshot ${escape(date(snapshot.snapshot_at))}</small></div>${selectedWorkflow?'':runToolbar}${workflowToolbar()}<div class="workspace"><section class="panel graph"><span class="eyebrow">01 / Delegation</span><h2>Authority graph <small>(${grants.length})</small></h2><p class="muted"><small>${selectedWorkflow?'This delegated branch and its persisted descendants.':visibility.descendants_complete?'Organization grants visible.':'Held and directly issued grants only. Other ancestors or descendants may exist.'}</small></p>${roots.map(g=>(g.parent_grant_id?`<div class="connector">Parent outside view: ${escape(g.parent_grant_id)}</div>`:'')+`<div class="connector">${escape(g.issuer_principal_id)} →</div>`+graphNode(g)).join('')||'<p class="empty">Authenticated with no visible grants. Contact your parent or owner.</p>'}</section><section class="panel" id="grant-detail">${grantDetails()}</section><section class="panel"><span class="eyebrow">03 / Decisions</span><h2>Permission requests</h2><p class="muted"><small>Private to requester and parent. A counteroffer requires the child’s acceptance.</small></p>${snapshot.requests.map(r=>selectedWorkflow||selectedRun?`<details><summary>${escape(r.status)} · ${money(r.requested_scope.total_budget_cents)} requested → ${money(r.offered_scope?.total_budget_cents)} offered</summary>${requestMarkup(r)}</details>`:requestMarkup(r)).join('')||'<p class="empty">No permission requests visible to your identity.</p>'}${selectedWorkflow?'':requestForm()}<section class="timeline"><span class="eyebrow">Persisted evidence</span><h2>${selectedWorkflow&&deniedOnly?'Denied actions':'Recent activity'}</h2>${selectedWorkflow?`<label class="filter"><input id="denied-only" type="checkbox" ${deniedOnly?'checked':''}> Show denied actions only</label>`:''}<p class="muted"><small>${selectedWorkflow?'Delegated workflow':visibility.activity==='organization'?'Organization':'Your own'} events · ${selectedWorkflow?'latest 500':'latest 200'}${visibility.activity_truncated?' · earlier events omitted':''}. This view is not a complete audit export.</small></p>${(selectedRun?[...snapshot.activity].reverse():snapshot.activity).filter(e=>!selectedWorkflow||!deniedOnly||e.decision==='DENY').map(event=>`<article class="event"><strong>${escape(event.action)}</strong> · ${escape(event.decision)}<time>${escape(date(event.timestamp))} · ${escape(event.principal_id)}</time><code>${escape(event.reason_code||event.grant_id||event.request_id||'')}</code></article>`).join('')||'<p class="empty">No persisted activity yet.</p>'}<h3>Completed simulated receipts</h3>${snapshot.receipts.map(receipt=>`<details><summary>${escape(receipt.receipt_id||receipt.purchase_id||receipt.grant_id)} · ${money(receipt.amount_cents)}</summary><pre>${pretty(receipt)}</pre></details>`).join('')||'<p class="empty">No completed receipts visible.</p>'}</section></section></div>`;
  bindConsole();
}
async function refresh() {
  app.classList.add('loading');message('Reading canonical authority…');
  try{const overview=(await api('snapshot')).data;workflowChoices=overview.grants;
    if(overview.root_grant_id&&!selectedWorkflow){selectedWorkflow=overview.root_grant_id;location.hash='workflow='+encodeURIComponent(selectedWorkflow);}
    if(selectedWorkflow)selectedRun='';
    if(!selectedWorkflow)runs=(await api('runs')).data.runs;
    snapshot=selectedWorkflow?(await api('workflows/'+encodeURIComponent(selectedWorkflow))).data:selectedRun?(await api('runs/'+encodeURIComponent(selectedRun))).data:overview;
    selectedId=selectedId??snapshot.root_grant_id;consolePage();message('Snapshot refreshed.');}
  catch(error){if(error.code==='MISSING_CREDENTIAL'||error.code==='INVALID_CALLER'){connectPage();}message(error.message);}
  finally{app.classList.remove('loading');}
}
async function mutate(path,body) {
  app.classList.add('loading');
  try{await api('v1/'+path,body);await refresh();message('Saved. Canonical state refreshed.');}
  catch(error){message(error.message);}
  finally{app.classList.remove('loading');}
}
function bindConsole() {
  const runSelect=document.querySelector('#run-select');if(runSelect)runSelect.onchange=event=>{selectedRun=event.target.value;selectedId=undefined;location.hash=selectedRun?'run='+encodeURIComponent(selectedRun):'';void refresh();};
  document.querySelector('#workflow-select').onchange=event=>{selectedWorkflow=event.target.value;selectedRun='';selectedId=undefined;location.hash=selectedWorkflow?'workflow='+encodeURIComponent(selectedWorkflow):'';void refresh();};
  const filter=document.querySelector('#denied-only');if(filter)filter.onchange=()=>{deniedOnly=filter.checked;consolePage();};
  document.querySelector('#refresh').onclick=refresh;
  document.querySelector('#logout').onclick=async()=>{try{await api('logout',{});snapshot=undefined;connectPage();message('Disconnected. Server session cleared.');}catch(error){message(error.message);}};
  document.querySelectorAll('[data-grant]').forEach(button=>button.onclick=()=>{selectedId=button.dataset.grant;consolePage();});
  document.querySelectorAll('[data-respond]').forEach(form=>form.onsubmit=event=>{event.preventDefault();try{mutate(`authority/requests/${form.dataset.respond}/respond`,{decision:'COUNTEROFFER',offered_scope:JSON.parse(new FormData(form).get('scope'))});}catch{message('Offered scope must be valid JSON.');}});
  document.querySelectorAll('[data-reject]').forEach(button=>button.onclick=()=>mutate(`authority/requests/${button.dataset.reject}/respond`,{decision:'REJECT'}));
  document.querySelectorAll('[data-accept]').forEach(button=>button.onclick=()=>mutate(`authority/requests/${button.dataset.accept}/accept`,{idempotency_key:crypto.randomUUID()}));
  const form=document.querySelector('#request-form');
  if(form)form.onsubmit=event=>{event.preventDefault();const data=new FormData(form);try{const g=snapshot.grants.find(g=>g.id===data.get('grant'));mutate('authority/requests',{parent_grant_id:g.parent_grant_id,requested_scope:JSON.parse(data.get('scope')),reason:data.get('reason')});}catch{message('Requested scope must be valid JSON.');}};
  const revoke=document.querySelector('#revoke');
  if(revoke)revoke.onclick=()=>{
    const grant=snapshot.grants.find(g=>g.id===selectedId);const affected=new Set([grant.id]);
    for(let i=0;i<snapshot.grants.length;i++)for(const g of snapshot.grants)if(affected.has(g.parent_grant_id))affected.add(g.id);
    document.querySelector('#impact').innerHTML=`<p>Revoke <strong>${escape(grant.id)}</strong> and deny future operations through its descendants.</p><p>${affected.size-1} known descendant(s):</p><ul>${[...affected].slice(1).map(id=>`<li>${escape(id)}</li>`).join('')||'<li>None in this snapshot</li>'}</ul><p>${snapshot.visibility.descendants_complete?'All organization grant links are visible in this snapshot.':'Full impact is not visible. Additional descendants may lose authority.'} Existing completed simulated orders remain recorded.</p>`;
    const dialog=document.querySelector('#review');dialog.returnValue='';dialog.showModal();
    dialog.onclose=()=>{if(dialog.returnValue==='confirm')mutate(`grants/${grant.id}/revoke`,{reason:document.querySelector('#revoke-reason').value});};
  };
}
(async()=>{try{config=await api('config');if(location.pathname==='/console')await refresh();else connectPage();}catch(error){app.textContent='Connection service unavailable. Reload to retry.';message(error.message);}})();

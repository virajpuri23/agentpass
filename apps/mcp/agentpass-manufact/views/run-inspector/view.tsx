import { useEffect, useState } from "react";
import { ModelContext, useCallTool, useHostContext, useToolContext } from "mcp-use/react";
import { z } from "zod";
import { GrantCard, grantSchema, money, date } from "../authority-inspector/view.js";
import "./view.css";

const runId = z.string().regex(/^run-[a-zA-Z0-9_-]{1,80}$/);
const runListSchema = z.object({
  runs:z.array(z.object({run_id:runId,started_at:z.string(),event_count:z.union([z.number(),z.string()])})),
  truncated:z.boolean(),visibility:z.enum(["organization","caller_only"]),
});
const snapshotSchema = z.object({
  run_id:runId,principal:z.object({id:z.string(),organization_id:z.string()}),snapshot_at:z.string(),
  grants:z.array(grantSchema),budgets:z.array(z.object({grant_id:z.string(),remaining_budget_cents:z.number().nullable(),authority_code:z.string()})),
  requests:z.array(z.object({id:z.string(),status:z.string(),reason:z.string(),requested_scope:grantSchema.shape.scope,offered_scope:grantSchema.shape.scope.optional()})),
  activity:z.array(z.object({event_id:z.string(),timestamp:z.string(),principal_id:z.string(),action:z.string(),decision:z.string(),reason_code:z.string().nullable(),grant_id:z.string().nullable()})),
  receipts:z.array(z.object({receipt_id:z.string(),order_id:z.string(),supplier_id:z.string(),sku_id:z.string(),grant_id:z.string(),quantity:z.number(),amount_cents:z.number(),simulated:z.literal(true)})),
  visibility:z.object({activity:z.enum(["organization","caller_only"]),activity_truncated:z.boolean(),receipts_truncated:z.boolean()}),
});
const envelopeSchema = z.object({status:z.string(),data:z.unknown().optional(),code:z.string().optional(),reason:z.string().optional()});

export default function RunInspector() {
  const view = useToolContext<"get_run">();
  const listTool = useCallTool("list_runs");
  const runTool = useCallTool("get_run");
  const host = useHostContext();
  const [replacement,setReplacement] = useState<unknown>();
  const [availableRuns,setAvailableRuns] = useState<z.infer<typeof runListSchema>>();
  const [busy,setBusy] = useState(false);
  const hostOutput = view.status==="ready" ? view.toolOutput : undefined;
  useEffect(()=>{setReplacement(undefined);setAvailableRuns(undefined);},[hostOutput]);
  const output = envelopeSchema.safeParse(replacement ?? hostOutput).data;
  const snapshot = output?.status==="OK" ? snapshotSchema.safeParse(output.data).data : undefined;
  const currentList = output?.status==="OK" ? runListSchema.safeParse(output.data).data : undefined;
  const list = availableRuns ?? currentList;
  const canCall = !!host.hostCapabilities?.serverTools;
  async function read(id?:string) {
    setBusy(true);
    try {
      const result = id ? await runTool.callTool({run_id:id}) : await listTool.callTool({});
      const response = envelopeSchema.parse(result.structuredContent);
      const parsed = runListSchema.safeParse(response.data);
      if(parsed.success)setAvailableRuns(parsed.data);
      if(response.status!=="OK")setAvailableRuns(undefined);
      setReplacement(response);
    } catch {
      setAvailableRuns(undefined);
      setReplacement({status:"ERROR",code:"SERVICE_UNAVAILABLE",reason:"Could not refresh this authenticated view. Reconnect your MCP client and run list_runs or get_run again."});
    } finally {setBusy(false);}
  }
  const pending = busy || view.status==="pending";
  const invalid = !pending && (!output || (output.status==="OK" && !snapshot && !currentList));
  const failed = !pending && (invalid || output?.status!=="OK");
  const budgets = new Map((snapshot?.budgets ?? []).map(b=>[b.grant_id,b]));
  return <main className="inspector run-inspector" aria-label="AgentPass Run Inspector" aria-busy={pending}>
    <ModelContext content={!pending && !failed && snapshot ? `Viewing authenticated AgentPass run ${snapshot.run_id} as ${snapshot.principal.id}; read-only snapshot ${snapshot.snapshot_at}.` : "AgentPass Run Inspector has no selected readable run."}/>
    <header className="inspector-header"><div><span className="eyebrow">AgentPass</span><h1>Run Inspector</h1><p className="muted">Persisted authority evidence for your authenticated identity.</p></div><strong className="state state--read">Read only</strong></header>
    <section className="panel run-controls">
      <div className="run-actions"><button disabled={!canCall || pending} onClick={()=>void read()}>Choose a run</button>{snapshot && <button disabled={!canCall || pending} onClick={()=>void read(snapshot.run_id)}>Refresh run</button>}</div>
      {!canCall && <p className="muted">This host cannot call server tools from the view. Run list_runs or get_run in your MCP client to choose or refresh a run.</p>}
      {!pending && !failed && list && <label>Recorded runs<select aria-label="Recorded runs" value={snapshot?.run_id ?? ""} disabled={!canCall} onChange={event=>{if(event.target.value)void read(event.target.value);}}><option value="">Select a run…</option>{snapshot && !list.runs.some(r=>r.run_id===snapshot.run_id) && <option value={snapshot.run_id}>{snapshot.run_id}</option>}{list.runs.map(r=><option key={r.run_id} value={r.run_id}>{date(r.started_at)} · {r.run_id} · {r.event_count} events</option>)}</select></label>}
      {!pending && !failed && list?.runs.length===0 && <p>No recorded runs are visible to this identity.</p>}
      {!pending && !failed && list?.truncated && <p className="muted">Latest 100 visible runs shown. Earlier runs may exist.</p>}
    </section>
    {pending ? <section className="panel" role="status"><div className="skeleton skeleton--wide"/><p>Reading authenticated run evidence…</p></section>
      : failed ? <section className="panel panel--error" role="alert"><h2>Run evidence unavailable</h2><p>{output?.status!=="OK" && output?.reason ? output.reason : "The host did not return valid run evidence. Reconnect and retry the read tool."}</p>{output?.code && <p>Code: <code>{output.code}</code></p>}</section>
      : snapshot ? <>
        <section className="panel"><span className="eyebrow">Authenticated context</span><h2>{snapshot.run_id}</h2><dl><div><dt>Principal</dt><dd>{snapshot.principal.id}</dd></div><div><dt>Organization</dt><dd>{snapshot.principal.organization_id}</dd></div><div><dt>Snapshot</dt><dd>{date(snapshot.snapshot_at)}</dd></div><div><dt>Completed simulated purchases</dt><dd>{snapshot.receipts.length} · {money(snapshot.receipts.reduce((sum,r)=>sum+r.amount_cents,0))}</dd></div></dl><p className="muted">Events are historical. Grants, budgets and request states are current snapshots. Run IDs group evidence; they never grant authority.</p></section>
        <section aria-labelledby="run-grants"><h2 id="run-grants">Related grant chain</h2><p className="muted">Only grants visible to this identity are shown; other ancestors or descendants may exist.</p><div className="grant-list">{snapshot.grants.map(g=><GrantCard key={g.id} grant={g} grants={snapshot.grants} budgets={budgets}/>)}</div></section>
        <section className="panel"><h2>Scope negotiation</h2><p className="muted">Private to the requester and parent, including for organization owners.</p>{snapshot.requests.length ? snapshot.requests.map(r=><details key={r.id}><summary>{r.status} · {money(r.requested_scope.total_budget_cents)} requested → {r.offered_scope?money(r.offered_scope.total_budget_cents):"awaiting offer"}</summary><p>{r.reason}</p><dl><div><dt>Requested actions</dt><dd>{r.requested_scope.actions.join(", ")}</dd></div><div><dt>Offered actions</dt><dd>{r.offered_scope?.actions.join(", ")??"None"}</dd></div><div><dt>Offered suppliers / SKUs</dt><dd>{r.offered_scope ? `${r.offered_scope.supplier_ids.join(", ")} / ${r.offered_scope.sku_ids.join(", ")}` : "None"}</dd></div><div><dt>Offer expires</dt><dd>{date(r.offered_scope?.expires_at)}</dd></div></dl></details>):<p>No negotiations visible to your identity in this run.</p>}</section>
        <section className="panel"><h2>Chronological activity</h2><p className="muted">{snapshot.visibility.activity==="organization"?"Organization":"Your own"} events · {snapshot.activity.length} shown{snapshot.visibility.activity_truncated?" · additional events omitted":""}.</p><ol className="run-timeline">{[...snapshot.activity].reverse().map(e=><li key={e.event_id}><strong>{e.action} · {e.decision}</strong><p>{e.reason_code??e.grant_id??""}</p><small>{date(e.timestamp)} · {e.principal_id}</small></li>)}</ol></section>
        <section className="panel"><h2>Simulated receipts</h2>{snapshot.receipts.length?snapshot.receipts.map(r=><details key={r.receipt_id}><summary>{r.quantity} units · {money(r.amount_cents)} · simulated</summary><dl><div><dt>Receipt</dt><dd><code>{r.receipt_id}</code></dd></div><div><dt>Order</dt><dd><code>{r.order_id}</code></dd></div><div><dt>Supplier / SKU</dt><dd>{r.supplier_id} / {r.sku_id}</dd></div><div><dt>Grant</dt><dd><code>{r.grant_id}</code></dd></div></dl></details>):<p>No completed simulated receipts visible in this run.</p>}{snapshot.visibility.receipts_truncated && <p className="muted">Earlier receipts omitted.</p>}</section>
      </>:<section className="panel"><h2>Choose a recorded run</h2><p>Inspect its related grants, negotiation, decisions and simulated receipts. Visibility follows your authenticated MCP connection.</p></section>}
  </main>;
}

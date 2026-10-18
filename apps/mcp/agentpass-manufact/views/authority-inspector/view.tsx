import { useState } from "react";
import { useCallTool, useHostContext, useOpenExternal, useToolContext } from "mcp-use/react";
import { z } from "zod";
import "./view.css";

const grantSchema = z.object({
  id: z.string(), organization_id: z.string(), issuer_principal_id: z.string(),
  subject_principal_id: z.string(), parent_grant_id: z.string().nullable(),
  scope: z.object({
    actions: z.array(z.enum(["supplier.quote.request", "supplier.purchase.execute", "supplier.margin.read"])),
    supplier_ids: z.array(z.string()), sku_ids: z.array(z.string()),
    max_per_action_cents: z.number(), total_budget_cents: z.number(),
    expires_at: z.string(), max_delegation_depth: z.number(),
  }),
  revoked_at: z.string().nullable(),
});

const metaSchema = z.object({
  principal_id: z.string(), organization_id: z.string(), console_url: z.string().url().optional(),
  inspector: z.object({
    budgets: z.array(z.object({
      grant_id: z.string(), remaining_budget_cents: z.number().nullable(), authority_code: z.string(),
    })),
    latest_result: z.object({
      timestamp: z.string(), action: z.string(), decision: z.string(),
      reason_code: z.string().nullable(), grant_id: z.string().nullable(),
    }).nullable(),
  }),
});

type Grant = z.infer<typeof grantSchema>;
type Meta = z.infer<typeof metaSchema>;
type Output = { status?: unknown; data?: unknown; code?: unknown; reason?: unknown; next_action?: unknown };

const money = (cents: number | null | undefined) => cents == null ? "Unavailable" : `$${(cents / 100).toFixed(2)}`;
const date = (value: string | null | undefined) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : "Unavailable";
const label = (value: unknown, fallback = "Unavailable") => typeof value === "string" && value ? value : fallback;

function GrantCard({ grant, grants, budgets }: { grant: Grant; grants: Grant[]; budgets: Map<string, Meta["inspector"]["budgets"][number]> }) {
  const children = grants.filter((candidate) => candidate.parent_grant_id === grant.id).map((candidate) => candidate.id);
  const budget = budgets.get(grant.id);
  const state = budget?.authority_code === "ACTIVE" ? "Active"
    : budget?.authority_code === "GRANT_REVOKED" ? "Revoked"
      : budget?.authority_code === "GRANT_EXPIRED" ? "Expired" : "Unavailable";
  return <article className="grant" aria-labelledby={`grant-${grant.id}`}>
    <header><div><span className="eyebrow">Grant</span><h3 id={`grant-${grant.id}`}><code>{grant.id}</code></h3></div><strong className={`state state--${state.toLowerCase()}`}>{state}</strong></header>
    <p className="relationship">Parent: <code>{grant.parent_grant_id ?? "root"}</code> · Children visible: {children.length ? children.join(", ") : "none"}</p>
    <dl>
      <div><dt>Actions</dt><dd>{grant.scope.actions.join(", ") || "None"}</dd></div>
      <div><dt>Suppliers</dt><dd>{grant.scope.supplier_ids.join(", ") || "None"}</dd></div>
      <div><dt>SKUs</dt><dd>{grant.scope.sku_ids.join(", ") || "None"}</dd></div>
      <div><dt>Budget</dt><dd>{money(grant.scope.max_per_action_cents)} / action · {money(grant.scope.total_budget_cents)} total · {money(budget?.remaining_budget_cents)} left</dd></div>
      <div><dt>Expires</dt><dd>{date(grant.scope.expires_at)}</dd></div>
      <div><dt>Revocation</dt><dd>{grant.revoked_at ? `Revoked ${date(grant.revoked_at)}` : "Not revoked"}</dd></div>
    </dl>
  </article>;
}

function LatestResult({ result }: { result: Meta["inspector"]["latest_result"] }) {
  return <section className="panel" aria-labelledby="latest-title"><h2 id="latest-title">Most recent authorization result</h2>{result ? <dl>
    <div><dt>Decision</dt><dd>{result.decision}</dd></div><div><dt>Action</dt><dd><code>{result.action}</code></dd></div>
    <div><dt>Reason</dt><dd>{result.reason_code ? <code>{result.reason_code}</code> : "None"}</dd></div>
    <div><dt>Grant</dt><dd>{result.grant_id ? <code>{result.grant_id}</code> : "None"}</dd></div><div><dt>When</dt><dd>{date(result.timestamp)}</dd></div>
  </dl> : <p className="muted">No authorization result reported.</p>}</section>;
}

export default function AuthorityInspector() {
  const view = useToolContext<"get_my_grants">();
  const refresh = useCallTool("get_my_grants");
  const host = useHostContext();
  const openExternal = useOpenExternal();
  const [recoveryError,setRecoveryError] = useState("");
  const recovery = <section className="panel"><button disabled={refresh.isPending || !host.hostCapabilities?.serverTools} onClick={() => {setRecoveryError("");void refresh.callTool({}).catch(() => setRecoveryError("Refresh failed. Reconnect your MCP client and run get_my_grants."));}}>{refresh.isPending ? "Refreshing…" : "Refresh authority"}</button><p className="muted">Snapshot only. If refresh is unavailable, run get_my_grants again in your client.</p>{(recoveryError || refresh.error) && <p role="alert">{recoveryError || "Refresh failed. Reconnect and retry."}</p>}</section>;
  if (view.status === "pending" && !refresh.data) return <main className="inspector" aria-busy="true" aria-label="AgentPass Authority Inspector"><div className="skeleton" /><div className="skeleton skeleton--wide" /><div className="skeleton skeleton--card" /></main>;
  if (view.status === "error" && !refresh.data) return <main className="inspector"><header><span className="eyebrow">AgentPass</span><h1>Authority Inspector</h1></header><section className="panel panel--error" role="alert"><h2>Unable to load grants</h2><p>{view.error.message}</p></section>{recovery}</main>;

  const output = (refresh.data?.structuredContent ?? view.toolOutput) as unknown as Output;
  const meta = metaSchema.safeParse(refresh.data?._meta ?? view.meta).data;
  const status = label(output.status, "ERROR");
  const data = output.data && typeof output.data === "object" && "grants" in output.data ? (output.data as { grants?: unknown }).grants : undefined;
  const parsed = z.array(grantSchema).safeParse(data);
  const grants = parsed.success ? parsed.data : [];
  const budgets = new Map((meta?.inspector.budgets ?? []).map((budget) => [budget.grant_id, budget]));
  const invalid = status === "OK" && !parsed.success;
  const reason = label(output.reason, invalid ? "The authority response did not include a valid grant list." : "The authority service returned an error.");
  return <main className="inspector">
    <header className="inspector-header"><div><span className="eyebrow">AgentPass</span><h1>Authority Inspector</h1><p className="muted">Read-only delegated authority for the authenticated agent.</p></div><strong className="state state--read">Read only</strong></header>
    <section className="panel" aria-labelledby="identity-title"><span className="eyebrow">Authenticated context</span><h2 id="identity-title">Agent identity</h2><dl><div><dt>Principal</dt><dd><code>{meta?.principal_id ?? "Unavailable"}</code></dd></div><div><dt>Organization</dt><dd><code>{meta?.organization_id ?? "Unavailable"}</code></dd></div></dl></section>
    {status !== "OK" || invalid ? <section className="panel panel--error" role="alert"><span className="eyebrow">Authority response</span><h2>Grant list unavailable</h2><p>{reason}</p>{typeof output.code === "string" && <p>Code: <code>{output.code}</code></p>}{typeof output.next_action === "string" && <p>Next action: <code>{output.next_action}</code></p>}</section> : grants.length === 0 ? <section className="panel"><span className="eyebrow">Delegated permissions</span><h2>No grants found</h2><p className="muted">This authenticated agent has no visible authority grants.</p></section> : <section aria-labelledby="grants-title"><div className="section-title"><span className="eyebrow">Delegated permissions</span><h2 id="grants-title">Current grants ({grants.length})</h2></div><div className="grant-list">{grants.map((grant) => <GrantCard key={grant.id} grant={grant} grants={grants} budgets={budgets} />)}</div></section>}
    {recovery}
    {meta?.console_url && host.hostCapabilities?.openLinks && <section className="panel"><button onClick={() => {void openExternal({url:meta.console_url!}).catch(() => setRecoveryError("Could not open the connection page. Open it in your browser."));}}>Open connection & console</button><p className="muted">Authenticate independently in the browser with your own credential.</p></section>}
    <LatestResult result={meta?.inspector.latest_result ?? null} />
  </main>;
}

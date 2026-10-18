/**
 * Hosting agent: deploys the finished landing page.
 *
 * Its first instinct is production. AgentPass refuses that (the lead was never
 * given deploy.production) and the refusal names the permitted alternative,
 * deploy.preview. The agent reads that hint, asks the lead for exactly that
 * scope, waits for the (narrower) grant, retries with the allowed action and
 * returns the real preview URL. No step is scripted: every transition is a
 * decision on a real authority response.
 */
import type { ApiError, ApiResult, WorkforceGrant, WorkforceScope } from '../contract.js';
import type { Deployment } from '../gateways/deploy.js';
import { isError, noteDenied, type AgentContext } from '../agent-base.js';

export interface HostingResult {
  ok: boolean;
  /** What happened, in order; each entry is a real call outcome. */
  steps: { step: string; outcome: string; code?: string }[];
  production_attempt: { status: string; code?: string; alternative?: string[] };
  negotiation?: { request_id: string; requested: WorkforceScope; offered?: WorkforceScope; issued_grant_id?: string; status: string };
  deployment?: Deployment;
  failure?: ApiError;
}

export interface HostingTask {
  /** The lead's grant the agent's own grant hangs off; where it sends its request. */
  parent_grant_id: string;
  /** Called after the request is filed so the lead can answer; the orchestrator wires this to the lead's respond(). */
  notifyParent: (request_id: string) => Promise<void>;
}

export async function runHostingAgent(ctx: AgentContext, task: HostingTask): Promise<HostingResult> {
  const deploy = ctx.gateways.deploy;
  if (!deploy) throw new Error('hosting agent needs the deploy gateway');
  const steps: HostingResult['steps'] = [];
  const step = (s: string, outcome: string, code?: string) => { steps.push({ step: s, outcome, code }); ctx.trace({ agent: ctx.name, kind: 'call', text: `${s}: ${outcome}`, code }); };

  // 1. Try the obvious thing: ship it to production.
  ctx.trace({ agent: ctx.name, kind: 'note', text: 'Task: deploy the site. Attempting production.' });
  const prod = await deploy.deploy(ctx.session, ctx.grant_id, 'production');
  const production_attempt: HostingResult['production_attempt'] = { status: prod.status, ...(isError(prod) ? { code: prod.code, alternative: prod.alternative_scope?.actions } : {}) };
  if (!isError(prod)) {
    // Only reachable with an owner-level grant; the demo never issues one.
    step('deploy.production', 'allowed');
    return { ok: true, steps, production_attempt, deployment: prod.data };
  }
  noteDenied(ctx, 'deploy.production', prod);
  step('deploy.production', `refused: ${prod.reason}`, prod.code);

  // 2. Read the refusal. Only a recoverable one with a named alternative is worth pursuing.
  if (prod.status !== 'AUTHORITY_REQUIRED' || prod.next_action !== 'request_authority' || !prod.alternative_scope) {
    step('interpret refusal', 'not recoverable; stopping', prod.code);
    return { ok: false, steps, production_attempt, failure: prod };
  }
  const wanted = prod.alternative_scope;
  ctx.trace({ agent: ctx.name, kind: 'note', text: `Refusal says ${wanted.actions.join(', ')} may be requested instead; asking the lead for exactly that.` });

  // 3. Ask for the alternative, no more.
  const requested: WorkforceScope = { actions: wanted.actions, resources: wanted.resources, expires_at: wanted.expires_at, max_delegation_depth: 0 };
  const asked = await ctx.session.requestAuthority({
    parent_grant_id: task.parent_grant_id, requested_scope: requested,
    reason: `deploy.production was refused (${prod.code}); the refusal named deploy.preview as the permitted alternative. Requesting preview-only authority to ship a reviewable build.`,
  });
  if (noteDenied(ctx, 'request_authority', asked)) { step('request deploy.preview', `could not file request`, asked.code); return { ok: false, steps, production_attempt, failure: asked }; }
  const request_id = asked.data.request_id;
  step('request deploy.preview', `filed request ${request_id}`);
  await task.notifyParent(request_id);

  // 4. Read the lead's answer from the authority, not from a message.
  const state = await ctx.session.getRequest(request_id);
  if (noteDenied(ctx, 'get_request', state)) return { ok: false, steps, production_attempt, failure: state };
  const negotiation: HostingResult['negotiation'] = { request_id, requested, offered: state.data.offered_scope, status: state.data.status };
  if (state.data.status !== 'COUNTEROFFERED' || !state.data.offered_scope) {
    step('lead decision', `request ${state.data.status.toLowerCase()}; cannot deploy`);
    return { ok: false, steps, production_attempt, negotiation };
  }
  step('lead decision', `counteroffered ${state.data.offered_scope.actions.join(', ')} on ${state.data.offered_scope.resources.join(', ')}`);

  // 5. Accept the narrower grant and retry with the allowed action.
  const accepted = await ctx.session.accept({ request_id, idempotency_key: `hosting-accept-${request_id}` });
  if (noteDenied(ctx, 'accept offer', accepted)) return { ok: false, steps, production_attempt, negotiation, failure: accepted };
  const grant: WorkforceGrant = accepted.data;
  negotiation.issued_grant_id = grant.id;
  step('accept offer', `issued grant ${grant.id}`);

  const preview: ApiResult<Deployment> = await deploy.deploy(ctx.session, grant.id, 'preview');
  if (noteDenied(ctx, 'deploy.preview', preview)) { step('deploy.preview', `failed: ${preview.reason}`, preview.code); return { ok: false, steps, production_attempt, negotiation, failure: preview }; }
  step('deploy.preview', `live at ${preview.data.url} (${preview.data.provider})`);
  ctx.trace({ agent: ctx.name, kind: 'result', text: `Preview deployed: ${preview.data.url} (local build, labeled ${preview.data.provider})`, data: preview.data });
  return { ok: true, steps, production_attempt, negotiation, deployment: preview.data };
}

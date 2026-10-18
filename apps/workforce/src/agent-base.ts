/**
 * Shared shape for the four specialist agents. Every agent:
 *   - is constructed with its OWN session (opened from its own credential),
 *     never the lead's;
 *   - reaches resources only through the gateways it is given;
 *   - reports what it did as structured output plus trace lines the
 *     orchestrator and the demo UI render as real events.
 */
import type { ApiResult, WorkforceSession } from './contract.js';
import type { AnalyticsGateway } from './gateways/analytics.js';
import type { DeployGateway } from './gateways/deploy.js';
import type { RepoGateway } from './gateways/repo.js';

export interface Trace {
  (line: { agent: string; kind: 'note' | 'call' | 'denied' | 'result'; text: string; code?: string; data?: unknown }): void;
}

export interface AgentContext {
  /** Principal id of this agent, for traces (identity itself comes from the session). */
  name: string;
  session: WorkforceSession;
  /** The grant this agent was given for its task. */
  grant_id: string;
  gateways: { repo?: RepoGateway; deploy?: DeployGateway; analytics?: AnalyticsGateway };
  trace: Trace;
}

export const isError = <T>(r: ApiResult<T>): r is Exclude<ApiResult<T>, { status: 'OK' }> => r.status !== 'OK';

/** Records a denial on the trace and returns true when `r` failed. */
export function noteDenied<T>(ctx: AgentContext, what: string, r: ApiResult<T>): r is Exclude<ApiResult<T>, { status: 'OK' }> {
  if (r.status === 'OK') return false;
  ctx.trace({ agent: ctx.name, kind: 'denied', text: `${what} → ${r.status} ${r.code}: ${r.reason}`, code: r.code });
  return true;
}

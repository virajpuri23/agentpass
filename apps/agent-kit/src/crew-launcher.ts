/**
 * Platform for the release-crew demo: starts the lead with its own key,
 * spawns each specialist the lead provisioned with only the path to that
 * specialist's private credential file, relays messages, collects traces,
 * and forwards top-up decisions to `decide` (a person in the UI, or a rule).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentMessage, CrewRole, Envelope, ProbeKind, TraceEvent } from './transport.js';
import type { LaunchConnection } from './launcher.js';

export type DecisionRequest = Extract<AgentMessage, { type: 'DECISION_REQUESTED' }>;
export type Decision = { decision: 'APPROVE' | 'PARTIAL' | 'DENY'; amount_cents?: number };

export interface CrewLaunchOptions {
  connection: LaunchConnection;
  leadKey: string;
  decide: (request: DecisionRequest) => Promise<Decision>;
  onTrace?: (event: TraceEvent) => void;
  onProcess?: (event: { agent: string; pid: number; kind: 'started' | 'exited' }) => void;
  onDecision?: (request: DecisionRequest, decision: Decision) => void;
  cwd?: string;
}

const LEAD = fileURLToPath(new URL('../../crew-agent/src/lead-main.ts', import.meta.url));
const SPECIALIST = fileURLToPath(new URL('../../crew-agent/src/specialist-main.ts', import.meta.url));

export async function launchCrew(opts: CrewLaunchOptions) {
  const procs = new Map<string, ChildProcess>();
  const waiters = new Map<string, (m: AgentMessage) => void>();
  const stderr: string[] = [];
  const connEnv = 'mcpUrl' in opts.connection ? { AGENTPASS_MCP_URL: opts.connection.mcpUrl } : { AUTHORITY_URL: opts.connection.authorityUrl };

  function start(agent: string, entry: string, env: NodeJS.ProcessEnv) {
    const child = fork(entry, [], {
      cwd: opts.cwd ?? process.cwd(),
      env: { PATH: process.env.PATH, AGENT_NAME: agent, ...connEnv, ...env },
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child.stderr?.on('data', (d) => stderr.push(`[${agent}] ${String(d).trim()}`));
    child.on('message', (raw) => void route(raw as Envelope));
    child.on('exit', () => { procs.delete(agent); opts.onProcess?.({ agent, pid: child.pid ?? -1, kind: 'exited' }); });
    procs.set(agent, child);
    opts.onProcess?.({ agent, pid: child.pid ?? -1, kind: 'started' });
    return child;
  }

  const reply = (env: Envelope, message: AgentMessage) =>
    procs.get(env.from)?.send({ from: 'launcher', to: env.from, correlationId: env.correlationId, replyTo: env.correlationId, message } satisfies Envelope);

  async function route(env: Envelope) {
    if (!env || typeof env !== 'object' || !('message' in env)) return;
    if (env.to !== 'launcher') { procs.get(env.to)?.send(env); return; }
    const m = env.message;
    if (env.replyTo && waiters.has(env.replyTo)) { waiters.get(env.replyTo)!(m); waiters.delete(env.replyTo); return; }
    if (m.type === 'TRACE') return void opts.onTrace?.(m.event);
    if (m.type === 'CREW_SPAWN_REQUESTED' && env.from === 'lead-agent') {
      // The specialist gets only its own credential file, never a key in env.
      const child = start(m.agent, SPECIALIST, { AGENT_CREDENTIAL_FILE: m.credential_file });
      return reply(env, { type: 'SPAWNED', agent: m.agent, pid: child.pid ?? -1 });
    }
    if (m.type === 'DECISION_REQUESTED' && env.from === 'lead-agent') {
      let decision: Decision;
      try { decision = await opts.decide(m); } catch { decision = { decision: 'DENY' }; }
      opts.onDecision?.(m, decision);
      return reply(env, { type: 'DECISION', ...decision });
    }
  }

  function ask(to: string, message: AgentMessage, timeoutMs: number): Promise<AgentMessage> {
    const correlationId = `launcher-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(correlationId); reject(new Error(`${message.type} to ${to} timed out\n${stderr.slice(-5).join('\n')}`)); }, timeoutMs);
      waiters.set(correlationId, (m) => { clearTimeout(timer); resolve(m); });
      const target = procs.get(to);
      if (!target) { clearTimeout(timer); return reject(new Error(`${to} is not running`)); }
      target.send({ from: 'launcher', to, correlationId, message } satisfies Envelope);
    });
  }

  start('lead-agent', LEAD, { AGENT_API_KEY: opts.leadKey });

  return {
    async run(root_grant_id: string, roles: CrewRole[], timeoutMs = 15 * 60_000) {
      const r = await ask('lead-agent', { type: 'CREW_START', root_grant_id, roles }, timeoutMs);
      if (r.type !== 'TASK_RESULT') throw new Error(`Unexpected reply ${r.type}`);
      return r;
    },
    async revoke(grant_id: string, reason: string) {
      const r = await ask('lead-agent', { type: 'REVOKE_REQUESTED', grant_id, reason }, 30_000);
      if (r.type !== 'GRANT_REVOKED') throw new Error(`Unexpected reply ${r.type}`);
      return r;
    },
    async probe(agent: string, probe: ProbeKind, params: Record<string, string> = {}) {
      const r = await ask(agent, { type: 'PROBE_REQUESTED', probe, params }, 30_000);
      if (r.type !== 'PROBE_RESULT') throw new Error(`Unexpected reply ${r.type}`);
      return r.result;
    },
    stderr: () => [...stderr],
    async stop() {
      for (const [agent, child] of procs) child.send?.({ from: 'launcher', to: agent, correlationId: 'shutdown', message: { type: 'SHUTDOWN' } } satisfies Envelope);
      await new Promise((r) => setTimeout(r, 300));
      for (const child of procs.values()) child.kill('SIGTERM');
    },
  };
}

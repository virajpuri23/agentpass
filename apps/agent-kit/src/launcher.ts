/**
 * Local "platform" for the demo: starts each agent as its own OS process with
 * only that agent's key, spawns the sourcing agent when the buyer asks, relays
 * agent-to-agent messages, and collects trace events. No process ever holds
 * another agent's key.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentMessage, Envelope, ProbeKind, PurchaseTask, TraceEvent } from './transport.js';

export type LaunchConnection = { authorityUrl: string } | { mcpUrl: string };

export interface LaunchOptions {
  connection: LaunchConnection;
  keys: { 'buyer-agent': string; 'sourcing-agent': string };
  onTrace?: (event: TraceEvent) => void;
  onProcess?: (event: { agent: string; pid: number; kind: 'started' | 'exited'; code?: number | null }) => void;
  cwd?: string;
}

const ENTRY: Record<string, string> = {
  'buyer-agent': fileURLToPath(new URL('../../buyer-agent/src/main.ts', import.meta.url)),
  'sourcing-agent': fileURLToPath(new URL('../../sourcing-agent/src/main.ts', import.meta.url)),
};

export async function launchAgents(opts: LaunchOptions) {
  const procs = new Map<string, ChildProcess>();
  const waiters = new Map<string, (m: AgentMessage) => void>();
  const stderr: string[] = [];

  function start(agent: 'buyer-agent' | 'sourcing-agent') {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      AGENT_API_KEY: opts.keys[agent], // this agent's key only
      ...('mcpUrl' in opts.connection ? { AGENTPASS_MCP_URL: opts.connection.mcpUrl } : { AUTHORITY_URL: opts.connection.authorityUrl }),
    };
    const child = fork(ENTRY[agent]!, [], {
      cwd: opts.cwd ?? process.cwd(),
      env,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child.stderr?.on('data', (d) => stderr.push(`[${agent}] ${String(d).trim()}`));
    child.on('message', (raw) => route(raw as Envelope));
    child.on('exit', (code) => { procs.delete(agent); opts.onProcess?.({ agent, pid: child.pid ?? -1, kind: 'exited', code }); });
    procs.set(agent, child);
    opts.onProcess?.({ agent, pid: child.pid ?? -1, kind: 'started' });
    return child;
  }

  function route(env: Envelope) {
    if (!env || typeof env !== 'object' || !('message' in env)) return;
    if (env.to !== 'launcher') {
      procs.get(env.to)?.send(env);
      return;
    }
    const m = env.message;
    if (env.replyTo && waiters.has(env.replyTo)) {
      waiters.get(env.replyTo)!(m);
      waiters.delete(env.replyTo);
      return;
    }
    if (m.type === 'TRACE') return void opts.onTrace?.(m.event);
    if (m.type === 'SPAWN_REQUESTED' && env.from === 'buyer-agent') {
      const child = procs.get(m.agent) ?? start(m.agent);
      procs.get(env.from)?.send({ from: 'launcher', to: env.from, correlationId: env.correlationId, replyTo: env.correlationId, message: { type: 'SPAWNED', agent: m.agent, pid: child.pid ?? -1 } } satisfies Envelope);
    }
  }

  function ask(to: string, message: AgentMessage, timeoutMs: number): Promise<AgentMessage> {
    const correlationId = `launcher-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(correlationId);
        reject(new Error(`${message.type} to ${to} timed out after ${timeoutMs}ms\n${stderr.slice(-5).join('\n')}`));
      }, timeoutMs);
      waiters.set(correlationId, (m) => { clearTimeout(timer); resolve(m); });
      const target = procs.get(to);
      if (!target) { clearTimeout(timer); return reject(new Error(`${to} is not running`)); }
      target.send({ from: 'launcher', to, correlationId, message } satisfies Envelope);
    });
  }

  start('buyer-agent');

  return {
    pid: (agent: string) => procs.get(agent)?.pid,
    /** Buyer delegates, spawns the child, and returns the child's final TASK_RESULT. */
    async run(task: PurchaseTask, timeoutMs = 120_000) {
      const reply = await ask('buyer-agent', { type: 'START', task }, timeoutMs);
      if (reply.type !== 'TASK_RESULT') throw new Error(`Unexpected reply ${reply.type}`);
      return reply;
    },
    /** Owner-style instruction to the buyer: revoke a grant it issued. */
    async revoke(grant_id: string, reason: string) {
      const reply = await ask('buyer-agent', { type: 'REVOKE_REQUESTED', grant_id, reason }, 30_000);
      if (reply.type !== 'GRANT_REVOKED') throw new Error(`Unexpected reply ${reply.type}`);
      return reply;
    },
    /** Ask the sourcing agent to attempt a demo probe under its own identity. */
    async probe(probe: ProbeKind, params: Record<string, string> = {}) {
      const reply = await ask('sourcing-agent', { type: 'PROBE_REQUESTED', probe, params }, 30_000);
      if (reply.type !== 'PROBE_RESULT') throw new Error(`Unexpected reply ${reply.type}`);
      return reply.result;
    },
    stderr: () => [...stderr],
    async stop() {
      for (const [agent, child] of procs) child.send?.({ from: 'launcher', to: agent, correlationId: 'shutdown', message: { type: 'SHUTDOWN' } } satisfies Envelope);
      await new Promise((r) => setTimeout(r, 300));
      for (const child of procs.values()) child.kill('SIGTERM');
    },
  };
}

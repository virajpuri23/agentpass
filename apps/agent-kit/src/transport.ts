/**
 * Agent-to-agent messaging (docs/06-DEVELOPER-B.md, B3). Messages are hints
 * between agents only: they never carry keys, and a message claiming to be
 * from `buyer-agent` grants nothing. Authority is always re-checked by
 * AgentPass with the recipient's own key.
 *
 * Adapters: in-memory (tests) and Node IPC (parent spawns child process).
 * A Primitive adapter can implement the same interface later.
 */
import type { ChildProcess } from 'node:child_process';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';

export interface PurchaseTask {
  supplier_id: string;
  sku_id: string;
  quantity: number;
  /** Budget the child will ask for if it hits AUTHORITY_REQUIRED (demo: $1,200). */
  requested_budget_cents: number;
}

export type AgentMessage =
  // launcher <-> buyer
  | { type: 'START'; task: PurchaseTask }
  | { type: 'SPAWN_REQUESTED'; agent: 'sourcing-agent' }
  | { type: 'SPAWNED'; agent: string; pid: number }
  | { type: 'REVOKE_REQUESTED'; grant_id: string; reason: string }
  | { type: 'SHUTDOWN' }
  // buyer <-> sourcing
  | ({ type: 'TASK_ASSIGNED'; grant_id: string } & PurchaseTask)
  | { type: 'AUTHORITY_REQUESTED'; request_id: string; parent_grant_id: string; requested_scope: AuthorityScope }
  | { type: 'AUTHORITY_RESPONDED'; request_id: string; decision: 'COUNTEROFFER' | 'REJECT' }
  | { type: 'TASK_RESULT'; ok: boolean; summary: Record<string, unknown> }
  | { type: 'GRANT_REVOKED'; grant_id: string; ok: boolean; code?: string }
  // release crew: lead <-> launcher <-> specialists
  | { type: 'CREW_START'; root_grant_id: string; roles: CrewRole[] }
  | { type: 'CREW_SPAWN_REQUESTED'; agent: string; credential_file: string }
  | { type: 'CREW_TASK'; sku_id: string; quantity: number }
  | { type: 'DECISION_REQUESTED'; request_id: string; agent: string; sku_id: string; asked_cents: number; slice_cents: number; available_cents: number; reason: string }
  | { type: 'DECISION'; decision: 'APPROVE' | 'PARTIAL' | 'DENY'; amount_cents?: number }
  // launcher -> sourcing: demo probes the child attempts under its own identity
  | { type: 'PROBE_REQUESTED'; probe: ProbeKind; params: Record<string, string> }
  | { type: 'PROBE_RESULT'; probe: ProbeKind; result: { status: string; code?: string; reason?: string; data?: unknown } }
  // any agent -> launcher (observability only)
  | { type: 'TRACE'; event: TraceEvent }
  | { type: 'ACK' };

export type ProbeKind = 'my_grants' | 'margin_read' | 'overspend' | 'widen_scope' | 'self_approve' | 'forged_identity' | 'purchase_again'
  | 'buy' | 'over_provision';

/** One specialist in the release crew: its tool, budget slice and job. */
export interface CrewRole {
  agent: string;          // transport name, e.g. 'qa-agent'
  label: string;          // display name
  sku_id: string;         // the only tool it may buy
  slice_cents: number;    // its own budget ceiling
  quantity: number;       // what its job needs
}

/** One line of the demo trace: a real tool call or an agent decision. */
export type TraceEvent =
  | { kind: 'call'; at: string; agent: string; tool: string; args: Record<string, unknown>; status: string; code?: string; data?: unknown; ms: number }
  | { kind: 'note'; at: string; agent: string; text: string; decider?: 'deterministic' | 'llm' };

export interface Envelope {
  from: string;
  to: string;
  correlationId: string;
  replyTo?: string;
  message: AgentMessage;
}

export interface AgentMessageTransport {
  readonly self: string;
  send(to: string, message: AgentMessage, correlationId: string): Promise<void>;
  /** Replies to `envelope`; the reply resolves the sender's waitForReply. */
  reply(envelope: Envelope, message: AgentMessage): Promise<void>;
  waitForReply(correlationId: string, timeoutMs: number): Promise<AgentMessage>;
  onMessage(handler: (envelope: Envelope) => void | Promise<void>): void;
  close(): void;
}

/** Shared plumbing: routes inbound envelopes to reply waiters or the handler. */
abstract class BaseTransport implements AgentMessageTransport {
  private waiters = new Map<string, (m: AgentMessage) => void>();
  private early = new Map<string, AgentMessage>();
  private handler?: (envelope: Envelope) => void | Promise<void>;
  private backlog: Envelope[] = [];

  constructor(readonly self: string) {}
  protected abstract deliver(envelope: Envelope): void;

  async send(to: string, message: AgentMessage, correlationId: string) {
    this.deliver({ from: this.self, to, correlationId, message });
  }

  async reply(envelope: Envelope, message: AgentMessage) {
    this.deliver({ from: this.self, to: envelope.from, correlationId: envelope.correlationId, replyTo: envelope.correlationId, message });
  }

  waitForReply(correlationId: string, timeoutMs: number): Promise<AgentMessage> {
    const ready = this.early.get(correlationId);
    if (ready) { this.early.delete(correlationId); return Promise.resolve(ready); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(correlationId);
        reject(new Error(`No reply for ${correlationId} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.set(correlationId, (m) => { clearTimeout(timer); resolve(m); });
    });
  }

  onMessage(handler: (envelope: Envelope) => void | Promise<void>) {
    this.handler = handler;
    for (const envelope of this.backlog.splice(0)) void handler(envelope);
  }

  protected receive(envelope: Envelope) {
    if (envelope.to !== this.self) return;
    if (envelope.replyTo) {
      const waiter = this.waiters.get(envelope.replyTo);
      if (waiter) { this.waiters.delete(envelope.replyTo); waiter(envelope.message); } else this.early.set(envelope.replyTo, envelope.message);
      return;
    }
    if (this.handler) void this.handler(envelope); else this.backlog.push(envelope);
  }

  close() {}
}

/** In-process hub for tests: `hub.endpoint('buyer-agent')`. */
export class InMemoryHub {
  private endpoints = new Map<string, InMemoryEndpoint>();
  endpoint(name: string): AgentMessageTransport {
    const endpoint = new InMemoryEndpoint(name, this);
    this.endpoints.set(name, endpoint);
    return endpoint;
  }
  route(envelope: Envelope) {
    queueMicrotask(() => this.endpoints.get(envelope.to)?.accept(envelope));
  }
}

class InMemoryEndpoint extends BaseTransport {
  constructor(self: string, private hub: InMemoryHub) { super(self); }
  protected deliver(envelope: Envelope) { this.hub.route(envelope); }
  accept(envelope: Envelope) { this.receive(envelope); }
}

/** Parent side of a spawned child process (`fork` with an IPC channel). */
export class IpcParentTransport extends BaseTransport {
  private listener = (raw: unknown) => { if (isEnvelope(raw)) this.receive(raw); };
  constructor(self: string, private child: ChildProcess) {
    super(self);
    child.on('message', this.listener);
  }
  protected deliver(envelope: Envelope) { this.child.send?.(envelope); }
  override close() { this.child.off('message', this.listener); }
}

/** Child side: talks to the parent over process.send / process.on('message'). */
export class IpcChildTransport extends BaseTransport {
  private listener = (raw: unknown) => { if (isEnvelope(raw)) this.receive(raw); };
  constructor(self: string) {
    super(self);
    if (!process.send) throw new Error('IpcChildTransport requires a process started with an IPC channel');
    process.on('message', this.listener);
  }
  protected deliver(envelope: Envelope) { process.send?.(envelope); }
  override close() { process.off('message', this.listener); process.disconnect?.(); }
}

function isEnvelope(raw: unknown): raw is Envelope {
  return !!raw && typeof raw === 'object' && 'message' in raw && 'to' in raw && 'from' in raw && 'correlationId' in raw;
}

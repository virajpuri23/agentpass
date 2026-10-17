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

export type AgentMessage =
  | { type: 'TASK_ASSIGNED'; grant_id: string; supplier_id: string; sku_id: string; quantity: number; requested_budget_cents: number }
  | { type: 'AUTHORITY_REQUESTED'; request_id: string; parent_grant_id: string; requested_scope: AuthorityScope }
  | { type: 'AUTHORITY_RESPONDED'; request_id: string; decision: 'COUNTEROFFER' | 'REJECT' }
  | { type: 'TASK_RESULT'; ok: boolean; summary: Record<string, unknown> }
  | { type: 'GRANT_REVOKED'; grant_id: string }
  | { type: 'ACK' };

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

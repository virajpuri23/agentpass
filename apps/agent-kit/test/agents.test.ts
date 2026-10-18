/**
 * Step 3: buyer and sourcing agents as separate OS processes, each with only
 * its own key, against A's real authority and the real supplier.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { HttpSupplierService } from '../../authority/src/supplier.js';
import { SERVICE_KEY, startSupplier } from '../../supplier/test/harness.js';
import { sqliteStore } from '../../supplier/src/store.js';
import { launchAgents } from '../src/launcher.js';
import type { TraceEvent } from '../src/transport.js';

const keys = { 'owner-1': 'proc-owner', 'buyer-agent': 'proc-buyer', 'sourcing-agent': 'proc-child', 'supplier-agent': 'proc-supplier' };

let supplier: Awaited<ReturnType<typeof startSupplier>>;
let authority: Server;
let db: ReturnType<typeof openDatabase>;
let agents: Awaited<ReturnType<typeof launchAgents>>;
const trace: TraceEvent[] = [];
const processes: { agent: string; pid: number; kind: string }[] = [];

beforeAll(async () => {
  supplier = await startSupplier(sqliteStore(':memory:'));
  db = openDatabase(':memory:');
  seedDatabase(db, keys);
  const app = createAuthorityApp({ db, supplier: new HttpSupplierService(supplier.base, SERVICE_KEY) });
  authority = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  agents = await launchAgents({
    connection: { authorityUrl: `http://127.0.0.1:${(authority.address() as AddressInfo).port}` },
    keys: { 'buyer-agent': keys['buyer-agent'], 'sourcing-agent': keys['sourcing-agent'] },
    onTrace: (e) => trace.push(e),
    onProcess: (p) => processes.push(p),
  });
}, 30_000);

afterAll(async () => {
  await agents?.stop();
  await new Promise((r) => authority?.close(r));
  db?.close();
  await supplier?.stop();
});

describe('buyer + sourcing agent processes', () => {
  let summary: Record<string, any>;

  it('negotiates and buys autonomously: $850 quote, $1200 ask, $900 offer, one $850 purchase', async () => {
    const result = await agents.run({ supplier_id: 'supplier-co', sku_id: 'PACK-500', quantity: 500, requested_budget_cents: 120000 }, 60_000);
    summary = result.summary;
    expect(result.ok, JSON.stringify(result.summary) + agents.stderr().join('\n')).toBe(true);
    expect(summary.quote.total_cents).toBe(85000);
    expect(summary.receipt).toMatchObject({ amount_cents: 85000, outcome: 'COMPLETED', simulated: true });
    expect((await supplier.store.getProduct('PACK-500'))!.stock_quantity).toBe(500);
  }, 60_000);

  it('ran as two distinct OS processes', () => {
    const started = processes.filter((p) => p.kind === 'started');
    expect(started.map((p) => p.agent).sort()).toEqual(['buyer-agent', 'sourcing-agent']);
    expect(new Set(started.map((p) => p.pid)).size).toBe(2);
  });

  it('traces real calls from each agent in protocol order, without keys', () => {
    const calls = trace.filter((e) => e.kind === 'call');
    const step = (agent: string, tool: string, status?: string) =>
      calls.findIndex((c) => c.kind === 'call' && c.agent === agent && c.tool === tool && (!status || c.status === status));
    const order = [
      step('buyer-agent', 'delegate_authority', 'OK'),
      step('sourcing-agent', 'execute_action', 'OK'),
      step('sourcing-agent', 'execute_action', 'AUTHORITY_REQUIRED'),
      step('sourcing-agent', 'request_authority', 'OK'),
      step('buyer-agent', 'respond_authority_request', 'OK'),
      step('sourcing-agent', 'accept_authority_offer', 'OK'),
    ];
    expect(order.every((i) => i >= 0), JSON.stringify(calls.map((c) => c.kind === 'call' && `${c.agent}:${c.tool}:${c.status}`))).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(JSON.stringify(trace)).not.toMatch(/proc-(buyer|child|owner)/);
    expect(trace.some((e) => e.kind === 'note' && e.decider === 'deterministic' && /counteroffering \$900/.test(e.text))).toBe(true);
  });

  it('revocation by the buyer blocks the child from further purchases', async () => {
    const revoked = await agents.revoke(summary.purchase_grant_id, 'Demo: owner revokes child authority');
    expect(revoked).toMatchObject({ type: 'GRANT_REVOKED', ok: true });
    const res = await fetch(`http://127.0.0.1:${(authority.address() as AddressInfo).port}/v1/actions/execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keys['sourcing-agent']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ grant_id: summary.purchase_grant_id, action: 'supplier.purchase.execute', supplier_id: 'supplier-co', sku_id: 'PACK-500', quote_id: summary.quote.quote_id, idempotency_key: 'after-revoke' }),
    });
    expect(await res.json()).toMatchObject({ code: 'GRANT_REVOKED' });
  });
});

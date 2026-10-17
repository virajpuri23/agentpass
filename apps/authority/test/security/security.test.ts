import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SupplierQuote } from '../../../../packages/contracts/src/index.js';
import { createAuthorityApp } from '../../src/app.js';
import type { SupplierService } from '../../src/supplier.js';
import { openDatabase } from '../../../../db/database.js';
import { seedDatabase } from '../../../../db/seed.js';

const keys = {
  'owner-1': 'owner-test-key',
  'buyer-agent': 'buyer-test-key',
  'sourcing-agent': 'sourcing-test-key',
  'supplier-agent': 'supplier-test-key',
};
const start = new Date('2026-10-17T20:00:00.000Z');
const quote850: SupplierQuote = {
  quote_id: 'quote-85000', supplier_id: 'supplier-co', sku_id: 'PACK-500', quantity: 500,
  unit_price_cents: 170, total_cents: 85000, currency: 'USD', expires_at: '2026-10-18T12:00:00.000Z',
};

describe('authority security over public HTTP', () => {
  let db: ReturnType<typeof openDatabase>;
  let server: ReturnType<ReturnType<typeof createAuthorityApp>['listen']>;
  let baseUrl: string;
  let now: Date;
  let quotes: Map<string, SupplierQuote>;
  let orders: Map<string, string>;
  let supplier: SupplierService;
  let policy: Mock<SupplierService['policy']>;
  let fulfill: Mock<SupplierService['fulfill']>;

  beforeEach(async () => {
    now = new Date(start);
    db = openDatabase(':memory:');
    seedDatabase(db, keys, now);
    quotes = new Map([[quote850.quote_id, quote850]]);
    orders = new Map();
    policy = vi.fn(async (_principal, action) => action !== 'supplier.margin.read');
    fulfill = vi.fn<SupplierService['fulfill']>(async input => {
      const orderId = orders.get(input.request_id) ?? `order-${input.request_id}`;
      orders.set(input.request_id, orderId);
      return { order_id: orderId };
    });
    supplier = {
      policy,
      quote: vi.fn(async input => ({
        ...quote850,
        quote_id: `quote-${input.quantity * 170}`,
        supplier_id: input.supplier_id,
        sku_id: input.sku_id,
        quantity: input.quantity,
        total_cents: input.quantity * 170,
        expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
      })),
      getQuote: vi.fn(async id => {
        const quote = quotes.get(id);
        if (!quote) throw new Error('Unknown quote');
        return quote;
      }),
      fulfill,
    };
    server = createAuthorityApp({ db, supplier, now: () => new Date(now) }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  });

  function future(seconds: number): string {
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }

  function scope(overrides: Record<string, unknown> = {}) {
    return {
      actions: ['supplier.purchase.execute'],
      supplier_ids: ['supplier-co'],
      sku_ids: ['PACK-500'],
      max_per_action_cents: 100000,
      total_budget_cents: 100000,
      expires_at: future(3600),
      max_delegation_depth: 0,
      ...overrides,
    };
  }

  async function http(method: string, path: string, principal: keyof typeof keys, body?: unknown) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: { Authorization: `Bearer ${keys[principal]}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  }

  async function delegate(scopeValue = scope(), principal: keyof typeof keys = 'buyer-agent', recipient = 'sourcing-agent') {
    const response = await http('POST', '/v1/grants/grant-root-buyer/delegate', principal, {
      recipient_principal_id: recipient, scope: scopeValue,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.data.id as string;
  }

  async function purchase(grantId: string, idempotencyKey: string, quoteId = quote850.quote_id) {
    return http('POST', '/v1/actions/execute', 'sourcing-agent', {
      grant_id: grantId, action: 'supplier.purchase.execute', supplier_id: 'supplier-co',
      sku_id: 'PACK-500', quote_id: quoteId, idempotency_key: idempotencyKey,
    });
  }

  it('binds identity to the bearer key and rejects a body that tries to spoof the parent', async () => {
    const childScope = { ...scope(), actions: ['supplier.quote.request'], max_per_action_cents: 0, total_budget_cents: 0, max_delegation_depth: 1 };
    const result = await http('POST', '/v1/grants/grant-root-buyer/delegate', 'sourcing-agent', {
      recipient_principal_id: 'sourcing-agent', scope: childScope, agent_id: 'buyer-agent',
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_REQUEST');
    const me = await http('GET', '/v1/me?agent_id=buyer-agent', 'sourcing-agent');
    expect(me.body.data.principal_id).toBe('sourcing-agent');
    expect(db.prepare('SELECT COUNT(*) AS count FROM grants WHERE parent_grant_id IS NOT NULL').get()).toMatchObject({ count: 0 });
  });

  it.each([
    ['action', { actions: ['supplier.margin.read'] }],
    ['supplier', { supplier_ids: ['other-supplier'] }],
    ['SKU', { sku_ids: ['OTHER-SKU'] }],
    ['per-action budget', { max_per_action_cents: 100001 }],
    ['total budget', { total_budget_cents: 100001 }],
    ['expiration', { expires_at: new Date(start.getTime() + 86401_000).toISOString() }],
    ['delegation depth', { max_delegation_depth: 2 }],
  ])('rejects a delegated scope that widens the parent %s', async (_dimension, change) => {
    const result = await http('POST', '/v1/grants/grant-root-buyer/delegate', 'buyer-agent', {
      recipient_principal_id: 'sourcing-agent', scope: scope(change),
    });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('OUTSIDE_PARENT_SCOPE');
  });

  it('blocks grants across organizations', async () => {
    const result = await http('POST', '/v1/grants/grant-root-buyer/delegate', 'buyer-agent', {
      recipient_principal_id: 'supplier-agent', scope: scope({ actions: ['supplier.quote.request'], max_per_action_cents: 0, total_budget_cents: 0, max_delegation_depth: 1 }),
    });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('OUTSIDE_PARENT_SCOPE');
    expect(db.prepare("SELECT COUNT(*) AS count FROM grants WHERE subject_principal_id = 'supplier-agent'").get()).toMatchObject({ count: 0 });
  });

  it('does not issue a counteroffer after its parent grant is revoked', async () => {
    await delegate(scope({
      actions: ['supplier.quote.request'], max_per_action_cents: 0, total_budget_cents: 0, max_delegation_depth: 1,
    }));
    const requested = await http('POST', '/v1/authority/requests', 'sourcing-agent', {
      parent_grant_id: 'grant-root-buyer',
      requested_scope: scope({ max_per_action_cents: 120000, total_budget_cents: 120000, expires_at: future(7200), max_delegation_depth: 1 }),
      reason: 'Need purchase authority',
    });
    const requestId = requested.body.data.request_id as string;
    const offer = await http('POST', `/v1/authority/requests/${requestId}/respond`, 'buyer-agent', {
      decision: 'COUNTEROFFER', offered_scope: scope({ max_per_action_cents: 90000, total_budget_cents: 90000, expires_at: future(3600) }),
    });
    expect(offer.status).toBe(200);
    await http('POST', '/v1/grants/grant-root-buyer/revoke', 'owner-1', { reason: 'Stop all delegated activity' });

    const accepted = await http('POST', `/v1/authority/requests/${requestId}/accept`, 'sourcing-agent', { idempotency_key: 'stale-offer' });
    expect(accepted.status).toBe(403);
    expect(accepted.body.code).toBe('GRANT_REVOKED');
    const persisted = await http('GET', `/v1/authority/requests/${requestId}`, 'sourcing-agent');
    expect(persisted.body.data.status).toBe('COUNTEROFFERED');
  });

  it('prevents a requester from approving its own authority request', async () => {
    await delegate(scope({
      actions: ['supplier.quote.request'], max_per_action_cents: 0, total_budget_cents: 0, max_delegation_depth: 1,
    }));
    const requested = await http('POST', '/v1/authority/requests', 'sourcing-agent', {
      parent_grant_id: 'grant-root-buyer', requested_scope: scope({ max_per_action_cents: 120000, total_budget_cents: 120000, max_delegation_depth: 1 }), reason: 'Need to purchase the quoted packaging',
    });
    expect(requested.status).toBe(200);
    const requestId = requested.body.data.request_id as string;
    const response = await http('POST', `/v1/authority/requests/${requestId}/respond`, 'sourcing-agent', {
      decision: 'COUNTEROFFER', offered_scope: scope(),
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INVALID_CALLER');
    const persisted = await http('GET', `/v1/authority/requests/${requestId}`, 'sourcing-agent');
    expect(persisted.body.data.status).toBe('PENDING');
  });

  it('completes quote-only recovery through a bounded counteroffer and uses the trusted quote', async () => {
    const quoteGrant = await delegate(scope({
      actions: ['supplier.quote.request'], max_per_action_cents: 0, total_budget_cents: 0, max_delegation_depth: 1,
    }));
    const quoted = await http('POST', '/v1/actions/execute', 'sourcing-agent', {
      grant_id: quoteGrant, action: 'supplier.quote.request', supplier_id: 'supplier-co', sku_id: 'PACK-500', quantity: 500, idempotency_key: 'quote-one',
    });
    expect(quoted.status).toBe(200);
    expect(quoted.body.data.total_cents).toBe(85000);

    const blocked = await purchase(quoteGrant, 'purchase-after-quote');
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ status: 'AUTHORITY_REQUIRED', code: 'INSUFFICIENT_SCOPE', next_action: 'request_authority' });

    const requested = await http('POST', '/v1/authority/requests', 'sourcing-agent', {
      parent_grant_id: 'grant-root-buyer',
      requested_scope: scope({ max_per_action_cents: 120000, total_budget_cents: 120000, expires_at: future(7200), max_delegation_depth: 1 }),
      reason: 'Purchase the supplier quote',
    });
    expect(requested.status).toBe(200);
    const requestId = requested.body.data.request_id as string;
    const offeredScope = scope({ max_per_action_cents: 90000, total_budget_cents: 90000, expires_at: future(3600) });
    const offered = await http('POST', `/v1/authority/requests/${requestId}/respond`, 'buyer-agent', { decision: 'COUNTEROFFER', offered_scope: offeredScope });
    expect(offered.status).toBe(200);
    expect(offered.body.data.status).toBe('COUNTEROFFERED');
    const accepted = await http('POST', `/v1/authority/requests/${requestId}/accept`, 'sourcing-agent', { idempotency_key: 'accept-offer' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.scope.total_budget_cents).toBe(90000);

    const result = await purchase(accepted.body.data.id, 'purchase-golden');
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ amount_cents: 85000, outcome: 'COMPLETED', simulated: true, grant_id: accepted.body.data.id });
    expect(supplier.fulfill).toHaveBeenCalledTimes(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM purchases WHERE request_json IS NOT NULL AND request_json != ?').get('') as { count: number }).count).toBe(1);
  });

  it('denies supplier margin reads without returning private pricing fields', async () => {
    const result = await http('POST', '/v1/actions/execute', 'buyer-agent', {
      grant_id: 'grant-root-buyer', action: 'supplier.margin.read', supplier_id: 'supplier-co', sku_id: 'PACK-500', idempotency_key: 'margin-read',
    });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('SELLER_POLICY_DENIED');
    expect(JSON.stringify(result.body)).not.toMatch(/internal_unit_cost|margin|\b100\b/);
  });

  it('rejects an unrecognized action and caller-supplied purchase price', async () => {
    const grantId = await delegate(scope());
    const unknown = await http('POST', '/v1/actions/execute', 'sourcing-agent', {
      grant_id: grantId, action: 'read_all_supplier_data', supplier_id: 'supplier-co', sku_id: 'PACK-500', idempotency_key: 'unknown-action',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('INVALID_REQUEST');
    const override = await http('POST', '/v1/actions/execute', 'sourcing-agent', {
      grant_id: grantId, action: 'supplier.purchase.execute', supplier_id: 'supplier-co', sku_id: 'PACK-500',
      quote_id: quote850.quote_id, idempotency_key: 'price-override', amount_cents: 1,
    });
    expect(override.status).toBe(400);
    expect(override.body.code).toBe('INVALID_REQUEST');
    expect(supplier.getQuote).not.toHaveBeenCalled();
    expect(supplier.fulfill).not.toHaveBeenCalled();
  });

  it('rejects an expired grant before contacting the supplier', async () => {
    const grantId = await delegate(scope({ expires_at: future(5) }));
    now = new Date(now.getTime() + 6000);
    const result = await purchase(grantId, 'expired-purchase');
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('GRANT_EXPIRED');
    expect(supplier.getQuote).not.toHaveBeenCalled();
  });

  it('rejects an expired supplier quote before reserving budget', async () => {
    const expiredQuote = { ...quote850, quote_id: 'quote-expired', expires_at: new Date(start.getTime() - 1).toISOString() };
    quotes.set(expiredQuote.quote_id, expiredQuote);
    const grantId = await delegate(scope());
    const result = await purchase(grantId, 'expired-quote', expiredQuote.quote_id);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('QUOTE_EXPIRED');
    expect(supplier.fulfill).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM purchases').get() as { count: number }).count).toBe(0);
  });

  it('rechecks grant expiry after supplier policy awaits and before reserving budget', async () => {
    const grantId = await delegate(scope({ expires_at: future(30) }));
    policy.mockImplementationOnce(async () => {
      now = new Date(now.getTime() + 31_000);
      return true;
    });
    const result = await purchase(grantId, 'policy-expiry-race');
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('GRANT_EXPIRED');
    expect(supplier.fulfill).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM purchases').get() as { count: number }).count).toBe(0);
  });

  it('propagates ancestor revocation to an active descendant', async () => {
    const grantId = await delegate(scope());
    const revoked = await http('POST', '/v1/grants/grant-root-buyer/revoke', 'owner-1', { reason: 'Stop all delegated activity' });
    expect(revoked.status).toBe(200);
    const result = await purchase(grantId, 'revoked-purchase');
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('GRANT_REVOKED');
    expect(supplier.getQuote).not.toHaveBeenCalled();
  });

  it('returns the same receipt on an identical retry and rejects a changed fingerprint', async () => {
    const grantId = await delegate(scope());
    const first = await purchase(grantId, 'same-key');
    const retry = await purchase(grantId, 'same-key');
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(supplier.fulfill).toHaveBeenCalledTimes(1);
    const changed = await purchase(grantId, 'same-key', 'different-quote');
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('ALREADY_EXECUTED');
    expect(supplier.fulfill).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent requests with the same idempotency key', async () => {
    const grantId = await delegate(scope());
    const results = await Promise.all([
      purchase(grantId, 'concurrent-key'),
      purchase(grantId, 'concurrent-key'),
    ]);
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(results[0].body).toEqual(results[1].body);
    expect(orders.size).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM purchases').get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE state = 'COMMITTED'").get() as { count: number }).count).toBe(2);
  });

  it('serializes sibling purchases against their shared parent budget', async () => {
    const quote60: SupplierQuote = {
      ...quote850, quote_id: 'quote-60000', quantity: 1, unit_price_cents: 60000, total_cents: 60000,
    };
    quotes.set(quote60.quote_id, quote60);
    const siblingScope = scope({ max_per_action_cents: 60000, total_budget_cents: 60000 });
    const firstGrant = await delegate(siblingScope);
    const secondGrant = await delegate(siblingScope);
    const results = await Promise.all([
      purchase(firstGrant, 'sibling-one', quote60.quote_id),
      purchase(secondGrant, 'sibling-two', quote60.quote_id),
    ]);
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect(results.filter(result => result.body.code === 'BUDGET_EXCEEDED')).toHaveLength(1);
    expect((db.prepare("SELECT SUM(amount_cents) AS amount FROM ledger_entries WHERE grant_id = 'grant-root-buyer' AND state IN ('RESERVED','COMMITTED')").get() as { amount: number }).amount).toBe(60000);
    expect(supplier.fulfill).toHaveBeenCalledTimes(1);
  });

  it('serializes sibling purchases across two authority instances sharing a SQLite file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentpass-race-'));
    const filename = join(directory, 'authority.sqlite');
    const firstDb = openDatabase(filename);
    const secondDb = openDatabase(filename);
    const quote60: SupplierQuote = {
      ...quote850, quote_id: 'quote-60000-file', quantity: 1, unit_price_cents: 60000, total_cents: 60000,
    };
    quotes.set(quote60.quote_id, quote60);
    let firstServer: ReturnType<ReturnType<typeof createAuthorityApp>['listen']> | undefined;
    let secondServer: ReturnType<ReturnType<typeof createAuthorityApp>['listen']> | undefined;
    const listen = async (fileDb: typeof firstDb) => {
      const instance = createAuthorityApp({ db: fileDb, supplier, now: () => new Date(now) }).listen(0, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        instance.once('listening', resolve);
        instance.once('error', reject);
      });
      return { server: instance, url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}` };
    };
    const send = async (url: string, method: string, path: string, principal: keyof typeof keys, body?: unknown) => {
      const response = await fetch(new URL(path, url), {
        method,
        headers: { Authorization: `Bearer ${keys[principal]}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    };
    let first: Awaited<ReturnType<typeof listen>> | undefined;
    let second: Awaited<ReturnType<typeof listen>> | undefined;
    try {
      seedDatabase(firstDb, keys, now);
      first = await listen(firstDb);
      firstServer = first.server;
      second = await listen(secondDb);
      secondServer = second.server;
      const siblingScope = scope({ max_per_action_cents: 60000, total_budget_cents: 60000 });
      const grant1 = await send(first.url, 'POST', '/v1/grants/grant-root-buyer/delegate', 'buyer-agent', { recipient_principal_id: 'sourcing-agent', scope: siblingScope });
      const grant2 = await send(second.url, 'POST', '/v1/grants/grant-root-buyer/delegate', 'buyer-agent', { recipient_principal_id: 'sourcing-agent', scope: siblingScope });
      expect(grant1.status).toBe(200);
      expect(grant2.status).toBe(200);
      const results = await Promise.all([
        send(first.url, 'POST', '/v1/actions/execute', 'sourcing-agent', { grant_id: grant1.body.data.id, action: 'supplier.purchase.execute', supplier_id: 'supplier-co', sku_id: 'PACK-500', quote_id: quote60.quote_id, idempotency_key: 'file-race-one' }),
        send(second.url, 'POST', '/v1/actions/execute', 'sourcing-agent', { grant_id: grant2.body.data.id, action: 'supplier.purchase.execute', supplier_id: 'supplier-co', sku_id: 'PACK-500', quote_id: quote60.quote_id, idempotency_key: 'file-race-two' }),
      ]);
      expect(results.filter(result => result.status === 200)).toHaveLength(1);
      expect(results.filter(result => result.body.code === 'BUDGET_EXCEEDED')).toHaveLength(1);
      expect((firstDb.prepare("SELECT SUM(amount_cents) AS amount FROM ledger_entries WHERE grant_id = 'grant-root-buyer' AND state IN ('RESERVED','COMMITTED')").get() as { amount: number }).amount).toBe(60000);
      expect(orders.size).toBe(1);
    } finally {
      for (const instance of [firstServer, secondServer]) {
        if (instance) await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
      }
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains one reservation and safely completes a retry after an uncertain seller failure', async () => {
    const grantId = await delegate(scope());
    fulfill.mockRejectedValueOnce(new Error('seller timeout'));
    const first = await purchase(grantId, 'retry-pending');
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('SERVICE_UNAVAILABLE');
    const beforeRetry = db.prepare("SELECT status, request_json FROM purchases WHERE caller_principal_id = 'sourcing-agent' AND idempotency_key = ?").get('retry-pending') as { status: string; request_json: string };
    expect(beforeRetry.status).toBe('PENDING');
    expect(beforeRetry.request_json).toContain(quote850.quote_id);

    const retry = await purchase(grantId, 'retry-pending');
    expect(retry.status).toBe(200);
    expect(db.prepare("SELECT status FROM purchases WHERE caller_principal_id = 'sourcing-agent' AND idempotency_key = ?").get('retry-pending')).toMatchObject({ status: 'COMPLETED' });
    expect(db.prepare("SELECT state FROM ledger_entries WHERE purchase_id = (SELECT id FROM purchases WHERE idempotency_key = 'retry-pending')").all()).toEqual([{ state: 'COMMITTED' }, { state: 'COMMITTED' }]);
    expect(supplier.fulfill).toHaveBeenCalledTimes(2);
    expect(fulfill.mock.calls[0][0].request_id).toBe(fulfill.mock.calls[1][0].request_id);
  });

  it('rejects an unknown API key', async () => {
    const response = await fetch(new URL('/v1/me', baseUrl), { headers: { Authorization: 'Bearer unknown-key' } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'INVALID_CALLER' });
  });
});

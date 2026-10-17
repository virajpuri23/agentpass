/**
 * Gate 3: Developer A's real authority gateway calling this real supplier
 * service over HTTP (no fixtures on either side).
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { HttpSupplierService } from '../../authority/src/supplier.js';
import { SERVICE_KEY, startSupplier } from './harness.js';
import { sqliteStore } from '../src/store.js';

const keys = { 'owner-1': 'k-owner', 'buyer-agent': 'k-buyer', 'sourcing-agent': 'k-child', 'supplier-agent': 'k-supplier' };

describe('authority gateway + real supplier', () => {
  let supplier: Awaited<ReturnType<typeof startSupplier>>;
  let authority: Server;
  let db: ReturnType<typeof openDatabase>;
  let base: string;

  async function call(path: string, body: unknown, token: string) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { text, ...JSON.parse(text) };
  }
  const scope = (budget: number, actions: AuthorityScope['actions']): AuthorityScope => ({
    actions, supplier_ids: ['supplier-co'], sku_ids: ['PACK-500'], max_per_action_cents: budget,
    total_budget_cents: budget, expires_at: new Date(Date.now() + 300_000).toISOString(), max_delegation_depth: 0,
  });
  const delegate = async (budget: number, actions: AuthorityScope['actions']) =>
    (await call('/v1/grants/grant-root-buyer/delegate', { recipient_principal_id: 'sourcing-agent', scope: scope(budget, actions) }, keys['buyer-agent'])).data;
  const execute = (input: Record<string, unknown>) =>
    call('/v1/actions/execute', { supplier_id: 'supplier-co', sku_id: 'PACK-500', ...input }, keys['sourcing-agent']);

  beforeEach(async () => {
    supplier = await startSupplier(sqliteStore(':memory:'));
    db = openDatabase(':memory:');
    seedDatabase(db, keys);
    const app = createAuthorityApp({ db, supplier: new HttpSupplierService(supplier.base, SERVICE_KEY) });
    authority = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => authority.close(r));
    db.close();
    await supplier.stop();
  });

  it('quotes $850, requires purchase authority, buys once, and keeps margins private', async () => {
    const quoteGrant = await delegate(0, ['supplier.quote.request']);
    const quote = await execute({ grant_id: quoteGrant.id, action: 'supplier.quote.request', quantity: 500, idempotency_key: 'quote-1' });
    expect(quote.status).toBe('OK');
    expect(quote.data).toMatchObject({ total_cents: 85000, unit_price_cents: 170, quantity: 500 });
    const quoteId = quote.data.quote_id;

    const blocked = await execute({ grant_id: quoteGrant.id, action: 'supplier.purchase.execute', quote_id: quoteId, idempotency_key: 'buy-1' });
    expect(blocked).toMatchObject({ status: 'AUTHORITY_REQUIRED', next_action: 'request_authority' });

    const purchaseGrant = await delegate(90000, ['supplier.purchase.execute']);
    const receipt = await execute({ grant_id: purchaseGrant.id, action: 'supplier.purchase.execute', quote_id: quoteId, idempotency_key: 'buy-2' });
    expect(receipt.status).toBe('OK');
    expect(receipt.data).toMatchObject({ amount_cents: 85000, quantity: 500, outcome: 'COMPLETED', simulated: true });
    expect(receipt.data.order_id).toMatch(/^order-/);

    const replay = await execute({ grant_id: purchaseGrant.id, action: 'supplier.purchase.execute', quote_id: quoteId, idempotency_key: 'buy-2' });
    expect(replay.data).toEqual(receipt.data);
    expect((await supplier.store.getProduct('PACK-500'))!.stock_quantity).toBe(500);

    const margin = await execute({ grant_id: purchaseGrant.id, action: 'supplier.margin.read', quote_id: quoteId, idempotency_key: 'margin-1' });
    expect(margin.status).not.toBe('OK');
    for (const r of [quote, receipt, margin]) expect(r.text).not.toMatch(/internal_unit_cost|margin_cents|"cost/i);
  });
});

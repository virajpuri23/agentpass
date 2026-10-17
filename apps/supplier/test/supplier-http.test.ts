import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backends, quoteInput, startSupplier } from './harness.js';

/** Recursively scans a response for anything resembling private cost/margin data. */
function assertNoPrivateData(text: string) {
  expect(text).not.toMatch(/internal|cost|margin|stock/i);
  expect(text).not.toMatch(/\b100\b/); // the private unit cost value
}

for (const backend of backends) {
  describe(`supplier HTTP (${backend.name})`, () => {
    let s: Awaited<ReturnType<typeof startSupplier>>;
    let clock = new Date('2026-10-18T12:00:00Z');
    beforeEach(async () => {
      clock = new Date('2026-10-18T12:00:00Z');
      s = await startSupplier(backend.make(), { now: () => clock });
    });
    afterEach(async () => s.stop());

    describe('auth', () => {
      it('serves health without a key', async () => {
        const res = await fetch(`${s.base}/health`);
        expect(res.status).toBe(200);
      });
      it('rejects missing or wrong service keys', async () => {
        expect((await s.call('POST', '/internal/quote', quoteInput(), null)).status).toBe(401);
        expect((await s.call('POST', '/internal/quote', quoteInput(), 'wrong')).status).toBe(401);
        expect((await s.call('GET', '/internal/quotes/x', undefined, null)).status).toBe(401);
      });
    });

    describe('quote', () => {
      it('prices 500 x PACK-500 at exactly $850 from the catalog', async () => {
        const r = await s.call('POST', '/internal/quote', quoteInput());
        expect(r.status).toBe(200);
        expect(r.json.data).toMatchObject({
          supplier_id: 'supplier-co', sku_id: 'PACK-500', quantity: 500,
          unit_price_cents: 170, total_cents: 85000, currency: 'USD',
          expires_at: '2026-10-18T12:15:00.000Z',
        });
        expect(Object.keys(r.json.data).sort()).toEqual(
          ['currency', 'expires_at', 'quantity', 'quote_id', 'sku_id', 'supplier_id', 'total_cents', 'unit_price_cents']);
        const read = await s.call('GET', `/internal/quotes/${r.json.data.quote_id}`);
        expect(read.json.data).toEqual(r.json.data);
      });

      it('rejects caller-supplied prices and unknown fields', async () => {
        const r = await s.call('POST', '/internal/quote', quoteInput({ unit_price_cents: 1, total_cents: 1 }));
        expect(r.status).toBe(400);
      });

      it('is idempotent per request_id and rejects reuse with different terms', async () => {
        const input = quoteInput();
        const a = await s.call('POST', '/internal/quote', input);
        const b = await s.call('POST', '/internal/quote', input);
        expect(b.json.data.quote_id).toBe(a.json.data.quote_id);
        expect((await s.call('POST', '/internal/quote', { ...input, quantity: 10 })).status).toBe(409);
      });

      it('denies quotes the seller policy forbids', async () => {
        const r = await s.call('POST', '/internal/quote', quoteInput({ sku_id: 'SECRET-SKU' }));
        expect(r.status).toBe(403);
        expect(r.json).toMatchObject({ status: 'DENIED', code: 'SELLER_POLICY_DENIED' });
      });
    });

    describe('private data', () => {
      it('never returns cost, margin or stock in any response', async () => {
        const q = await s.call('POST', '/internal/quote', quoteInput());
        const responses = [
          q,
          await s.call('GET', `/internal/quotes/${q.json.data.quote_id}`),
          await s.call('POST', '/internal/fulfill', { quote_id: q.json.data.quote_id, buyer_principal_id: 'sourcing-agent', request_id: 'p-1' }),
          await s.call('POST', '/internal/policy/evaluate', { principal_id: 'sourcing-agent', action: 'supplier.quote.request', resource: { supplier_id: 'supplier-co', sku_id: 'PACK-500' } }),
        ];
        for (const r of responses) assertNoPrivateData(r.text.replace(/"reason":"[^"]*"/g, ''));
      });

      it('denies margin reads with no numeric private values', async () => {
        const r = await s.call('POST', '/internal/policy/evaluate', {
          principal_id: 'sourcing-agent', action: 'supplier.margin.read', resource: { supplier_id: 'supplier-co', sku_id: 'PACK-500' },
        });
        expect(r.json).toMatchObject({ status: 'OK', data: { decision: 'DENY' } });
        expect(r.text).not.toMatch(/\d{3,}/);
      });

      it('allows quote policy for a known SKU', async () => {
        const r = await s.call('POST', '/internal/policy/evaluate', {
          principal_id: 'sourcing-agent', action: 'supplier.quote.request', resource: { supplier_id: 'supplier-co', sku_id: 'PACK-500' },
        });
        expect(r.json).toEqual({ status: 'OK', data: { decision: 'ALLOW' } });
      });
    });

    describe('fulfill', () => {
      const fulfill = (quote_id: string, request_id = 'purchase-1', buyer = 'sourcing-agent') =>
        s.call('POST', '/internal/fulfill', { quote_id, buyer_principal_id: buyer, request_id });

      it('creates one order and replays it for the same request_id', async () => {
        const q = (await s.call('POST', '/internal/quote', quoteInput())).json.data;
        const a = await fulfill(q.quote_id);
        const b = await fulfill(q.quote_id);
        expect(a.status).toBe(200);
        expect(a.json.data.order_id).toMatch(/^order-/);
        expect(b.json.data.order_id).toBe(a.json.data.order_id);
        expect((await s.store.getProduct('PACK-500'))!.stock_quantity).toBe(500);
      });

      it('produces exactly one order under concurrent duplicate requests', async () => {
        const q = (await s.call('POST', '/internal/quote', quoteInput())).json.data;
        const results = await Promise.all(Array.from({ length: 8 }, () => fulfill(q.quote_id, 'purchase-race')));
        expect(new Set(results.map((r) => r.json.data?.order_id)).size).toBe(1);
        expect((await s.store.getProduct('PACK-500'))!.stock_quantity).toBe(500);
      });

      it('refuses a second order for the same quote under a new request_id', async () => {
        const q = (await s.call('POST', '/internal/quote', quoteInput())).json.data;
        await fulfill(q.quote_id, 'purchase-a');
        expect((await fulfill(q.quote_id, 'purchase-b')).status).toBe(409);
      });

      it('refuses expired quotes but still replays completed orders', async () => {
        const q = (await s.call('POST', '/internal/quote', quoteInput())).json.data;
        const done = await fulfill(q.quote_id, 'purchase-before-expiry');
        const fresh = (await s.call('POST', '/internal/quote', quoteInput())).json.data;
        clock = new Date('2026-10-18T12:16:00Z');
        expect((await fulfill(fresh.quote_id, 'purchase-late')).json).toMatchObject({ code: 'QUOTE_EXPIRED' });
        expect((await fulfill(q.quote_id, 'purchase-before-expiry')).json.data.order_id).toBe(done.json.data.order_id);
      });

      it('refuses orders by a different buyer or for unknown quotes', async () => {
        const q = (await s.call('POST', '/internal/quote', quoteInput())).json.data;
        expect((await fulfill(q.quote_id, 'purchase-x', 'buyer-agent')).status).toBe(403);
        expect((await fulfill('quote-missing', 'purchase-y')).status).toBe(404);
      });

      it('denies when stock runs out', async () => {
        await s.store.reset(600);
        const q1 = (await s.call('POST', '/internal/quote', quoteInput())).json.data;
        const q2 = (await s.call('POST', '/internal/quote', quoteInput())).json.data;
        expect((await fulfill(q1.quote_id, 'p-1')).status).toBe(200);
        const r = await fulfill(q2.quote_id, 'p-2');
        expect(r.status).toBe(403);
        expect(r.json.code).toBe('SELLER_POLICY_DENIED');
      });
    });
  });
}

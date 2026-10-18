/**
 * The in-process service vendor behind the wallets: fixed catalog, quotes that
 * AgentPass's quote schema accepts, simulated orders, and a policy that only
 * admits its own SKUs. Negative: an unknown SKU is refused by policy and
 * cannot be quoted.
 */
import { describe, expect, it } from 'vitest';
import { quoteSchema } from '../../authority/src/validation.js';
import { CATALOG, createServiceVendor, SKU_IDS, VENDOR_ID } from '../src/real/vendor.js';

const principal = { id: 'agent-x', organization_id: 'buyer-co', kind: 'AGENT', role: 'SERVICE' } as never;

describe('service vendor', () => {
  it('quotes catalog items at fixed prices and fulfils them as simulated orders', async () => {
    const vendor = createServiceVendor();
    for (const sku of SKU_IDS) expect(await vendor.policy(principal, 'supplier.purchase.execute', { supplier_id: VENDOR_ID, sku_id: sku })).toBe(true);
    const q = await vendor.quote({ buyer_principal_id: 'agent-x', supplier_id: VENDOR_ID, sku_id: 'hosting-slot', quantity: 2, request_id: 'r1' });
    expect(quoteSchema.safeParse(q).success).toBe(true);
    expect(q.total_cents).toBe(2 * CATALOG['hosting-slot'].unit_price_cents);
    expect(await vendor.getQuote(q.quote_id)).toEqual(q);
    const order = await vendor.fulfill({ quote_id: q.quote_id, buyer_principal_id: 'agent-x', request_id: 'p1' });
    expect(order.order_id).toMatch(/^order-/);
    expect(vendor.orders).toEqual([expect.objectContaining({ order_id: order.order_id, sku_id: 'hosting-slot', quantity: 2, total_cents: 12000 })]);
  });

  it('refuses anything outside its catalog or another vendor id', async () => {
    const vendor = createServiceVendor();
    expect(await vendor.policy(principal, 'supplier.quote.request', { supplier_id: VENDOR_ID, sku_id: 'raw-dataset' })).toBe(false);
    expect(await vendor.policy(principal, 'supplier.quote.request', { supplier_id: 'supplier-co', sku_id: 'stock-photo' })).toBe(false);
    await expect(vendor.quote({ buyer_principal_id: 'agent-x', supplier_id: VENDOR_ID, sku_id: 'raw-dataset', quantity: 1, request_id: 'r2' })).rejects.toThrow(/unknown sku/);
    await expect(vendor.getQuote('q-nope')).rejects.toThrow(/unknown quote/);
    expect(vendor.orders).toEqual([]);
  });
});

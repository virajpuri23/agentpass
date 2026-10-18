/**
 * The service vendor the helpers buy from: an in-process implementation of
 * AgentPass's SupplierService with a fixed catalog. AgentPass calls it for
 * quotes and fulfilment after it has authorized the purchase; the vendor
 * never sees a grant or a credential. Prices are fixed and orders are
 * simulated: this is the demo's stand-in for a stock-photo site, a security
 * firm's invoice, a hosting provider and a data warehouse.
 */
import { randomUUID } from 'node:crypto';
import type { SupplierService } from '../../../authority/src/supplier.js';
import type { SupplierQuote } from '../../../../packages/contracts/src/index.js';

export const VENDOR_ID = 'service-vendor';

export const CATALOG = {
  'stock-photo': { name: 'stock photo licence', unit_price_cents: 4000 },
  'audit-hour': { name: 'security review hour (Sentinel Sec)', unit_price_cents: 8000 },
  'hosting-slot': { name: 'preview hosting slot (60 min)', unit_price_cents: 6000 },
  'data-query': { name: 'analytics warehouse query', unit_price_cents: 2500 },
} as const;
export type SkuId = keyof typeof CATALOG;
export const SKU_IDS = Object.keys(CATALOG) as SkuId[];

export interface VendorOrder { order_id: string; quote_id: string; buyer_principal_id: string; sku_id: string; quantity: number; total_cents: number }

export function createServiceVendor(now: () => Date = () => new Date()): SupplierService & { orders: VendorOrder[]; quotes: () => SupplierQuote[] } {
  const quotes = new Map<string, SupplierQuote>();
  const orders: VendorOrder[] = [];
  return {
    orders,
    quotes: () => [...quotes.values()],
    async policy(_principal, _action, resource) {
      return resource.supplier_id === VENDOR_ID && resource.sku_id in CATALOG;
    },
    async quote(input) {
      const item = CATALOG[input.sku_id as SkuId];
      if (input.supplier_id !== VENDOR_ID || !item) throw new Error(`unknown sku ${input.sku_id}`);
      const q: SupplierQuote = {
        quote_id: `q-${randomUUID()}`, supplier_id: VENDOR_ID, sku_id: input.sku_id, quantity: input.quantity,
        unit_price_cents: item.unit_price_cents, total_cents: item.unit_price_cents * input.quantity, currency: 'USD',
        expires_at: new Date(now().getTime() + 10 * 60_000).toISOString(),
      };
      quotes.set(q.quote_id, q);
      return q;
    },
    async getQuote(id) {
      const q = quotes.get(id);
      if (!q) throw new Error(`unknown quote ${id}`);
      return q;
    },
    async fulfill(input) {
      const q = quotes.get(input.quote_id);
      if (!q) throw new Error(`unknown quote ${input.quote_id}`);
      const order = { order_id: `order-${randomUUID()}`, quote_id: q.quote_id, buyer_principal_id: input.buyer_principal_id, sku_id: q.sku_id, quantity: q.quantity, total_cents: q.total_cents };
      orders.push(order);
      return { order_id: order.order_id };
    },
  };
}

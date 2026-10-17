/**
 * Supplier agent: answers quote / fulfillment requests forwarded by the
 * AgentPass gateway. Prices always come from the supplier's own catalog,
 * never from the caller.
 */
import { randomUUID } from 'node:crypto';
import type {
  SupplierFulfillRequest, SupplierQuote, SupplierQuoteRequest,
} from '../../../packages/contracts/src/index.js';
import { evaluatePolicy, type PolicyDecision } from './policy.js';
import { publicQuote } from './public-view.js';
import type { SupplierStore } from './store.js';

export const QUOTE_TTL_MS = 15 * 60 * 1000;

/** Error carrying the wire envelope and HTTP status the route should send. */
export class SupplierError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: { status: 'DENIED' | 'ERROR'; code: string; reason: string },
  ) {
    super(body.reason);
  }
}

const policyDenied = (reason: string) =>
  new SupplierError(403, { status: 'DENIED', code: 'SELLER_POLICY_DENIED', reason });
const invalid = (status: number, reason: string) =>
  new SupplierError(status, { status: 'ERROR', code: 'INVALID_REQUEST', reason });

export interface SupplierServiceOptions {
  store: SupplierStore;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export function createSupplierService({ store, now = () => new Date(), newId = (p) => `${p}-${randomUUID()}` }: SupplierServiceOptions) {
  async function decide(principalId: string, action: string, supplierId: string, skuId: string, quantity?: number) {
    const product = await store.getProduct(skuId);
    return evaluatePolicy({ principal_id: principalId, action, supplier_id: supplierId, product, quantity });
  }

  return {
    async evaluate(input: { principal_id: string; action: string; resource: { supplier_id: string; sku_id: string } }): Promise<PolicyDecision> {
      return decide(input.principal_id, input.action, input.resource.supplier_id, input.resource.sku_id);
    },

    async quote(input: SupplierQuoteRequest): Promise<SupplierQuote> {
      const existing = await store.getQuoteByRequest(input.request_id);
      if (existing) {
        const same = existing.buyer_principal_id === input.buyer_principal_id && existing.supplier_id === input.supplier_id
          && existing.sku_id === input.sku_id && Number(existing.quantity) === input.quantity;
        if (!same) throw invalid(409, 'request_id was already used for a different quote');
        return publicQuote(existing);
      }
      const policy = await decide(input.buyer_principal_id, 'supplier.quote.request', input.supplier_id, input.sku_id, input.quantity);
      if (policy.decision === 'DENY') throw policyDenied(policy.reason);

      const product = (await store.getProduct(input.sku_id))!;
      const created = now();
      const row = await store.insertQuote({
        id: newId('quote'),
        request_id: input.request_id,
        supplier_id: input.supplier_id,
        sku_id: input.sku_id,
        buyer_principal_id: input.buyer_principal_id,
        quantity: input.quantity,
        unit_price_cents: product.public_unit_price_cents,
        total_cents: input.quantity * product.public_unit_price_cents,
        currency: 'USD',
        expires_at: new Date(created.getTime() + QUOTE_TTL_MS).toISOString(),
        created_at: created.toISOString(),
      });
      return publicQuote(row);
    },

    async getQuote(id: string): Promise<SupplierQuote> {
      const row = await store.getQuote(id);
      if (!row) throw invalid(404, 'Quote not found');
      return publicQuote(row);
    },

    async fulfill(input: SupplierFulfillRequest): Promise<{ order_id: string }> {
      // Replays return the original order even after the quote expires.
      const replay = await store.getOrderByRequest(input.request_id);
      if (replay) {
        if (replay.quote_id !== input.quote_id || replay.buyer_principal_id !== input.buyer_principal_id) {
          throw invalid(409, 'request_id was already used for a different order');
        }
        return { order_id: replay.id };
      }

      const quote = await store.getQuote(input.quote_id);
      if (!quote) throw invalid(404, 'Quote not found');
      if (quote.buyer_principal_id !== input.buyer_principal_id) throw invalid(403, 'Quote was issued to a different buyer');
      if (Date.parse(quote.expires_at) <= now().getTime()) {
        throw new SupplierError(409, { status: 'ERROR', code: 'QUOTE_EXPIRED', reason: 'Quote has expired' });
      }
      const policy = await decide(input.buyer_principal_id, 'supplier.purchase.execute', quote.supplier_id, quote.sku_id, Number(quote.quantity));
      if (policy.decision === 'DENY') throw policyDenied(policy.reason);

      const result = await store.fulfill({
        id: newId('order'),
        request_id: input.request_id,
        quote_id: quote.id,
        buyer_principal_id: input.buyer_principal_id,
        status: 'COMPLETED',
        created_at: now().toISOString(),
      }, Number(quote.quantity), quote.sku_id);

      switch (result.kind) {
        case 'CREATED':
        case 'REPLAYED': return { order_id: result.order.id };
        case 'QUOTE_ALREADY_ORDERED': throw invalid(409, 'Quote was already fulfilled by another request');
        case 'OUT_OF_STOCK': throw policyDenied('Insufficient stock');
      }
    },
  };
}

export type SupplierService = ReturnType<typeof createSupplierService>;

/**
 * Supplier Company's own policy. Independent of AgentPass: a valid buyer
 * grant never overrides it. Unknown actions and private data are denied.
 */
import type { CatalogRow } from './store.js';

export const SUPPLIER_ID = 'supplier-co';
export const MAX_ORDER_QUANTITY = 1000;

const ALLOWED_ACTIONS = new Set(['supplier.quote.request', 'supplier.purchase.execute']);
const PRIVATE_ACTIONS = new Set(['supplier.margin.read']);

export type PolicyDecision = { decision: 'ALLOW' } | { decision: 'DENY'; reason: string };

export interface PolicyInput {
  principal_id: string;
  action: string;
  supplier_id: string;
  product: CatalogRow | undefined;
  quantity?: number;
}

export function evaluatePolicy({ principal_id, action, supplier_id, product, quantity }: PolicyInput): PolicyDecision {
  if (PRIVATE_ACTIONS.has(action)) return deny('Supplier cost and margin data are private to supplier-co');
  if (!ALLOWED_ACTIONS.has(action)) return deny('Action is not offered by supplier-co');
  if (!principal_id) return deny('Caller principal is required');
  if (supplier_id !== SUPPLIER_ID) return deny('Unknown supplier');
  if (!product || !product.active) return deny('SKU is not offered');
  if (quantity !== undefined) {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_QUANTITY) {
      return deny(`Quantity must be between 1 and ${MAX_ORDER_QUANTITY}`);
    }
    if (quantity > product.stock_quantity) return deny('Insufficient stock');
  }
  return { decision: 'ALLOW' };
}

function deny(reason: string): PolicyDecision {
  return { decision: 'DENY', reason };
}

/**
 * The only way supplier rows leave the service. Copies an explicit allowlist
 * of public fields so private columns (internal_unit_cost_cents, stock, ...)
 * cannot leak through a spread or a new column.
 */
import type { SupplierQuote } from '../../../packages/contracts/src/index.js';
import type { QuoteRow } from './store.js';

export function publicQuote(row: QuoteRow): SupplierQuote {
  return {
    quote_id: row.id,
    supplier_id: row.supplier_id,
    sku_id: row.sku_id,
    quantity: Number(row.quantity),
    unit_price_cents: Number(row.unit_price_cents),
    total_cents: Number(row.total_cents),
    currency: 'USD',
    expires_at: row.expires_at,
  };
}

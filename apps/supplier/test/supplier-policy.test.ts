import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '../src/policy.js';
import type { CatalogRow } from '../src/store.js';

const product: CatalogRow = {
  sku_id: 'PACK-500', product_name: 'Packaging units', stock_quantity: 1000,
  public_unit_price_cents: 170, internal_unit_cost_cents: 100, active: true,
};
const base = { principal_id: 'sourcing-agent', supplier_id: 'supplier-co', product };

describe('supplier policy', () => {
  it('allows quotes and purchases of offered SKUs', () => {
    expect(evaluatePolicy({ ...base, action: 'supplier.quote.request', quantity: 500 })).toEqual({ decision: 'ALLOW' });
    expect(evaluatePolicy({ ...base, action: 'supplier.purchase.execute', quantity: 500 })).toEqual({ decision: 'ALLOW' });
  });

  it('always denies margin reads, even for a valid buyer', () => {
    expect(evaluatePolicy({ ...base, action: 'supplier.margin.read' }).decision).toBe('DENY');
  });

  it('denies unknown actions, suppliers, SKUs and bad quantities', () => {
    expect(evaluatePolicy({ ...base, action: 'read_all_supplier_data' }).decision).toBe('DENY');
    expect(evaluatePolicy({ ...base, action: 'supplier.quote.request', supplier_id: 'other-co' }).decision).toBe('DENY');
    expect(evaluatePolicy({ ...base, action: 'supplier.quote.request', product: undefined }).decision).toBe('DENY');
    expect(evaluatePolicy({ ...base, action: 'supplier.quote.request', product: { ...product, active: false } }).decision).toBe('DENY');
    for (const quantity of [0, -1, 1.5, 1001]) {
      expect(evaluatePolicy({ ...base, action: 'supplier.quote.request', quantity }).decision).toBe('DENY');
    }
    expect(evaluatePolicy({ ...base, action: 'supplier.quote.request', quantity: 600, product: { ...product, stock_quantity: 500 } }).decision).toBe('DENY');
  });
});

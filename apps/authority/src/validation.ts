import { z } from 'zod';
import { workforceScopeSchema } from '../../../packages/contracts/src/workforce.js';
export const id = z.string().min(1).max(200);
export const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const actionSchema = z.enum(['supplier.quote.request', 'supplier.purchase.execute', 'supplier.margin.read']);
const list = z.array(id).max(100).refine(v => new Set(v).size === v.length);
const supplierScopeSchema = z.object({
  actions: z.array(actionSchema).max(3).refine(v => new Set(v).size === v.length),
  supplier_ids: list, sku_ids: list,
  max_per_action_cents: money, total_budget_cents: money,
  expires_at: z.iso.datetime({ offset: true }), max_delegation_depth: z.number().int().min(0).max(20)
}).strict();
export const scopeSchema = z.union([supplierScopeSchema,workforceScopeSchema]);
export const executeSchema = z.object({
  grant_id: id, action: actionSchema, supplier_id: id, sku_id: id,
  quantity: z.number().int().positive().max(1000000).optional(), quote_id: id.optional(), idempotency_key: id
}).strict().refine(v => v.action === 'supplier.quote.request' ? v.quantity !== undefined && v.quote_id === undefined : v.action !== 'supplier.purchase.execute' || v.quote_id !== undefined);
export const quoteSchema = z.object({
  quote_id: id, supplier_id: id, sku_id: id, quantity: z.number().int().positive(),
  unit_price_cents: money, total_cents: money, currency: z.literal('USD'), expires_at: z.iso.datetime({ offset: true })
}).refine(q => Number.isSafeInteger(q.quantity * q.unit_price_cents) && q.total_cents === q.quantity * q.unit_price_cents);

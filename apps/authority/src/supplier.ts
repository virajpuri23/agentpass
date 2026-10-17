import type { Principal, AgentAction, SupplierQuote, SupplierQuoteRequest, SupplierFulfillRequest } from '../../../packages/contracts/src/index.js';
import { quoteSchema, id } from './validation.js';
import { z } from 'zod';
export interface SupplierService {
  policy(principal: Principal, action: AgentAction, resource: { supplier_id: string; sku_id: string }): Promise<boolean>;
  quote(input: SupplierQuoteRequest): Promise<SupplierQuote>;
  getQuote(id: string): Promise<SupplierQuote>;
  fulfill(input: SupplierFulfillRequest): Promise<{ order_id: string }>;
}
export class HttpSupplierService implements SupplierService {
  private base: URL;
  constructor(url: string, private key: string) {
    this.base = new URL(url);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || !key) throw new Error('Invalid supplier service configuration');
  }
  private async call(path: string, body?: unknown): Promise<any> {
    const response = await fetch(new URL(path, this.base), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'X-Service-Key': this.key, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('Supplier unavailable');
    const value = await response.json();
    if (value?.status && value.status !== 'OK') throw new Error('Supplier rejected operation');
    return value?.status === 'OK' ? value.data : value;
  }
  async policy(principal: Principal, action: AgentAction, resource: { supplier_id: string; sku_id: string }) {
    const result = await this.call('/internal/policy/evaluate', { principal_id: principal.id, action, resource });
    return result?.decision === 'ALLOW';
  }
  async quote(input: SupplierQuoteRequest) { return quoteSchema.parse(await this.call('/internal/quote', input)); }
  async getQuote(quoteId: string) { return quoteSchema.parse(await this.call(`/internal/quotes/${encodeURIComponent(quoteId)}`)); }
  async fulfill(input: SupplierFulfillRequest) { return z.object({ order_id: id }).parse(await this.call('/internal/fulfill', input)); }
}

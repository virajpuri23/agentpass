import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqliteStore } from '../src/store.js';
import { startSupplier } from './harness.js';

describe('supplier public MCP', () => {
  let s: Awaited<ReturnType<typeof startSupplier>>;
  beforeEach(async () => { s = await startSupplier(sqliteStore(':memory:')); });
  afterEach(async () => s.stop());

  it('exposes only read-only public discovery, without private data', async () => {
    const client = new Client({ name: 'supplier-mcp-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['describe_supplier']);

    const result = await client.callTool({ name: 'describe_supplier', arguments: {} });
    const text = JSON.stringify(result);
    const data = (result.structuredContent as any).data;
    expect(data.supplier_id).toBe('supplier-co');
    expect(data.catalog.map((c: any) => [c.sku_id, c.list_unit_price_cents])).toEqual([
      ['DESIGN-PACK', 18000], ['PACK-500', 170], ['QA-MINUTES', 100], ['SEC-SCAN', 12000],
    ]);
    for (const item of data.catalog) expect(Object.keys(item).sort()).toEqual(['currency', 'list_unit_price_cents', 'name', 'sku_id']);
    // private costs (100 for PACK-500 is also QA's public price, so check the others) and stock never appear
    expect(text).not.toMatch(/internal_unit_cost|stock_quantity|"cost_|margin_cents|\b7000\b|\b9000\b|\b55\b/);
    await client.close();
  });
});

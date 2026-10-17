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
    expect(result.structuredContent).toMatchObject({
      status: 'OK',
      data: { supplier_id: 'supplier-co', catalog: [{ sku_id: 'PACK-500', list_unit_price_cents: 170 }] },
    });
    expect(text).not.toMatch(/internal_unit_cost|stock_quantity|"cost_|margin_cents|\b100\b|\b1000\b/);
    await client.close();
  });
});

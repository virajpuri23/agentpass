/**
 * The supplier's public MCP face: read-only discovery for agents. It reveals
 * only public catalog facts and points agents at AgentPass for anything
 * consequential. Quotes and orders stay behind the X-Service-Key API.
 */
import type express from 'express';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { SUPPLIER_ID } from './policy.js';
import type { SupplierStore } from './store.js';

export function supplierMcpHandler(store: SupplierStore) {
  const factory = () => {
    const server = new McpServer({ name: 'supplier-co', version: '1.0.0' });
    server.registerTool('describe_supplier', {
      description: 'Public catalog of Packaging Supply Inc. (supplier-co) and how to obtain a quote or purchase through AgentPass.',
      inputSchema: z.object({}).strict(),
    }, async () => {
      const products = await store.listProducts();
      const data = {
        supplier_id: SUPPLIER_ID,
        organization: 'Packaging Supply Inc.',
        catalog: products.map((p) => ({ sku_id: p.sku_id, name: p.product_name, list_unit_price_cents: p.public_unit_price_cents, currency: 'USD' })),
        how_to_buy: 'Call AgentPass execute_action with supplier.quote.request, then supplier.purchase.execute with the returned quote_id. Quotes are binding for 15 minutes; prices are set by supplier-co.',
        private: 'Costs, margins and inventory levels are never disclosed.',
        simulated: true,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'OK', data }) }], structuredContent: { status: 'OK', data } };
    });
    return server;
  };
  const mcp = createMcpHandler(factory, { onerror: () => console.error(JSON.stringify({ service: 'supplier', error: 'mcp' })) });

  return async (req: express.Request, res: express.Response) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.originalUrl}`, { method: req.method, headers });
    const response = await mcp.fetch(request, req.body === undefined ? {} : { parsedBody: req.body });
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (!response.body) return void res.end();
    for await (const chunk of response.body) res.write(chunk);
    res.end();
  };
}

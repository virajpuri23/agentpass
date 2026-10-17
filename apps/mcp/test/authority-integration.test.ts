import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthorityScope, Grant } from '../../../packages/contracts/src/index.js';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import type { SupplierService } from '../../authority/src/supplier.js';

const keys = {
  'owner-1': 'test-owner',
  'buyer-agent': 'test-buyer',
  'sourcing-agent': 'test-sourcing',
  'supplier-agent': 'test-supplier',
};

const quote = {
  quote_id: 'quote-850',
  supplier_id: 'supplier-co',
  sku_id: 'PACK-500',
  quantity: 500,
  unit_price_cents: 170,
  total_cents: 85000,
  currency: 'USD' as const,
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
};

function resultData<T>(result: { structuredContent?: unknown }): T {
  const response = result.structuredContent as { status: string; data: T };
  expect(response.status).toBe('OK');
  return response.data;
}

describe('AgentPass MCP authority integration', () => {
  it('runs discovery, delegation, negotiation, execution, and revocation through MCP', async () => {
    const db = openDatabase(':memory:');
    seedDatabase(db, keys);

    let orderNumber = 0;
    const supplier: SupplierService = {
      policy: async () => true,
      quote: async () => quote,
      getQuote: async (quoteId) => {
        if (quoteId !== quote.quote_id) throw new Error('Unknown fixture quote');
        return quote;
      },
      fulfill: async () => ({ order_id: `fixture-order-${++orderNumber}` }),
    };

    const authority: Server = createAuthorityApp({ db, supplier }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      authority.once('listening', resolve);
      authority.once('error', reject);
    });
    const authorityUrl = `http://127.0.0.1:${(authority.address() as { port: number }).port}`;
    const attached: Array<{ client: Client; transport: StdioClientTransport }> = [];

    async function connect(agentApiKey: string) {
      const client = new Client({ name: `agentpass-${agentApiKey}`, version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'apps/mcp/src/server.ts'],
        cwd: process.cwd(),
        env: { AUTHORITY_URL: authorityUrl, AGENT_API_KEY: agentApiKey },
        stderr: 'pipe',
      });
      await client.connect(transport);
      attached.push({ client, transport });
      return client;
    }

    try {
      const buyer = await connect(keys['buyer-agent']);
      const sourcing = await connect(keys['sourcing-agent']);

      const description = resultData<{ actions: string[] }>(await buyer.callTool({ name: 'describe_authority', arguments: {} }));
      expect(description.actions).toEqual(['supplier.quote.request', 'supplier.purchase.execute', 'supplier.margin.read']);

      const buyerGrants = resultData<{ grants: Grant[] }>(await buyer.callTool({ name: 'get_my_grants', arguments: {} }));
      const root = buyerGrants.grants.find((grant) => grant.id === 'grant-root-buyer');
      expect(root).toBeDefined();

      const quoteScope: AuthorityScope = {
        actions: ['supplier.quote.request'],
        supplier_ids: ['supplier-co'],
        sku_ids: ['PACK-500'],
        max_per_action_cents: 0,
        total_budget_cents: 0,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        max_delegation_depth: 0,
      };
      const delegated = resultData<Grant>(await buyer.callTool({
        name: 'delegate_authority',
        arguments: {
          parent_grant_id: root!.id,
          recipient_principal_id: 'sourcing-agent',
          scope: quoteScope,
        },
      }));
      const sourcingGrants = resultData<{ grants: Grant[] }>(await sourcing.callTool({ name: 'get_my_grants', arguments: {} }));
      expect(sourcingGrants.grants.map((grant) => grant.id)).toContain(delegated.id);

      const issuedQuote = resultData<typeof quote>(await sourcing.callTool({
        name: 'execute_action',
        arguments: {
          grant_id: delegated.id,
          action: 'supplier.quote.request',
          supplier_id: quote.supplier_id,
          sku_id: quote.sku_id,
          quantity: quote.quantity,
          idempotency_key: 'mcp-quote-1',
        },
      }));
      expect(issuedQuote.total_cents).toBe(85000);

      const requestedScope: AuthorityScope = {
        ...quoteScope,
        actions: ['supplier.purchase.execute'],
        max_per_action_cents: 120000,
        total_budget_cents: 120000,
        expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
      };
      const request = resultData<{ request_id: string; status: string }>(await sourcing.callTool({
        name: 'request_authority',
        arguments: { parent_grant_id: root!.id, requested_scope: requestedScope, reason: 'Purchase the supplier quote.' },
      }));
      expect(request.status).toBe('PENDING');

      const fetchedRequest = resultData<{ id: string; status: string }>(await buyer.callTool({
        name: 'get_authority_request',
        arguments: { request_id: request.request_id },
      }));
      expect(fetchedRequest).toMatchObject({ id: request.request_id, status: 'PENDING' });

      const offerScope: AuthorityScope = {
        ...requestedScope,
        max_per_action_cents: 90000,
        total_budget_cents: 90000,
        expires_at: new Date(Date.now() + 3 * 60_000).toISOString(),
      };
      const response = resultData<{ status: string }>(await buyer.callTool({
        name: 'respond_authority_request',
        arguments: { request_id: request.request_id, decision: 'COUNTEROFFER', offered_scope: offerScope },
      }));
      expect(response.status).toBe('COUNTEROFFERED');

      const purchaseGrant = resultData<Grant>(await sourcing.callTool({
        name: 'accept_authority_offer',
        arguments: { request_id: request.request_id, idempotency_key: 'mcp-accept-1' },
      }));
      const receipt = resultData<{ amount_cents: number; simulated: true; grant_id: string }>(await sourcing.callTool({
        name: 'execute_action',
        arguments: {
          grant_id: purchaseGrant.id,
          action: 'supplier.purchase.execute',
          supplier_id: quote.supplier_id,
          sku_id: quote.sku_id,
          quantity: quote.quantity,
          quote_id: quote.quote_id,
          idempotency_key: 'mcp-purchase-1',
        },
      }));
      expect(receipt).toMatchObject({ amount_cents: 85000, simulated: true, grant_id: purchaseGrant.id });

      const revoked = resultData<{ grant_id: string }>(await buyer.callTool({
        name: 'revoke_authority',
        arguments: { grant_id: purchaseGrant.id, reason: 'Demo complete.' },
      }));
      expect(revoked.grant_id).toBe(purchaseGrant.id);

      const denied = await sourcing.callTool({
        name: 'execute_action',
        arguments: {
          grant_id: purchaseGrant.id,
          action: 'supplier.purchase.execute',
          supplier_id: quote.supplier_id,
          sku_id: quote.sku_id,
          quote_id: quote.quote_id,
          idempotency_key: 'mcp-after-revoke',
        },
      });
      expect(denied.structuredContent).toMatchObject({ status: 'DENIED', code: 'GRANT_REVOKED' });
    } finally {
      for (const { client } of attached) {
        await client.close();
      }
      await new Promise<void>((resolve, reject) => authority.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  });
});

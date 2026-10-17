import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/server.js';

const expectedTools = [
  'provision_child',
  'describe_authority',
  'get_my_grants',
  'request_authority',
  'get_authority_request',
  'respond_authority_request',
  'accept_authority_offer',
  'delegate_authority',
  'execute_action',
  'revoke_authority',
];

const grant = {
  id: 'grant-sourcing-quote',
  organization_id: 'buyer-co',
  issuer_principal_id: 'buyer-agent',
  subject_principal_id: 'sourcing-agent',
  parent_grant_id: 'grant-root-buyer',
  scope: {
    actions: ['supplier.quote.request'],
    supplier_ids: ['supplier-co'],
    sku_ids: ['PACK-500'],
    max_per_action_cents: 0,
    total_budget_cents: 0,
    expires_at: '2026-10-18T17:30:00Z',
    max_delegation_depth: 0,
  },
  revoked_at: null,
};

let mcpServer: ReturnType<typeof createMcpServer>;
let client: Client;
let requests: Array<{ method: string; path: string; authorization: string | null; body: unknown }>;

beforeEach(async () => {
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input.href : String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      authorization: new Headers(init?.headers).get('authorization'),
      body,
    });

    if (init?.method === 'GET' && url.pathname === '/v1/me') {
      return new Response(JSON.stringify({
        status: 'OK',
        data: { principal_id: 'sourcing-agent', organization_id: 'buyer-co', role: 'SOURCING', grants: [grant] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (init?.method === 'POST' && url.pathname === '/v1/grants/grant-root-buyer/delegate') {
      return new Response(JSON.stringify({
        status: 'DENIED',
        code: 'OUTSIDE_PARENT_SCOPE',
        reason: 'Requested scope exceeds the parent grant.',
      }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'unmocked authority route' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }));

  mcpServer = createMcpServer({ authorityUrl: 'http://authority.test', agentApiKey: 'test-sourcing-agent-key' });
  client = new Client({ name: 'agentpass-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await mcpServer.close();
  vi.unstubAllGlobals();
});

describe('AgentPass MCP server', () => {
  it('lists the documented tools and returns only the authenticated caller grants', async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...expectedTools].sort());
    for (const tool of listed.tools) {
      expect((tool.inputSchema.properties as Record<string, unknown>).agent_id).toBeUndefined();
    }

    const result = await client.callTool({ name: 'get_my_grants', arguments: {} });
    expect(result.structuredContent).toEqual({ status: 'OK', data: { grants: [grant] } });
    expect(requests).toContainEqual({
      method: 'GET', path: '/v1/me', authorization: 'Bearer test-sourcing-agent-key', body: undefined,
    });
    const fetchOptions = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(fetchOptions?.redirect).toBe('error');
    expect(fetchOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves a structured authority permission denial over MCP', async () => {
    const result = await client.callTool({
      name: 'delegate_authority',
      arguments: {
        parent_grant_id: 'grant-root-buyer',
        recipient_principal_id: 'sourcing-agent',
        scope: grant.scope,
      },
    });

    expect(result.structuredContent).toEqual({
      status: 'DENIED',
      code: 'OUTSIDE_PARENT_SCOPE',
      reason: 'Requested scope exceeds the parent grant.',
    });
    expect(requests.at(-1)).toEqual({
      method: 'POST',
      path: '/v1/grants/grant-root-buyer/delegate',
      authorization: 'Bearer test-sourcing-agent-key',
      body: { recipient_principal_id: 'sourcing-agent', scope: grant.scope },
    });
  });

  it('rejects identity fields in tool arguments before contacting authority', async () => {
    const before = requests.length;
    const result = await client.callTool({
      name: 'get_my_grants',
      arguments: { agent_id: 'buyer-agent' },
    });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(before);
  });

  it('serves tool discovery and static tools over the configured stdio transport', async () => {
    const stdioClient = new Client({ name: 'agentpass-stdio-test', version: '1.0.0' });
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'apps/mcp/src/server.ts'],
      cwd: process.cwd(),
      env: { AUTHORITY_URL: 'http://authority.test', AGENT_API_KEY: 'test-agent-key' },
      stderr: 'pipe',
    });
    try {
      await stdioClient.connect(stdioTransport);
      const listed = await stdioClient.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...expectedTools].sort());
      const result = await stdioClient.callTool({ name: 'describe_authority', arguments: {} });
      expect(result.structuredContent).toMatchObject({
        status: 'OK',
        data: { actions: ['supplier.quote.request', 'supplier.purchase.execute', 'supplier.margin.read'] },
      });
    } finally {
      await stdioClient.close();
    }
  });
});

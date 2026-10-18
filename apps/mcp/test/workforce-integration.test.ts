import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  createWorkforceFixture,
  listenWorkforceApp,
  workforceChildId,
  workforceKeys,
  workforceResourceId,
  workforceRootId,
} from '../../authority/test/fixtures/workforce.js';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

describe('Manufact workforce tools over MCP HTTP', () => {
  it('negotiates a scoped workforce grant and preserves direct decisions', async () => {
    const fixture = await createWorkforceFixture();
    const authority = await listenWorkforceApp(fixture.app);
    const servers: Server[] = [];
    const clients: Client[] = [];
    const previousAuthorityUrl = process.env.AUTHORITY_URL;
    process.env.AUTHORITY_URL = authority.baseUrl;
    try {
      const bundle = pathToFileURL(`${process.cwd()}/apps/mcp/agentpass-manufact/.mcp-use/build/index.js`).href;
      const { default: adapter } = await import(`${bundle}?workforce=1`);
      const { toNodeHandler } = await import('../agentpass-manufact/node_modules/mcp-use/dist/node-bridge.js');
      const mcp = createServer(toNodeHandler(adapter));
      servers.push(mcp);
      const mcpUrl = `${await listen(mcp)}/mcp`;

      async function connect(token: string) {
        const client = new Client({ name: 'agentpass-workforce-http-test', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
          requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: 'error' },
        }));
        clients.push(client);
        return client;
      }
      const buyer = await connect(workforceKeys['buyer-agent']);
      const sourcing = await connect(workforceKeys['sourcing-agent']);
      const listed = await buyer.listTools();
      expect(listed.tools.map(tool => tool.name)).toContain('verify_authority');
      expect(listed.tools.find(tool => tool.name === 'verify_authority')?.outputSchema).toBeDefined();

      const action = (name: 'deploy.production' | 'deploy.preview', key: string) => ({
        grant_id: workforceChildId,
        action: name,
        resource: workforceResourceId,
        parameters: {
          environment: name === 'deploy.production' ? 'production' : 'preview',
          artifact_digest: 'a'.repeat(64),
        },
        idempotency_key: key,
      });
      const production = await sourcing.callTool({ name: 'verify_authority', arguments: action('deploy.production', 'check-production') });
      expect(production.structuredContent).toMatchObject({
        status: 'DENY', suggested_action: 'deploy.preview', next_action: 'request_authority',
      });
      const deniedProduction = await sourcing.callTool({ name: 'execute_action', arguments: action('deploy.production', 'execute-production') });
      expect(deniedProduction.structuredContent).toMatchObject({ status: 'DENY', suggested_action: 'deploy.preview' });
      expect(fixture.callbackCalls).toHaveLength(0);

      const preview = await sourcing.callTool({ name: 'verify_authority', arguments: action('deploy.preview', 'check-preview') });
      const requiredScope = (preview.structuredContent as { required_scope: Record<string, unknown> }).required_scope;
      expect(preview.structuredContent).toMatchObject({ status: 'AUTHORITY_REQUIRED', next_action: 'request_authority' });
      const request = await sourcing.callTool({ name: 'request_authority', arguments: {
        parent_grant_id: workforceRootId, requested_scope: requiredScope, reason: 'Need preview deployment',
      } });
      const requestId = (request.structuredContent as { data: { request_id: string } }).data.request_id;
      const pending = await sourcing.callTool({ name: 'verify_authority', arguments: action('deploy.preview', 'check-preview-pending') });
      expect(pending.structuredContent).toMatchObject({ status: 'REQUEST_PENDING', request_id: requestId, next_action: 'get_authority_request' });

      const counteroffer = await buyer.callTool({ name: 'respond_authority_request', arguments: {
        request_id: requestId, decision: 'COUNTEROFFER', offered_scope: requiredScope,
      } });
      expect(counteroffer.structuredContent).toMatchObject({ status: 'OK', data: { status: 'COUNTEROFFERED' } });
      const accepted = await sourcing.callTool({ name: 'accept_authority_offer', arguments: {
        request_id: requestId, idempotency_key: 'accept-preview',
      } });
      const grantId = (accepted.structuredContent as { data: { id: string } }).data.id;
      const permitted = await sourcing.callTool({ name: 'verify_authority', arguments: { ...action('deploy.preview', 'check-preview-allowed'), grant_id: grantId } });
      expect(permitted.structuredContent).toMatchObject({ status: 'ALLOW', code: 'AUTHORIZED' });
      expect(fixture.callbackCalls).toHaveLength(0);

      const executed = await sourcing.callTool({ name: 'execute_action', arguments: { ...action('deploy.preview', 'execute-preview'), grant_id: grantId } });
      const result = executed.structuredContent as { status: string; execution_id: string; result: Record<string, unknown> };
      expect(result).toMatchObject({ status: 'ALLOW', result: { simulated: true, action: 'deploy.preview', path_count: 0 } });
      expect(fixture.callbackCalls).toHaveLength(1);
      expect(fixture.callbackCalls[0]).toMatchObject({
        principal: { id: 'sourcing-agent' }, input: { grant_id: grantId, action: 'deploy.preview' }, paths: [],
        execution_id: result.execution_id,
      });
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
      await authority.close();
      await fixture.close();
      if (previousAuthorityUrl === undefined) delete process.env.AUTHORITY_URL;
      else process.env.AUTHORITY_URL = previousAuthorityUrl;
    }
  }, 30000);
});

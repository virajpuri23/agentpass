import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const key = () => randomBytes(32).toString('base64url');
const keys = { OWNER_API_KEY: key(), BUYER_API_KEY: key(), SOURCING_API_KEY: key(), SUPPLIER_API_KEY: key() };
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
let dir: string;
let child: ChildProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentpass-remote-'));
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/remote/src/server.ts'], {
    env: {
      ...process.env,
      ...keys,
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTHORITY_PORT: String(port + 100),
      AUTHORITY_DB_PATH: join(dir, 'authority.sqlite'),
      SUPPLIER_SERVICE_KEY: key(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('remote server did not start');
}, 20_000);

afterAll(() => {
  child?.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
});

async function connect(apiKey: string) {
  const client = new Client({ name: 'remote-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  }));
  return client;
}

async function myGrantIds(client: Client): Promise<string[]> {
  const result = await client.callTool({ name: 'get_my_grants', arguments: {} });
  const body = result.structuredContent as { status: string; data: { grants: { id: string }[] } };
  expect(body.status).toBe('OK');
  return body.data.grants.map((g) => g.id);
}

describe('hosted MCP entry', () => {
  it('serves the platform health check', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'OK' });
  });

  it('rejects MCP requests without a known bearer key', async () => {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    expect((await fetch(`${base}/mcp`, init)).status).toBe(401);
    const unknown = await fetch(`${base}/mcp`, { ...init, headers: { ...init.headers, authorization: `Bearer ${key()}` } });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('lists all AgentPass tools over HTTP', async () => {
    const client = await connect(keys.BUYER_API_KEY);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'accept_authority_offer', 'delegate_authority', 'describe_authority', 'execute_action',
      'get_authority_request', 'get_my_grants', 'get_run', 'list_runs', 'provision_child', 'request_authority', 'respond_authority_request', 'revoke_authority',
    ]);
    await client.close();
  });

  it('binds identity to the bearer key, not tool arguments', async () => {
    const buyer = await connect(keys.BUYER_API_KEY);
    const sourcing = await connect(keys.SOURCING_API_KEY);
    expect(await myGrantIds(buyer)).toContain('grant-root-buyer');
    expect(await myGrantIds(sourcing)).not.toContain('grant-root-buyer');
    await Promise.all([buyer.close(), sourcing.close()]);
  });
});

/**
 * Where the demo's backends come from.
 *  - isolated (default): A's authority + the supplier as real HTTP services on
 *    fresh temp SQLite DBs with freshly generated keys. Always a clean slate.
 *  - services: already-running services from .env (after `npm run demo:reset`).
 *  - hosted: a deployed AgentPass MCP endpoint (HOSTED_MCP_URL) with that
 *    deployment's own buyer/sourcing keys (HOSTED_BUYER_API_KEY, HOSTED_SOURCING_API_KEY).
 * isolated/services can also route agents through Developer A's HTTP MCP app
 * (`--via-http`) instead of the stdio MCP server.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { seedDatabase } from '../db/seed.js';
import { createAuthorityApp } from '../apps/authority/src/app.js';
import { HttpSupplierService } from '../apps/authority/src/supplier.js';
import { createSupplierApp } from '../apps/supplier/src/app.js';
import { createSupplierService } from '../apps/supplier/src/service.js';
import { sqliteStore } from '../apps/supplier/src/store.js';

export type AgentConnection = { authorityUrl: string } | { mcpUrl: string };

export interface DemoStack {
  mode: 'isolated' | 'services' | 'hosted';
  /** How agents reach AgentPass: stdio MCP over authorityUrl, or an HTTP MCP endpoint. */
  connection: AgentConnection;
  authorityUrl: string;
  supplierUrl: string;
  keys: { owner: string; buyer: string; sourcing: string };
  /** Root grant held by buyer-agent for this run. */
  rootGrantId: string;
  stop(): Promise<void>;
}

const listen = (app: { listen: (port: number, host: string, cb: () => void) => Server }) =>
  new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const key = () => randomBytes(32).toString('base64url');

export async function isolatedStack(): Promise<DemoStack> {
  const dir = mkdtempSync(join(tmpdir(), 'agentpass-demo-'));
  const serviceKey = key();
  const keys = { owner: key(), buyer: key(), sourcing: key(), supplierAgent: key() };

  const supplierStore = sqliteStore(join(dir, 'supplier.sqlite'));
  const supplier = await listen(createSupplierApp({ service: createSupplierService({ store: supplierStore }), serviceKey }));

  const db = openDatabase(join(dir, 'authority.sqlite'));
  seedDatabase(db, { 'owner-1': keys.owner, 'buyer-agent': keys.buyer, 'sourcing-agent': keys.sourcing, 'supplier-agent': keys.supplierAgent });
  const authority = await listen(createAuthorityApp({ db, supplier: new HttpSupplierService(urlOf(supplier), serviceKey) }));

  return {
    mode: 'isolated',
    connection: { authorityUrl: urlOf(authority) },
    authorityUrl: urlOf(authority),
    supplierUrl: urlOf(supplier),
    keys: { owner: keys.owner, buyer: keys.buyer, sourcing: keys.sourcing },
    rootGrantId: 'grant-root-buyer',
    async stop() {
      await Promise.all([authority, supplier].map((s) => new Promise((r) => s.close(r))));
      db.close();
      await supplierStore.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function servicesStack(): Promise<DemoStack> {
  const need = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required in .env for --services mode`);
    return v;
  };
  const authorityUrl = need('AUTHORITY_URL');
  const supplierUrl = process.env.SUPPLIER_URL ?? 'http://127.0.0.1:4200';
  for (const [name, url] of [['authority', authorityUrl], ['supplier', supplierUrl]] as const) {
    const ok = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    if (!ok) throw new Error(`${name} is not reachable at ${url}. Start it with npm run dev:${name} (after npm run demo:reset).`);
  }
  return {
    mode: 'services',
    connection: { authorityUrl },
    authorityUrl,
    supplierUrl,
    keys: { owner: need('OWNER_API_KEY'), buyer: need('BUYER_API_KEY'), sourcing: need('SOURCING_API_KEY') },
    rootGrantId: process.env.ROOT_GRANT_ID || 'grant-root-buyer',
    async stop() {},
  };
}

export function hostedStack(): DemoStack {
  const need = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required in .env for --hosted mode (the deployment's own agent keys, shared privately by its operator)`);
    return v;
  };
  const mcpUrl = need('HOSTED_MCP_URL');
  return {
    mode: 'hosted',
    connection: { mcpUrl },
    authorityUrl: '(inside hosted deployment)',
    supplierUrl: '(configured on hosted deployment)',
    keys: { owner: process.env.HOSTED_OWNER_API_KEY ?? '', buyer: need('HOSTED_BUYER_API_KEY'), sourcing: need('HOSTED_SOURCING_API_KEY') },
    // Each hosted $850 run needs a root with budget left; the owner issues a fresh one per run.
    rootGrantId: process.env.HOSTED_ROOT_GRANT_ID || 'grant-root-buyer',
    async stop() {},
  };
}

/**
 * Puts Developer A's HTTP MCP app (apps/mcp/agentpass-manufact, built with
 * `mcp-use build`) in front of a stack's authority so agents use HTTP + bearer
 * keys exactly as against the hosted deployment.
 */
export async function viaHttpMcp(stack: DemoStack): Promise<DemoStack> {
  const port = 3800 + Math.floor(Math.random() * 150);
  const app: ChildProcess = spawn('node_modules/.bin/mcp-use', ['start', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: 'apps/mcp/agentpass-manufact',
    env: { PATH: process.env.PATH, NODE_ENV: 'development', AUTHORITY_URL: stack.authorityUrl },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  app.stderr?.on('data', (d) => { stderr += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) {
      return {
        ...stack,
        connection: { mcpUrl: `${base}/mcp` },
        async stop() { app.kill('SIGTERM'); await stack.stop(); },
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  app.kill('SIGTERM');
  throw new Error(`HTTP MCP app did not start (run npm test once to build it)\n${stderr.slice(-500)}`);
}

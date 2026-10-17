/**
 * Where the demo's backends come from.
 *  - isolated (default): A's authority + the supplier as real HTTP services on
 *    fresh temp SQLite DBs with freshly generated keys. Always a clean slate.
 *  - services: already-running services from .env (after `npm run demo:reset`).
 */
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

export interface DemoStack {
  mode: 'isolated' | 'services';
  authorityUrl: string;
  supplierUrl: string;
  keys: { owner: string; buyer: string; sourcing: string };
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
    authorityUrl: urlOf(authority),
    supplierUrl: urlOf(supplier),
    keys: { owner: keys.owner, buyer: keys.buyer, sourcing: keys.sourcing },
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
    authorityUrl,
    supplierUrl,
    keys: { owner: need('OWNER_API_KEY'), buyer: need('BUYER_API_KEY'), sourcing: need('SOURCING_API_KEY') },
    async stop() {},
  };
}

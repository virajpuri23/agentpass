/**
 * Test fixtures: a throwaway copy of demo-project (no npm install; enough for
 * reads and scans) and a real in-process AgentPass (Developer A's authority on
 * a migrated SQLite) with the demo-project resource registered.
 */
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../../../db/database.js';
import { migrateStore } from '../../../db/migrations.js';
import { seedDatabase } from '../../../db/seed.js';
import { seedWorkforceRoot } from '../../../db/seed-workforce.js';
import { sqliteStore } from '../../../db/store.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import type { SupplierService } from '../../authority/src/supplier.js';
import type { WorkforceOptions } from '../../authority/src/workforce.js';
import { createDemoProjectResource } from '../src/real/resource-adapter.js';

const SOURCE = fileURLToPath(new URL('../../../demo-project/', import.meta.url));

/** A fresh, canonical (realpath'd) copy of demo-project without dependencies. */
export function copyDemoProject(prefix = 'agentpass-wf-'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cpSync(SOURCE, root, { recursive: true, filter: (s) => !/node_modules|\.next/.test(s) });
  return root;
}

export const cred = () => randomBytes(24).toString('base64url');

export interface AgentPassFixture {
  url: string;
  rootGrantId: string;
  keys: { owner: string; lead: string; security: string };
  stop(): Promise<void>;
}

/**
 * Developer A's authority, in-process: owner-1 and buyer-agent (lead) from the admin seed, the external
 * security-agent under sentinel-sec, one owner-issued workforce root to the lead. `workforce` defaults to the
 * in-process demo-project adapter on `root`.
 */
export async function startAgentPass(root: string, workforce?: WorkforceOptions): Promise<AgentPassFixture> {
  const keys = { owner: cred(), lead: cred(), sourcing: cred(), supplierAgent: cred(), security: cred() };
  const dbFile = join(tmpdir(), `agentpass-test-${randomBytes(4).toString('hex')}.sqlite`);
  const db = openDatabase(dbFile);
  const store = sqliteStore(db);
  await migrateStore(store, 'sqlite');
  seedDatabase(db, { 'owner-1': keys.owner, 'buyer-agent': keys.lead, 'sourcing-agent': keys.sourcing, 'supplier-agent': keys.supplierAgent });
  db.prepare('INSERT INTO organizations(id,name) VALUES(?,?)').run('sentinel-sec', 'Sentinel Security (external)');
  db.prepare('INSERT INTO principals(id,organization_id,kind,role) VALUES(?,?,?,?)').run('security-agent', 'sentinel-sec', 'AGENT', 'SERVICE');
  db.prepare('INSERT INTO principal_keys(key_id,principal_id,key_hash) VALUES(?,?,?)').run('seed:security-agent', 'security-agent', createHash('sha256').update(keys.security).digest('hex'));
  const rootGrantId = 'grant-root-lead';
  await seedWorkforceRoot(store, { grant_id: rootGrantId, owner_principal_id: 'owner-1', subject_principal_id: 'buyer-agent', scope: {
    actions: ['repo.read', 'repo.write', 'security.audit.run', 'deploy.preview', 'analytics.aggregate.read'],
    supplier_ids: [], sku_ids: [], max_per_action_cents: 0, total_budget_cents: 0,
    expires_at: new Date(Date.now() + 3600_000).toISOString(), max_delegation_depth: 3,
    resources: [{ resource: 'demo-project', organization_id: 'buyer-co', owner_principal_id: 'owner-1', paths: ['src/', 'package.json'] }],
    max_executions: 200,
  } });
  const adapter = workforce ? undefined : createDemoProjectResource({ repoRoot: root, analyticsFile: join(root, 'data/analytics-events.json'), organization_id: 'buyer-co', owner_principal_id: 'owner-1' });
  const supplier: SupplierService = { async policy() { return false; }, async quote() { throw new Error('unused'); }, async getQuote() { throw new Error('unused'); }, async fulfill() { throw new Error('unused'); } };
  const app = createAuthorityApp({ db: store, supplier, workforce: workforce ?? { resources: [adapter!] } });
  const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, rootGrantId, keys: { owner: keys.owner, lead: keys.lead, security: keys.security },
    async stop() { await adapter?.stop(); await new Promise((r) => server.close(r)); db.close(); rmSync(dbFile, { force: true }); },
  };
}

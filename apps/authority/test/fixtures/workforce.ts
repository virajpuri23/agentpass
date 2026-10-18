import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type express from 'express';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../../db/database.js';
import { seedDatabase } from '../../../../db/seed.js';
import { createAuthorityApp } from '../../src/app.js';
import type { SupplierService } from '../../src/supplier.js';
import type { WorkforceExecutionContext, WorkforceResource } from '../../src/workforce.js';
import { openWorkforceFile } from '../../src/workforce-paths.js';
import { WORKFORCE_ACTIONS, type WorkforceAction, type WorkforceScope } from '../../../../packages/contracts/src/workforce.js';

export const workforceKeys = {
  'owner-1': 'workforce-owner-key',
  'buyer-agent': 'workforce-buyer-key',
  'sourcing-agent': 'workforce-sourcing-key',
  'supplier-agent': 'workforce-supplier-key',
  'worker-2': 'workforce-worker-two-key',
  'security-agent': 'workforce-security-key',
} as const;

export const workforceRootId = 'grant-root-workforce';
export const workforceChildId = 'grant-child-workforce';
export const workforceResourceId = 'demo-project';
export const workforceOrgId = 'buyer-co';
export const workforceOwnerId = 'owner-1';
export const workforceAllowedRootPaths = ['src/', 'backend/', 'security/', 'analytics/', 'README.md'];

export function workforceScope(options: {
  actions?: WorkforceAction[];
  paths?: string[];
  expires_at?: string;
  max_delegation_depth?: number;
  max_executions?: number;
} = {}): WorkforceScope {
  return {
    actions: options.actions ?? [...WORKFORCE_ACTIONS],
    supplier_ids: [],
    sku_ids: [],
    max_per_action_cents: 0,
    total_budget_cents: 0,
    expires_at: options.expires_at ?? '2026-10-19T20:00:00.000Z',
    max_delegation_depth: options.max_delegation_depth ?? 0,
    resources: [{
      resource: workforceResourceId,
      organization_id: workforceOrgId,
      owner_principal_id: workforceOwnerId,
      paths: options.paths ?? workforceAllowedRootPaths,
    }],
    max_executions: options.max_executions ?? 10,
  };
}

export function insertWorkforceGrant(db: Database.Database, input: {
  id: string;
  subject_principal_id: string;
  scope: WorkforceScope;
  parent_grant_id?: string | null;
  issuer_principal_id?: string;
  organization_id?: string;
  created_at?: string;
}): void {
  db.prepare(`INSERT INTO grants
    (id, organization_id, parent_grant_id, issuer_principal_id, subject_principal_id, scope_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(input.id, input.organization_id ?? workforceOrgId, input.parent_grant_id === undefined ? workforceRootId : input.parent_grant_id,
      input.issuer_principal_id ?? 'buyer-agent', input.subject_principal_id, JSON.stringify(input.scope),
      input.created_at ?? '2026-10-17T20:00:00.000Z');
}

export async function createWorkforceFixture(options: {
  maxExecutions?: number;
  execute?: (context: WorkforceExecutionContext) => Promise<Record<string, unknown>>;
} = {}) {
  let now = new Date('2026-10-17T20:00:00.000Z');
  const db = openDatabase(':memory:');
  seedDatabase(db, {
    'owner-1': workforceKeys['owner-1'],
    'buyer-agent': workforceKeys['buyer-agent'],
    'sourcing-agent': workforceKeys['sourcing-agent'],
    'supplier-agent': workforceKeys['supplier-agent'],
  }, now);
  db.prepare('INSERT INTO organizations(id,name) VALUES(?,?)').run('security-co', 'Security Company');
  db.prepare('INSERT INTO principals(id,organization_id,kind,role) VALUES(?,?,?,?)').run('security-agent', 'security-co', 'AGENT', 'SERVICE');
  db.prepare('INSERT INTO principal_keys(key_id,principal_id,key_hash) VALUES(?,?,?)')
    .run('seed:security-agent', 'security-agent', createHash('sha256').update(workforceKeys['security-agent']).digest('hex'));
  db.prepare('INSERT INTO principals(id,organization_id,kind,role) VALUES(?,?,?,?)').run('worker-2', workforceOrgId, 'AGENT', 'SERVICE');
  db.prepare('INSERT INTO principal_keys(key_id,principal_id,key_hash) VALUES(?,?,?)')
    .run('seed:worker-2', 'worker-2', createHash('sha256').update(workforceKeys['worker-2']).digest('hex'));

  const requestedRoot = await mkdtemp(join(tmpdir(), 'agentpass-workforce-'));
  const repoRoot = await realpath(requestedRoot);
  await mkdir(join(repoRoot, 'src'), { recursive: true });
  await mkdir(join(repoRoot, 'backend'), { recursive: true });
  await mkdir(join(repoRoot, 'security'), { recursive: true });
  await mkdir(join(repoRoot, 'analytics'), { recursive: true });
  await writeFile(join(repoRoot, 'src', 'app.ts'), 'export const fixture = true;\n');
  await writeFile(join(repoRoot, 'src', 'other.ts'), 'export const other = true;\n');
  await writeFile(join(repoRoot, 'backend', 'server.ts'), 'export const backend = true;\n');
  await writeFile(join(repoRoot, 'security', 'audit-policy.json'), '{"severity":"high"}\n');
  await writeFile(join(repoRoot, 'analytics', 'raw.json'), '{"private":"raw fixture data"}\n');
  await writeFile(join(repoRoot, 'README.md'), 'workforce fixture\n');
  await writeFile(join(repoRoot, '.env'), 'WORKFORCE_FIXTURE_SECRET=must-not-return\n');
  await symlink('app.ts', join(repoRoot, 'src', 'linked.ts'));

  const rootScope = workforceScope({
    actions: WORKFORCE_ACTIONS.filter(action => action !== 'deploy.production' && action !== 'analytics.raw.read'),
    expires_at: '2026-10-21T20:00:00.000Z', max_delegation_depth: 4, max_executions: options.maxExecutions ?? 50,
  });
  insertWorkforceGrant(db, {
    id: workforceRootId,
    parent_grant_id: null,
    issuer_principal_id: workforceOwnerId,
    subject_principal_id: 'buyer-agent',
    scope: rootScope,
  });
  insertWorkforceGrant(db, {
    id: workforceChildId,
    subject_principal_id: 'sourcing-agent',
    scope: workforceScope({ actions: ['repo.read'], paths: ['src/'], max_delegation_depth: 2, max_executions: Math.min(20, options.maxExecutions ?? 50) }),
  });

  const callbackCalls: WorkforceExecutionContext[] = [];
  const resource: WorkforceResource = {
    resource: workforceResourceId,
    organization_id: workforceOrgId,
    owner_principal_id: workforceOwnerId,
    repo_root: repoRoot,
    allowed_actions: ['repo.read', 'repo.write', 'security.audit.run', 'deploy.preview', 'analytics.aggregate.read'],
    execute: async context => {
      callbackCalls.push(context);
      if (options.execute) return options.execute(context);
      if (context.input.action === 'repo.read') {
        const file = await openWorkforceFile(repoRoot, context.input.parameters.path);
        try { return { simulated: true, content: await file.readFile('utf8') }; }
        finally { await file.close(); }
      }
      if (context.input.action === 'repo.write') {
        const file = await openWorkforceFile(repoRoot, context.input.parameters.path, true);
        try { await file.writeFile(context.input.parameters.content, 'utf8'); }
        finally { await file.close(); }
        return { simulated: true, written: true };
      }
      if (context.input.action === 'analytics.aggregate.read') return { simulated: true, metric: context.input.parameters.metric, count: 3 };
      return { simulated: true, action: context.input.action, path_count: context.paths.length };
    },
  };
  const supplier: SupplierService = {
    async policy() { return false; },
    async quote() { throw new Error('Supplier is unused in workforce tests'); },
    async getQuote() { throw new Error('Supplier is unused in workforce tests'); },
    async fulfill() { throw new Error('Supplier is unused in workforce tests'); },
  };
  const app = createAuthorityApp({ db, supplier, now: () => new Date(now), workforce: { resources: [resource] } });
  return {
    app,
    db,
    repoRoot,
    callbackCalls,
    setNow(value: Date) { now = new Date(value); },
    async close() { db.close(); await rm(requestedRoot, { recursive: true, force: true }); },
  };
}

export async function listenWorkforceApp(app: express.Express): Promise<{ server: Server; baseUrl: string; close(): Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

export async function workforceRequest(baseUrl: string, path: string, body: unknown | undefined, token: string) {
  const response = await fetch(baseUrl + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { http: response.status, body: await response.json() as Record<string, any> };
}

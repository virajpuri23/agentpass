import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';

interface SeedScenario {
  organizations: { id: string; name: string }[];
  principals: { id: string; organization_id: string; kind: string; role: string }[];
  root_grant: {
    id: string;
    issuer_principal_id: string;
    subject_principal_id: string;
    organization_id: string;
    scope: {
      actions: string[];
      supplier_ids: string[];
      sku_ids: string[];
      max_per_action_cents: number;
      total_budget_cents: number;
      expires_after_seconds: number;
      max_delegation_depth: number;
    };
  };
}

const scenario = JSON.parse(readFileSync(new URL('../fixtures/seed-scenario.json', import.meta.url), 'utf8')) as SeedScenario;

export function seedDatabase(db: Database.Database, keys: Record<string, string>, now = new Date()): void {
  const seed = db.transaction(() => {
    for (const organization of scenario.organizations) {
      db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
        .run(organization.id, organization.name);
    }

    const principalIds = new Set(scenario.principals.map(({ id }) => id));
    for (const principal of scenario.principals) {
      db.prepare(`INSERT INTO principals (id, organization_id, kind, role)
        VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
        .run(principal.id, principal.organization_id, principal.kind, principal.role);
    }

    const insertKey = db.prepare(`INSERT INTO principal_keys (key_id, principal_id, key_hash)
      VALUES (?, ?, ?) ON CONFLICT(key_id) DO NOTHING`);
    for (const [principalId, rawKey] of Object.entries(keys)) {
      if (!principalIds.has(principalId) || !rawKey) throw new Error(`Invalid seed key for principal: ${principalId}`);
      insertKey.run(`seed:${principalId}`, principalId, createHash('sha256').update(rawKey).digest('hex'));
    }

    const { root_grant: root } = scenario;
    const scope = {
      actions: root.scope.actions,
      supplier_ids: root.scope.supplier_ids,
      sku_ids: root.scope.sku_ids,
      max_per_action_cents: root.scope.max_per_action_cents,
      total_budget_cents: root.scope.total_budget_cents,
      expires_at: new Date(now.getTime() + root.scope.expires_after_seconds * 1000).toISOString(),
      max_delegation_depth: root.scope.max_delegation_depth,
    };
    db.prepare(`INSERT INTO grants
      (id, organization_id, parent_grant_id, issuer_principal_id, subject_principal_id, scope_json, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(root.id, root.organization_id, root.issuer_principal_id, root.subject_principal_id, JSON.stringify(scope), now.toISOString());
  });

  seed.immediate();
}

const keyVariables: Record<string, string> = {
  'owner-1': 'OWNER_API_KEY',
  'buyer-agent': 'BUYER_API_KEY',
  'sourcing-agent': 'SOURCING_API_KEY',
  'supplier-agent': 'SUPPLIER_API_KEY',
};

function seedFromCli(): void {
  const envPath = resolve('.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const additions: string[] = [];
  const keys: Record<string, string> = {};

  for (const [principalId, variable] of Object.entries(keyVariables)) {
    const fileValue = envText.match(new RegExp(`^${variable}=(.*)$`, 'm'))?.[1]?.trim().replace(/^("|')(.*)\1$/, '$2');
    const key = process.env[variable] || fileValue || randomBytes(32).toString('base64url');
    keys[principalId] = key;
    if (!process.env[variable] && !fileValue) additions.push(`${variable}=${key}`);
  }

  if (additions.length) {
    if (existsSync(envPath)) chmodSync(envPath, 0o600);
    appendFileSync(envPath, `${envText && !envText.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`, { mode: 0o600 });
  }
  const db = openDatabase(process.env.AUTHORITY_DB_PATH || './authority.sqlite');
  try {
    seedDatabase(db, keys);
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) seedFromCli();

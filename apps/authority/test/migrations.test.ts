import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { assertMigrationsCurrent, migrateStore } from '../../../db/migrations.js';
import { sqliteStore } from '../../../db/store.js';
import { seedDatabase } from '../../../db/seed.js';

describe('seed-free ordered schema migrations', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('creates an unmigrated demo-free SQLite database and records an idempotent ordered version', () => {
    directory = mkdtempSync(join(tmpdir(), 'agentpass-migrate-'));
    const database = join(directory, 'authority.sqlite');
    const script = fileURLToPath(new URL('../../../db/migrate.ts', import.meta.url));
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const env = { ...process.env, AUTHORITY_DB_PATH: database, OWNER_API_KEY: '', BUYER_API_KEY: '', SOURCING_API_KEY: '', SUPPLIER_API_KEY: '' };
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', script, '--target', 'sqlite'], { cwd: repository, encoding: 'utf8', env });

    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const firstResult = JSON.parse(first.stdout) as { status: string; target: string; applied: string[] };
    expect(firstResult).toMatchObject({ status: 'OK', target: 'sqlite' });
    expect(firstResult.applied).toContain('20261017233948_onboarding_accounts');
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ status: 'OK', target: 'sqlite', applied: [] });

    const db = openDatabase(database);
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(firstResult.applied.length);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principals').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM grants').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });

  it('preserves existing keys, grants and audit rows when applying the additive migration', async () => {
    directory = mkdtempSync(join(tmpdir(), 'agentpass-migrate-preserve-'));
    const db = openDatabase(join(directory, 'authority.sqlite'));
    try {
      seedDatabase(db, { 'owner-1': 'fixture-owner-key', 'buyer-agent': 'fixture-buyer-key', 'sourcing-agent': 'fixture-source-key', 'supplier-agent': 'fixture-seller-key' }, new Date('2026-10-17T23:00:00.000Z'));
      const before = {
        principals: (db.prepare('SELECT COUNT(*) AS n FROM principals').get() as { n: number }).n,
        keys: (db.prepare('SELECT COUNT(*) AS n FROM principal_keys').get() as { n: number }).n,
        grants: (db.prepare('SELECT COUNT(*) AS n FROM grants').get() as { n: number }).n,
        audit: (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n,
      };
      const applied = await migrateStore(sqliteStore(db), 'sqlite');
      expect(applied).toContain('20261017233948_onboarding_accounts');
      expect({
        principals: (db.prepare('SELECT COUNT(*) AS n FROM principals').get() as { n: number }).n,
        keys: (db.prepare('SELECT COUNT(*) AS n FROM principal_keys').get() as { n: number }).n,
        grants: (db.prepare('SELECT COUNT(*) AS n FROM grants').get() as { n: number }).n,
        audit: (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n,
      }).toEqual(before);
      expect(await migrateStore(sqliteStore(db), 'sqlite')).toEqual([]);
    } finally { db.close(); }
  });

  it('checks the recorded migration inventory without writing and rejects a stale checksum', async () => {
    const db = openDatabase(':memory:');
    const store = sqliteStore(db);
    try {
      await migrateStore(store, 'sqlite');
      const appliedBefore = db.prepare('SELECT version,applied_at FROM schema_migrations ORDER BY version').all();
      await expect(assertMigrationsCurrent(store, 'sqlite')).resolves.toBeUndefined();
      expect(db.prepare('SELECT version,applied_at FROM schema_migrations ORDER BY version').all()).toEqual(appliedBefore);

      db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run('0'.repeat(64), (appliedBefore[0] as { version: string }).version);
      await expect(assertMigrationsCurrent(store, 'sqlite')).rejects.toThrow(/migrations are missing or changed/);
      expect((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count).toBe(appliedBefore.length);
    } finally { db.close(); }
  });

  it('rejects a missing or unsupported target without opening or seeding a database', () => {
    directory = mkdtempSync(join(tmpdir(), 'agentpass-migrate-invalid-'));
    const script = fileURLToPath(new URL('../../../db/migrate.ts', import.meta.url));
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { cwd: repository, encoding: 'utf8', env: { ...process.env, AUTHORITY_DB_PATH: join(directory!, 'must-not-exist.sqlite') } });
    expect(run(['--target', 'other']).status).toBe(1);
    expect(run([]).status).toBe(1);
    expect(existsSync(join(directory, 'must-not-exist.sqlite'))).toBe(false);
  });
});

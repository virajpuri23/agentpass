import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthorityStore } from './store.js';

export type MigrationTarget = 'sqlite' | 'postgres';

function migrationFiles(target: MigrationTarget) {
  const directory = fileURLToPath(new URL(`./migrations/${target}/`, import.meta.url));
  return readdirSync(directory).filter(file => file.endsWith('.sql')).sort().map(file => ({
    version: file.slice(0, -4),
    sql: readFileSync(join(directory, file), 'utf8'),
  }));
}

export async function migrateStore(db: AuthorityStore, target: MigrationTarget, now = () => new Date()): Promise<string[]> {
  const history = target === 'postgres'
    ? `CREATE TABLE IF NOT EXISTS agentpass.schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
       ALTER TABLE agentpass.schema_migrations ENABLE ROW LEVEL SECURITY;
       REVOKE ALL ON TABLE agentpass.schema_migrations FROM PUBLIC;`
    : 'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)';
  await db.transaction(() => db.exec(history)).immediate();

  const table = target === 'postgres' ? 'agentpass.schema_migrations' : 'schema_migrations';
  const applied: string[] = [];
  for (const migration of migrationFiles(target)) {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    await db.transaction(async () => {
      const existing = await db.prepare(`SELECT checksum FROM ${table} WHERE version=?`).get(migration.version) as { checksum: string } | undefined;
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration ${migration.version} was changed`);
        return;
      }
      await db.exec(migration.sql);
      await db.prepare(`INSERT INTO ${table}(version,checksum,applied_at) VALUES(?,?,?)`).run(migration.version, checksum, now().toISOString());
      applied.push(migration.version);
    }).immediate();
  }
  return applied;
}

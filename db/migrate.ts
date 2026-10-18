import { openDatabase } from './database.js';
import { migrateStore, type MigrationTarget } from './migrations.js';
import { postgresStore } from './postgres.js';
import { sqliteStore } from './store.js';

function targetArg(args: string[]): MigrationTarget {
  if (args.length !== 2 || args[0] !== '--target' || !['sqlite', 'postgres'].includes(args[1])) {
    throw new Error('Usage: npm run db:migrate -- --target <sqlite|postgres>');
  }
  return args[1] as MigrationTarget;
}

async function main() {
  const target = targetArg(process.argv.slice(2));
  if (target === 'sqlite') {
    const db = openDatabase(process.env.AUTHORITY_DB_PATH || './authority.sqlite');
    try {
      const applied = await migrateStore(sqliteStore(db), target);
      console.log(JSON.stringify({ status: 'OK', target, applied }));
    } finally { db.close(); }
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for --target postgres');
  const db = postgresStore(process.env.DATABASE_URL);
  try {
    await db.migrate();
    const applied = await migrateStore(db.store, target);
    console.log(JSON.stringify({ status: 'OK', target, applied }));
  } finally { await db.close(); }
}

main().catch(() => {
  console.error(JSON.stringify({ status: 'ERROR', code: 'MIGRATION_FAILED', reason: 'Schema migration failed' }));
  process.exitCode = 1;
});

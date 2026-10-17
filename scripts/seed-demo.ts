/**
 * npm run demo:reset: restore the local demo scenario for --services mode.
 *  - Recreates the authority DB (AUTHORITY_DB_PATH) and seeds principals + the
 *    $1,000 root grant with the keys in .env (A's seed routine).
 *  - Resets the supplier (quotes/orders cleared, PACK-500 stock 1000) in the
 *    same store dev:supplier uses: Supabase when SUPPLIER_DATABASE_URL is set
 *    (needs DATABASE_CA_CERT), otherwise SUPPLIER_DB_PATH (SQLite).
 * Refuses to run while the services are up, since they hold the DB files open.
 * (`npm run demo:run` without --services needs no reset: it uses fresh temp DBs.)
 */
import { existsSync, rmSync } from 'node:fs';
import { openDatabase } from '../db/database.js';
import { seedDatabase } from '../db/seed.js';
import { storeFromEnv } from '../apps/supplier/src/store.js';

async function up(url: string | undefined) {
  if (!url) return false;
  return fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
}

const authorityUrl = process.env.AUTHORITY_URL;
const supplierUrl = process.env.SUPPLIER_URL ?? 'http://127.0.0.1:4200';
if (await up(authorityUrl) || await up(supplierUrl)) {
  console.error('Stop dev:authority and dev:supplier before resetting (they hold the database files open).');
  process.exit(1);
}

const keys: Record<string, string> = {};
for (const [principal, name] of [['owner-1', 'OWNER_API_KEY'], ['buyer-agent', 'BUYER_API_KEY'], ['sourcing-agent', 'SOURCING_API_KEY'], ['supplier-agent', 'SUPPLIER_API_KEY']]) {
  const value = process.env[name!];
  if (!value) {
    console.error(`${name} missing from .env; run npm run seed:authority once to provision keys.`);
    process.exit(1);
  }
  keys[principal!] = value;
}

const authorityPath = process.env.AUTHORITY_DB_PATH ?? './authority.sqlite';
for (const suffix of ['', '-wal', '-shm']) if (existsSync(authorityPath + suffix)) rmSync(authorityPath + suffix);
const db = openDatabase(authorityPath);
seedDatabase(db, keys);
db.close();
console.log(`authority: recreated ${authorityPath}, seeded principals and grant-root-buyer ($1,000, 24h)`);

const store = storeFromEnv();
await store.reset();
await store.close();
console.log(`supplier: ${process.env.SUPPLIER_DATABASE_URL ? 'Supabase supplier schema' : process.env.SUPPLIER_DB_PATH ?? './supplier.sqlite'} reset (quotes/orders cleared, PACK-500 stock 1000)`);

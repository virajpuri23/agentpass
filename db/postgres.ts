import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import type { AuthorityStore } from './store.js';

export function postgresStore(connectionString: string) {
  const url = new URL(connectionString);
  for (const key of ['sslmode','sslcert','sslkey','sslrootcert','options']) url.searchParams.delete(key);
  const pool = new Pool({ connectionString: url.href, max: 5, options: '-c search_path=agentpass', connectionTimeoutMillis: 5000,
    ssl: process.env.NODE_ENV === 'production' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? {ca:process.env.DATABASE_CA_CERT} : {}) } : undefined,
  });
  const transaction = new AsyncLocalStorage<PoolClient>();
  async function query(sql: string, params: any[] = []) {
    let index = 0;
    const text = sql.replace(/\?/g, () => `$${++index}`).replace(/\browid\b/g, 'sequence_id');
    return (transaction.getStore() ?? pool).query(text, params);
  }
  const store: AuthorityStore = {
    prepare(sql) {
      return {
        get: async (...params) => (await query(sql,params)).rows[0],
        all: async (...params) => (await query(sql,params)).rows,
        run: async (...params) => query(sql,params),
      };
    },
    transaction(fn) {
      return { immediate: async () => {
        if (transaction.getStore()) throw new Error('Nested authority transaction');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout = '5s'");
          // One shared transaction lock preserves SQLite's original writer ordering across replicas.
          await client.query('SELECT pg_advisory_xact_lock(1735289201)');
          const value = await transaction.run(client,fn);
          await client.query('COMMIT');
          return value;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      } };
    },
  };
  return { store, migrate: () => pool.query(readFileSync(new URL('./schema.postgres.sql',import.meta.url),'utf8')), close: () => pool.end() };
}

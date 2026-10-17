import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';

export interface AuthorityStore {
  prepare(sql: string): {
    get(...params: any[]): Promise<any>;
    all(...params: any[]): Promise<any[]>;
    run(...params: any[]): Promise<unknown>;
  };
  transaction<T>(fn: () => Promise<T>): { immediate(): Promise<T> };
}

const sqliteLocks = new Map<string | Database.Database, {owner:AsyncLocalStorage<boolean>;pending:Promise<unknown>}>();

// Serialize SQLite operations across awaits so a second request cannot join a transaction.
export function sqliteStore(db: Database.Database): AuthorityStore {
  const key = db.name === ':memory:' ? db : db.name;
  let lock = sqliteLocks.get(key);
  if (!lock) {lock = {owner:new AsyncLocalStorage<boolean>(),pending:Promise.resolve()};sqliteLocks.set(key,lock);}
  const state = lock;
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (state.owner.getStore()) return fn();
    const result = state.pending.then(() => state.owner.run(true, fn));
    state.pending = result.catch(() => undefined);
    return result;
  }
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get: (...params) => exclusive(async () => statement.get(...params)),
        all: (...params) => exclusive(async () => statement.all(...params)),
        run: (...params) => exclusive(async () => statement.run(...params)),
      };
    },
    transaction(fn) {
      return { immediate: () => exclusive(async () => {
        db.exec('BEGIN IMMEDIATE');
        try { const result = await fn(); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }) };
    },
  };
}

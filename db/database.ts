import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(schema);

  const purchaseColumns = db.prepare('PRAGMA table_info(purchases)').all() as { name: string }[];
  if (!purchaseColumns.some(({ name }) => name === 'request_json')) {
    db.exec("ALTER TABLE purchases ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(request_json))");
  }

  return db;
}

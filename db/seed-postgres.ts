import { openDatabase } from './database.js';
import { postgresStore } from './postgres.js';
import { seedDatabase } from './seed.js';

export async function seedPostgres(target: ReturnType<typeof postgresStore>, keys: Record<string,string>) {
  const fixture = openDatabase(':memory:');
  try {
    seedDatabase(fixture,keys);
    await target.store.transaction(async () => {
      for (const table of ['organizations','principals','principal_keys','grants']) {
        for (const row of fixture.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[]) {
          const columns = Object.keys(row);
          await target.store.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`).run(...Object.values(row));
        }
      }
    }).immediate();
  } finally { fixture.close(); }
}

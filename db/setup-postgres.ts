import { postgresStore } from './postgres.js';
import { seedPostgres } from './seed-postgres.js';

import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const names = {'owner-1':'OWNER_API_KEY','buyer-agent':'BUYER_API_KEY','sourcing-agent':'SOURCING_API_KEY','supplier-agent':'SUPPLIER_API_KEY'};
if (!process.env.DATABASE_URL || Object.values(names).some(name => !process.env[name])) throw new Error('DATABASE_URL and all four provisioned agent keys are required in the private environment.');
const db = postgresStore(process.env.DATABASE_URL);
try {
  await db.migrate();
  await seedPostgres(db,Object.fromEntries(Object.entries(names).map(([id,name]) => [id,process.env[name]!])));
  console.log('AgentPass private PostgreSQL schema and seed ready; existing state preserved.');
} finally { await db.close(); }

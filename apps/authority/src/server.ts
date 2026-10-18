import { postgresStore } from '../../../db/postgres.js';
import { openDatabase } from '../../../db/database.js';
import { createAuthorityApp } from './app.js';
import { HttpSupplierService } from './supplier.js';
import { onboardingFromEnvironment,assertOAuthResourceBindings } from './onboarding-config.js';
import { assertMigrationsCurrent } from '../../../db/migrations.js';
import { sqliteStore } from '../../../db/store.js';
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
const postgres = process.env.DATABASE_URL ? postgresStore(process.env.DATABASE_URL) : undefined;
const db = postgres?.store ?? openDatabase(required('AUTHORITY_DB_PATH'));
const supplier = new HttpSupplierService(required('SUPPLIER_URL'),required('SUPPLIER_SERVICE_KEY'));
const port = Number(process.env.AUTHORITY_PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid AUTHORITY_PORT');
const onboarding=onboardingFromEnvironment();
if(onboarding.verifyHumanToken){
  const store='pragma' in db?sqliteStore(db):db;
  await assertMigrationsCurrent(store,postgres?'postgres':'sqlite');await assertOAuthResourceBindings(store);
}
const server = createAuthorityApp({db,supplier,...onboarding}).listen(port,process.env.AUTHORITY_HOST ?? '127.0.0.1',() => console.log(JSON.stringify({service:'authority',port,simulated:true})));
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => server.close(async () => {if(postgres) await postgres.close();else if('close' in db) db.close();process.exit(0);}));

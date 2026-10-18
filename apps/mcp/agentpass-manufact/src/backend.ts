import { postgresStore } from '../../../../db/postgres.js';
import { createAuthorityApp } from '../../../authority/src/app.js';
import { HttpSupplierService } from '../../../authority/src/supplier.js';
import { createSupplierApp } from '../../../supplier/src/app.js';
import { createSupplierService } from '../../../supplier/src/service.js';
import { postgresStore as supplierPostgresStore } from '../../../supplier/src/store.js';
import { onboardingFromEnvironment,assertOAuthResourceBindings } from '../../../authority/src/onboarding-config.js';
import { assertMigrationsCurrent } from '../../../../db/migrations.js';
import type { Server } from 'node:http';

async function listen(app: ReturnType<typeof createAuthorityApp>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {server.once('listening', resolve); server.once('error', reject);});
  return {server, url: `http://127.0.0.1:${(server.address() as {port:number}).port}`};
}

export async function authorityEndpoint(): Promise<string> {
  if (!process.env.DATABASE_URL) {
    if (!process.env.AUTHORITY_URL) throw new Error('AUTHORITY_URL or DATABASE_URL is required.');
    return process.env.AUTHORITY_URL;
  }
  if (process.env.AUTHORITY_URL) throw new Error('Configure either DATABASE_URL (embedded authority) or AUTHORITY_URL (external authority).');
  const onboarding = onboardingFromEnvironment();
  let supplierUrl = process.env.SUPPLIER_URL;
  const serviceKey = process.env.SUPPLIER_SERVICE_KEY;
  if (!serviceKey) throw new Error('SUPPLIER_SERVICE_KEY is required for embedded authority.');
  if (supplierUrl && process.env.NODE_ENV === 'production' && new URL(supplierUrl).protocol !== 'https:') throw new Error('The external hosted supplier service must use HTTPS.');
  if (!supplierUrl && !process.env.SUPPLIER_DATABASE_URL) throw new Error('SUPPLIER_URL or SUPPLIER_DATABASE_URL is required.');
  const db = postgresStore(process.env.DATABASE_URL);
  let supplierStore: ReturnType<typeof supplierPostgresStore> | undefined;
  const servers: Server[] = [];
  let stopReconciliation:(()=>Promise<void>)|undefined;
  const close = async () => {
    await stopReconciliation?.();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await Promise.all([db.close(), supplierStore?.close()]);
  };
  try {
    await db.store.prepare('SELECT 1 FROM agentpass.principals LIMIT 1').get();
    if (onboarding.verifyHumanToken) {await assertMigrationsCurrent(db.store, 'postgres');await assertOAuthResourceBindings(db.store);}
    if (!supplierUrl) {
      supplierStore = supplierPostgresStore(process.env.SUPPLIER_DATABASE_URL!);
      if (!await supplierStore.getProduct('PACK-500')) throw new Error('Supplier catalog is not initialized.');
      const supplier = await listen(createSupplierApp({service:createSupplierService({store:supplierStore}),serviceKey}));
      servers.push(supplier.server);
      supplierUrl = supplier.url;
    }
    const app=createAuthorityApp({db:db.store,supplier:new HttpSupplierService(supplierUrl,serviceKey),...onboarding});
    stopReconciliation=await app.locals.agentControl?.startReconciliation();
    const authority = await listen(app);
    servers.push(authority.server);
    process.once('SIGTERM', () => {void close();});process.once('SIGINT', () => {void close();});
    return authority.url;
  } catch (error) { await close(); throw error; }
}

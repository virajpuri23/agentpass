import { postgresStore } from '../../../../db/postgres.js';
import { createAuthorityApp } from '../../../authority/src/app.js';
import { HttpSupplierService } from '../../../authority/src/supplier.js';

export async function authorityEndpoint(): Promise<string> {
  if (!process.env.DATABASE_URL) {
    if (!process.env.AUTHORITY_URL) throw new Error('AUTHORITY_URL or DATABASE_URL is required.');
    return process.env.AUTHORITY_URL;
  }
  if (process.env.AUTHORITY_URL) throw new Error('Configure either DATABASE_URL (embedded authority) or AUTHORITY_URL (external authority).');
  const supplierUrl = process.env.SUPPLIER_URL;
  const serviceKey = process.env.SUPPLIER_SERVICE_KEY;
  if (!supplierUrl || !serviceKey) throw new Error('SUPPLIER_URL and SUPPLIER_SERVICE_KEY are required for embedded authority.');
  if (process.env.NODE_ENV === 'production' && new URL(supplierUrl).protocol !== 'https:') throw new Error('The hosted supplier service must use HTTPS.');
  const db = postgresStore(process.env.DATABASE_URL);
  try {
    await db.store.prepare('SELECT 1 FROM agentpass.principals LIMIT 1').get();
    const server = createAuthorityApp({db:db.store,supplier:new HttpSupplierService(supplierUrl,serviceKey)}).listen(0,'127.0.0.1');
    await new Promise<void>((resolve,reject) => {server.once('listening',resolve);server.once('error',reject);});
    const close = () => server.close(() => {void db.close();});
    process.once('SIGTERM',close);process.once('SIGINT',close);
    return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  } catch (error) { await db.close(); throw error; }
}

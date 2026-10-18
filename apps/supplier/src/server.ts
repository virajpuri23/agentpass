import { createSupplierApp } from './app.js';
import { supplierMcpHandler } from './mcp.js';
import { createSupplierService } from './service.js';
import { storeFromEnv } from './store.js';

const serviceKey = process.env.SUPPLIER_SERVICE_KEY;
if (!serviceKey) throw new Error('SUPPLIER_SERVICE_KEY is required');
const port = Number(process.env.SUPPLIER_PORT ?? process.env.PORT ?? 4200);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SUPPLIER_PORT');
const host = process.env.SUPPLIER_HOST ?? '127.0.0.1';

const store = storeFromEnv();
const service = createSupplierService({ store });
const app = createSupplierApp({
  service,
  serviceKey,
  healthCheck: () => store.getProduct('PACK-500'),
  mcp: supplierMcpHandler(store),
});
const backend = process.env.SUPPLIER_DATABASE_URL ? 'postgres' : 'sqlite';

const server = app.listen(port, host, () => console.log(JSON.stringify({ service: 'supplier', port, storage: backend, simulated: true })));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => void store.close().finally(() => process.exit(0))));
}

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSupplierApp } from '../src/app.js';
import { createSupplierService } from '../src/service.js';
import { postgresStore, sqliteStore, type SupplierStore } from '../src/store.js';

export const SERVICE_KEY = 'test-service-key-1234567890';
export const quoteInput = (over: Record<string, unknown> = {}) => ({
  buyer_principal_id: 'sourcing-agent',
  supplier_id: 'supplier-co',
  sku_id: 'PACK-500',
  quantity: 500,
  request_id: `q-${Math.random().toString(36).slice(2)}`,
  ...over,
});

/** Backends to run each suite against: SQLite always, Postgres when a test DB URL is given. */
export const backends: { name: string; make: () => SupplierStore }[] = [
  { name: 'sqlite', make: () => sqliteStore(':memory:') },
  ...(process.env.SUPPLIER_TEST_DATABASE_URL
    ? [{ name: 'postgres', make: () => postgresStore(process.env.SUPPLIER_TEST_DATABASE_URL!) }]
    : []),
];

export async function startSupplier(store: SupplierStore, opts: { now?: () => Date } = {}) {
  await store.reset();
  const service = createSupplierService({ store, now: opts.now });
  const app = createSupplierApp({ service, serviceKey: SERVICE_KEY });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown, key: string | null = SERVICE_KEY) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { 'x-service-key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  }

  return {
    base,
    call,
    store,
    async stop() {
      await new Promise((r) => server.close(r));
      await store.close();
    },
  };
}

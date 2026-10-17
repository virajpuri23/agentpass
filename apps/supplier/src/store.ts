/**
 * Supplier private storage. Two backends behind one async interface:
 *  - Postgres (Supabase `supplier` schema) when SUPPLIER_DATABASE_URL is set
 *  - SQLite (local dev / tests) otherwise
 * Rows here include private fields; only public-view.ts may shape responses.
 */
import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';

export interface CatalogRow {
  sku_id: string;
  product_name: string;
  stock_quantity: number;
  public_unit_price_cents: number;
  internal_unit_cost_cents: number; // PRIVATE
  active: boolean;
}

export interface QuoteRow {
  id: string;
  request_id: string;
  supplier_id: string;
  sku_id: string;
  buyer_principal_id: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  currency: 'USD';
  expires_at: string;
  created_at: string;
}

export interface OrderRow {
  id: string;
  request_id: string;
  quote_id: string;
  buyer_principal_id: string;
  status: 'COMPLETED';
  created_at: string;
}

export type FulfillResult =
  | { kind: 'CREATED' | 'REPLAYED'; order: OrderRow }
  | { kind: 'QUOTE_ALREADY_ORDERED' | 'OUT_OF_STOCK' };

export interface SupplierStore {
  getProduct(skuId: string): Promise<CatalogRow | undefined>;
  getQuote(id: string): Promise<QuoteRow | undefined>;
  getQuoteByRequest(requestId: string): Promise<QuoteRow | undefined>;
  /** Inserts unless request_id exists; returns the stored row either way. */
  insertQuote(quote: QuoteRow): Promise<QuoteRow>;
  getOrderByRequest(requestId: string): Promise<OrderRow | undefined>;
  /** Atomically: replay by request_id, or decrement stock and create one order per quote. */
  fulfill(order: OrderRow, quantity: number, skuId: string): Promise<FulfillResult>;
  /** Demo reset: clear quotes/orders and restore stock. */
  reset(stock?: number): Promise<void>;
  close(): Promise<void>;
}

const SEED = {
  sku_id: 'PACK-500',
  product_name: 'Packaging units',
  stock_quantity: 1000,
  public_unit_price_cents: 170,
  internal_unit_cost_cents: 100,
};

// ---------------------------------------------------------------- SQLite

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS catalog (
  sku_id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  stock_quantity INTEGER NOT NULL CHECK (stock_quantity >= 0),
  public_unit_price_cents INTEGER NOT NULL CHECK (public_unit_price_cents > 0),
  internal_unit_cost_cents INTEGER NOT NULL CHECK (internal_unit_cost_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  supplier_id TEXT NOT NULL,
  sku_id TEXT NOT NULL REFERENCES catalog(sku_id),
  buyer_principal_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  total_cents INTEGER NOT NULL CHECK (total_cents = quantity * unit_price_cents),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
  buyer_principal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED')),
  created_at TEXT NOT NULL
);`;

export function sqliteStore(path: string): SupplierStore {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SQLITE_SCHEMA);
  db.prepare(`INSERT INTO catalog (sku_id, product_name, stock_quantity, public_unit_price_cents, internal_unit_cost_cents)
    VALUES (@sku_id, @product_name, @stock_quantity, @public_unit_price_cents, @internal_unit_cost_cents)
    ON CONFLICT(sku_id) DO NOTHING`).run(SEED);

  const toCatalog = (r: any): CatalogRow | undefined => (r ? { ...r, active: Boolean(r.active) } : undefined);

  const fulfillTx = db.transaction((order: OrderRow, quantity: number, skuId: string): FulfillResult => {
    const replay = db.prepare('SELECT * FROM orders WHERE request_id = ?').get(order.request_id) as OrderRow | undefined;
    if (replay) return { kind: 'REPLAYED', order: replay };
    if (db.prepare('SELECT 1 FROM orders WHERE quote_id = ?').get(order.quote_id)) return { kind: 'QUOTE_ALREADY_ORDERED' };
    const stock = db.prepare('UPDATE catalog SET stock_quantity = stock_quantity - ? WHERE sku_id = ? AND stock_quantity >= ?')
      .run(quantity, skuId, quantity);
    if (stock.changes !== 1) return { kind: 'OUT_OF_STOCK' };
    db.prepare(`INSERT INTO orders (id, request_id, quote_id, buyer_principal_id, status, created_at)
      VALUES (@id, @request_id, @quote_id, @buyer_principal_id, @status, @created_at)`).run(order);
    return { kind: 'CREATED', order };
  });

  return {
    async getProduct(skuId) { return toCatalog(db.prepare('SELECT * FROM catalog WHERE sku_id = ?').get(skuId)); },
    async getQuote(id) { return db.prepare('SELECT * FROM quotes WHERE id = ?').get(id) as QuoteRow | undefined; },
    async getQuoteByRequest(requestId) {
      return db.prepare('SELECT * FROM quotes WHERE request_id = ?').get(requestId) as QuoteRow | undefined;
    },
    async insertQuote(quote) {
      db.prepare(`INSERT INTO quotes (id, request_id, supplier_id, sku_id, buyer_principal_id, quantity, unit_price_cents,
        total_cents, currency, expires_at, created_at) VALUES (@id, @request_id, @supplier_id, @sku_id, @buyer_principal_id,
        @quantity, @unit_price_cents, @total_cents, @currency, @expires_at, @created_at) ON CONFLICT(request_id) DO NOTHING`).run(quote);
      return db.prepare('SELECT * FROM quotes WHERE request_id = ?').get(quote.request_id) as QuoteRow;
    },
    async getOrderByRequest(requestId) {
      return db.prepare('SELECT * FROM orders WHERE request_id = ?').get(requestId) as OrderRow | undefined;
    },
    async fulfill(order, quantity, skuId) { return fulfillTx.immediate(order, quantity, skuId); },
    async reset(stock = SEED.stock_quantity) {
      db.transaction(() => {
        db.exec('DELETE FROM orders; DELETE FROM quotes;');
        db.prepare('UPDATE catalog SET stock_quantity = ? WHERE sku_id = ?').run(stock, SEED.sku_id);
      }).immediate();
    },
    async close() { db.close(); },
  };
}

// ---------------------------------------------------------------- Postgres

/** DATABASE_CA_CERT may hold the PEM itself or a path to it (Supabase's CA is not public). */
function caCert(): string | undefined {
  const value = process.env.SUPPLIER_DATABASE_CA_CERT ?? process.env.DATABASE_CA_CERT;
  if (!value) return undefined;
  if (value.includes('-----BEGIN')) return value.replace(/\\n/g, '\n');
  if (existsSync(value)) return readFileSync(value, 'utf8');
  throw new Error('DATABASE_CA_CERT is neither a PEM certificate nor a readable file path');
}

export function postgresStore(connectionString: string): SupplierStore {
  const url = new URL(connectionString);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'options']) url.searchParams.delete(key);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const ca = caCert();
  const pool = new pg.Pool({
    connectionString: url.href,
    max: 5,
    connectionTimeoutMillis: 5000,
    options: '-c search_path=supplier',
    ssl: local ? undefined : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  });

  const toCatalog = (r: any): CatalogRow | undefined => r;
  const one = async <T>(sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0] as T | undefined;

  return {
    getProduct: (skuId) => one<CatalogRow>('SELECT * FROM catalog WHERE sku_id = $1', [skuId]).then(toCatalog),
    getQuote: (id) => one<QuoteRow>('SELECT * FROM quotes WHERE id = $1', [id]),
    getQuoteByRequest: (requestId) => one<QuoteRow>('SELECT * FROM quotes WHERE request_id = $1', [requestId]),
    async insertQuote(q) {
      await pool.query(`INSERT INTO quotes (id, request_id, supplier_id, sku_id, buyer_principal_id, quantity, unit_price_cents,
        total_cents, currency, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (request_id) DO NOTHING`,
      [q.id, q.request_id, q.supplier_id, q.sku_id, q.buyer_principal_id, q.quantity, q.unit_price_cents, q.total_cents,
        q.currency, q.expires_at, q.created_at]);
      return (await one<QuoteRow>('SELECT * FROM quotes WHERE request_id = $1', [q.request_id]))!;
    },
    getOrderByRequest: (requestId) => one<OrderRow>('SELECT * FROM orders WHERE request_id = $1', [requestId]),
    async fulfill(order, quantity, skuId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        // Lock the catalog row first: serializes every fulfillment of this SKU.
        await client.query('SELECT 1 FROM catalog WHERE sku_id = $1 FOR UPDATE', [skuId]);
        const replay = (await client.query('SELECT * FROM orders WHERE request_id = $1', [order.request_id])).rows[0];
        if (replay) { await client.query('COMMIT'); return { kind: 'REPLAYED', order: replay }; }
        if ((await client.query('SELECT 1 FROM orders WHERE quote_id = $1', [order.quote_id])).rowCount) {
          await client.query('COMMIT');
          return { kind: 'QUOTE_ALREADY_ORDERED' };
        }
        const stock = await client.query(
          'UPDATE catalog SET stock_quantity = stock_quantity - $1 WHERE sku_id = $2 AND stock_quantity >= $1', [quantity, skuId]);
        if (stock.rowCount !== 1) { await client.query('ROLLBACK'); return { kind: 'OUT_OF_STOCK' }; }
        await client.query(`INSERT INTO orders (id, request_id, quote_id, buyer_principal_id, status, created_at)
          VALUES ($1,$2,$3,$4,$5,$6)`, [order.id, order.request_id, order.quote_id, order.buyer_principal_id, order.status, order.created_at]);
        await client.query('COMMIT');
        return { kind: 'CREATED', order };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async reset(stock = SEED.stock_quantity) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM orders');
        await client.query('DELETE FROM quotes');
        await client.query('UPDATE catalog SET stock_quantity = $1 WHERE sku_id = $2', [stock, SEED.sku_id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function storeFromEnv(): SupplierStore {
  const url = process.env.SUPPLIER_DATABASE_URL;
  return url ? postgresStore(url) : sqliteStore(process.env.SUPPLIER_DB_PATH ?? './supplier.sqlite');
}

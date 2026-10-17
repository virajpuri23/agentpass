-- Separate Supplier Company private database (SQLite starter). Developer B owns.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS catalog (
  sku_id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  stock_quantity INTEGER NOT NULL,
  public_unit_price_cents INTEGER NOT NULL,
  internal_unit_cost_cents INTEGER NOT NULL, -- PRIVATE; never appear in buyer-facing API
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  sku_id TEXT NOT NULL REFERENCES catalog(sku_id),
  buyer_principal_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  buyer_principal_id TEXT NOT NULL,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','REJECTED')),
  created_at TEXT NOT NULL
);

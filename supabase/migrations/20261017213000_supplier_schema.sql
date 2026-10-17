-- Supplier Company private database (Developer B). Separate schema from the
-- AgentPass authority (`agentpass`); only the supplier backend connects here.
-- `internal_unit_cost_cents` is private and must never reach a buyer-facing API.
CREATE SCHEMA IF NOT EXISTS supplier;

CREATE TABLE IF NOT EXISTS supplier.catalog (
  sku_id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  stock_quantity INTEGER NOT NULL CHECK (stock_quantity >= 0),
  public_unit_price_cents INTEGER NOT NULL CHECK (public_unit_price_cents > 0),
  internal_unit_cost_cents INTEGER NOT NULL CHECK (internal_unit_cost_cents >= 0), -- PRIVATE
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS supplier.quotes (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  supplier_id TEXT NOT NULL,
  sku_id TEXT NOT NULL REFERENCES supplier.catalog(sku_id),
  buyer_principal_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  total_cents INTEGER NOT NULL CHECK (total_cents = quantity * unit_price_cents),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier.orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  quote_id TEXT NOT NULL UNIQUE REFERENCES supplier.quotes(id),
  buyer_principal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED')),
  created_at TEXT NOT NULL
);

-- Private: no access for Supabase API roles; RLS on with no policies.
ALTER TABLE supplier.catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier.orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA supplier FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA supplier FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA supplier REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;

-- Demo catalog (fixtures/seed-scenario.json): 500 x 170c = $850 public quote.
INSERT INTO supplier.catalog (sku_id, product_name, stock_quantity, public_unit_price_cents, internal_unit_cost_cents)
VALUES ('PACK-500', 'Packaging units', 1000, 170, 100)
ON CONFLICT (sku_id) DO NOTHING;

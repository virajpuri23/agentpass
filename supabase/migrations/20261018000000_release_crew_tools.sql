-- Release-crew demo: internal tool billing items (Developer B). Same private
-- schema and rules as supplier.catalog; internal_unit_cost_cents stays private.
INSERT INTO supplier.catalog (sku_id, product_name, stock_quantity, public_unit_price_cents, internal_unit_cost_cents) VALUES
  ('SEC-SCAN',    'Security scan',      100,    12000, 7000),
  ('DESIGN-PACK', 'Design asset pack',  100,    18000, 9000),
  ('QA-MINUTES',  'Test-device minute', 100000, 100,   55)
ON CONFLICT (sku_id) DO NOTHING;

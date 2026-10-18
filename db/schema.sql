-- Authority database starter schema (SQLite). Developer A owns migrations.
-- WARNING: Adapt/validate before any production use; not an audited schema.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('HUMAN','AGENT','SERVICE')),
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS principal_keys (
  key_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  key_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  parent_grant_id TEXT REFERENCES grants(id),
  issuer_principal_id TEXT NOT NULL REFERENCES principals(id),
  subject_principal_id TEXT NOT NULL REFERENCES principals(id),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS grants_subject ON grants(subject_principal_id);
CREATE INDEX IF NOT EXISTS grants_parent ON grants(parent_grant_id);


-- A registered child key is usable only while its original delegated grant is live.
CREATE TABLE IF NOT EXISTS child_provisionings (
  parent_principal_id TEXT NOT NULL REFERENCES principals(id),
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  child_principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id),
  child_grant_id TEXT NOT NULL UNIQUE REFERENCES grants(id),
  credential_key_id TEXT NOT NULL UNIQUE REFERENCES principal_keys(key_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(parent_principal_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS authority_requests (
  id TEXT PRIMARY KEY,
  requester_principal_id TEXT NOT NULL REFERENCES principals(id),
  parent_grant_id TEXT NOT NULL REFERENCES grants(id),
  requested_scope_json TEXT NOT NULL CHECK (json_valid(requested_scope_json)),
  offered_scope_json TEXT CHECK (offered_scope_json IS NULL OR json_valid(offered_scope_json)),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','COUNTEROFFERED','ACCEPTED','REJECTED','CANCELLED')),
  issued_grant_id TEXT REFERENCES grants(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  caller_principal_id TEXT NOT NULL REFERENCES principals(id),
  grant_id TEXT NOT NULL REFERENCES grants(id),
  quote_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  supplier_order_id TEXT,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(caller_principal_id, idempotency_key)
);

-- Each completed purchase creates one debit PER GRANT in its ancestor chain.
-- Spending checks count RESERVED and COMMITTED entries in a single write transaction.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  grant_id TEXT NOT NULL REFERENCES grants(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  state TEXT NOT NULL CHECK (state IN ('RESERVED','COMMITTED','RELEASED')),
  created_at TEXT NOT NULL,
  UNIQUE(purchase_id, grant_id)
);
CREATE INDEX IF NOT EXISTS ledger_by_grant ON ledger_entries(grant_id, state);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  grant_id TEXT,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_code TEXT,
  request_id TEXT,
  trace_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_trace ON audit_events(trace_id, timestamp);
CREATE TABLE IF NOT EXISTS workforce_executions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  grant_id TEXT NOT NULL REFERENCES grants(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(principal_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS workforce_usage (
  execution_id TEXT NOT NULL REFERENCES workforce_executions(id),
  grant_id TEXT NOT NULL REFERENCES grants(id),
  PRIMARY KEY(execution_id,grant_id)
);
CREATE INDEX IF NOT EXISTS workforce_usage_grant ON workforce_usage(grant_id);

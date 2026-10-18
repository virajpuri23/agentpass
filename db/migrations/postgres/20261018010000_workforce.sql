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
ALTER TABLE workforce_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE workforce_executions,workforce_usage FROM PUBLIC;

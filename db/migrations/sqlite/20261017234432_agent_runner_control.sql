CREATE TABLE IF NOT EXISTS managed_agents (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES assistant_connections(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  requester_account_id TEXT NOT NULL REFERENCES accounts(id),
  parent_principal_id TEXT NOT NULL REFERENCES principals(id),
  parent_grant_id TEXT NOT NULL REFERENCES grants(id),
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  state TEXT NOT NULL CHECK(state IN ('PENDING','PROVISIONING','READY','FAILED','REVOKED')),
  execution_state TEXT NOT NULL CHECK(execution_state IN ('NOT_STARTED','RUNNING','COMPLETED','FAILED','STOPPED')),
  child_principal_id TEXT REFERENCES principals(id),
  child_grant_id TEXT REFERENCES grants(id),
  secret_reference TEXT NOT NULL UNIQUE,
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS managed_agents_connection ON managed_agents(connection_id,created_at,id);
CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES managed_agents(id),
  launch_id TEXT NOT NULL UNIQUE,
  runner_id TEXT,
  claim_id TEXT UNIQUE,
  claim_key TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
  outcome TEXT CHECK(outcome IN ('COMPLETED','FAILED')),
  result_fingerprint TEXT,
  UNIQUE(runner_id,claim_key)
);

CREATE TABLE IF NOT EXISTS agent_job_claims (
  runner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES agent_jobs(id),
  claim_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(runner_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS agent_provision_attempts (id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES assistant_connections(id),created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_provision_attempts_connection ON agent_provision_attempts(connection_id,created_at);

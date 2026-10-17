CREATE UNIQUE INDEX IF NOT EXISTS principals_id_organization ON agentpass.principals(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS grants_id_subject_organization ON agentpass.grants(id, subject_principal_id, organization_id);

CREATE TABLE IF NOT EXISTS agentpass.accounts (
  id TEXT PRIMARY KEY,
  personal_organization_id TEXT NOT NULL UNIQUE REFERENCES agentpass.organizations(id),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agentpass.external_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES agentpass.accounts(id),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE IF NOT EXISTS agentpass.memberships (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES agentpass.accounts(id),
  organization_id TEXT NOT NULL REFERENCES agentpass.organizations(id),
  human_principal_id TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL,
  UNIQUE (account_id, organization_id),
  UNIQUE (id, account_id, organization_id),
  UNIQUE (human_principal_id),
  FOREIGN KEY (human_principal_id, organization_id) REFERENCES agentpass.principals(id, organization_id)
);

CREATE TABLE IF NOT EXISTS agentpass.assistant_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES agentpass.accounts(id),
  membership_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES agentpass.organizations(id),
  principal_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CONSENT_REQUIRED','ACTIVE','REVOKED')),
  grant_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (membership_id, client_id),
  UNIQUE (id, principal_id, organization_id),
  FOREIGN KEY (membership_id, account_id, organization_id) REFERENCES agentpass.memberships(id, account_id, organization_id),
  FOREIGN KEY (principal_id, organization_id) REFERENCES agentpass.principals(id, organization_id),
  FOREIGN KEY (grant_id, principal_id, organization_id) REFERENCES agentpass.grants(id, subject_principal_id, organization_id),
  CHECK ((state = 'CONSENT_REQUIRED' AND grant_id IS NULL AND revoked_at IS NULL) OR
         (state = 'ACTIVE' AND grant_id IS NOT NULL AND revoked_at IS NULL) OR
         (state = 'REVOKED' AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS assistant_connections_account ON agentpass.assistant_connections(account_id, state);

CREATE TABLE IF NOT EXISTS agentpass.consent_requests (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES agentpass.assistant_connections(id),
  scope_json TEXT NOT NULL CHECK (scope_json::jsonb IS NOT NULL),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS agentpass.consent_approvals (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE REFERENCES agentpass.assistant_connections(id),
  human_principal_id TEXT NOT NULL REFERENCES agentpass.principals(id),
  scope_json TEXT NOT NULL CHECK (scope_json::jsonb IS NOT NULL),
  grant_id TEXT NOT NULL UNIQUE REFERENCES agentpass.grants(id),
  approved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agentpass.consent_sessions (
  id_hash TEXT PRIMARY KEY CHECK (id_hash ~ '^[a-f0-9]{64}$'),
  payload_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

ALTER TABLE agentpass.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentpass.external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentpass.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentpass.assistant_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentpass.consent_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentpass.consent_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentpass.consent_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE agentpass.accounts, agentpass.external_identities, agentpass.memberships,
  agentpass.assistant_connections, agentpass.consent_requests, agentpass.consent_approvals,
  agentpass.consent_sessions FROM PUBLIC;

CREATE UNIQUE INDEX IF NOT EXISTS principals_id_organization ON principals(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS grants_id_subject_organization ON grants(id, subject_principal_id, organization_id);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  personal_organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  human_principal_id TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL,
  UNIQUE (account_id, organization_id),
  UNIQUE (id, account_id, organization_id),
  UNIQUE (human_principal_id),
  FOREIGN KEY (human_principal_id, organization_id) REFERENCES principals(id, organization_id)
);

CREATE TABLE IF NOT EXISTS assistant_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  membership_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CONSENT_REQUIRED','ACTIVE','REVOKED')),
  grant_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (membership_id, client_id),
  UNIQUE (id, principal_id, organization_id),
  FOREIGN KEY (membership_id, account_id, organization_id) REFERENCES memberships(id, account_id, organization_id),
  FOREIGN KEY (principal_id, organization_id) REFERENCES principals(id, organization_id),
  FOREIGN KEY (grant_id, principal_id, organization_id) REFERENCES grants(id, subject_principal_id, organization_id),
  CHECK ((state = 'CONSENT_REQUIRED' AND grant_id IS NULL AND revoked_at IS NULL) OR
         (state = 'ACTIVE' AND grant_id IS NOT NULL AND revoked_at IS NULL) OR
         (state = 'REVOKED' AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS assistant_connections_account ON assistant_connections(account_id, state);

CREATE TABLE IF NOT EXISTS consent_requests (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES assistant_connections(id),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS consent_approvals (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE REFERENCES assistant_connections(id),
  human_principal_id TEXT NOT NULL REFERENCES principals(id),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  grant_id TEXT NOT NULL UNIQUE REFERENCES grants(id),
  approved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_sessions (
  id_hash TEXT PRIMARY KEY CHECK (length(id_hash) = 64 AND id_hash NOT GLOB '*[^0-9a-f]*'),
  payload_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

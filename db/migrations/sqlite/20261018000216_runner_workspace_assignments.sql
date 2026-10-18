CREATE UNIQUE INDEX IF NOT EXISTS accounts_personal_assignment_key ON accounts(id,personal_organization_id);
CREATE TABLE IF NOT EXISTS runner_workspace_assignments (
  organization_id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id,organization_id) REFERENCES accounts(id,personal_organization_id)
);

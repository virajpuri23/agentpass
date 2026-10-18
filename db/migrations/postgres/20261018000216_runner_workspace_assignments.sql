CREATE UNIQUE INDEX IF NOT EXISTS accounts_personal_assignment_key ON agentpass.accounts(id,personal_organization_id);
CREATE TABLE IF NOT EXISTS agentpass.runner_workspace_assignments (
  organization_id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id,organization_id) REFERENCES agentpass.accounts(id,personal_organization_id)
);
ALTER TABLE agentpass.runner_workspace_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE agentpass.runner_workspace_assignments FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON TABLE agentpass.runner_workspace_assignments FROM anon; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON TABLE agentpass.runner_workspace_assignments FROM authenticated; END IF;
END $$;

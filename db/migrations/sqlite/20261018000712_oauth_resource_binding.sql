CREATE TABLE IF NOT EXISTS oauth_resource_clients (
  client_id TEXT PRIMARY KEY,
  resource TEXT NOT NULL CHECK(resource LIKE 'https://%/mcp')
);

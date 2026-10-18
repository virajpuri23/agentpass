CREATE TABLE IF NOT EXISTS agentpass.oauth_resource_clients (
  client_id TEXT PRIMARY KEY,
  resource TEXT NOT NULL CHECK(resource LIKE 'https://%/mcp')
);
ALTER TABLE agentpass.oauth_resource_clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE agentpass.oauth_resource_clients FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentpass.oauth_access_token_hook(event jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  claims jsonb := event->'claims';
  resource text;
BEGIN
  IF jsonb_typeof(claims) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid auth hook claims';
  END IF;
  IF claims->>'role'='authenticated' AND claims->'is_anonymous'='false'::jsonb THEN
    SELECT c.resource INTO resource FROM agentpass.oauth_resource_clients c
      WHERE c.client_id=claims->>'client_id';
    IF resource IS NOT NULL THEN
      claims := jsonb_set(claims,'{aud}',to_jsonb(resource));
      claims := jsonb_set(claims,'{exp}',to_jsonb(LEAST((claims->>'exp')::bigint,(claims->>'iat')::bigint+600)));
    END IF;
  END IF;
  RETURN jsonb_build_object('claims',claims);
END;
$$;
REVOKE ALL ON FUNCTION agentpass.oauth_access_token_hook(jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA agentpass TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION agentpass.oauth_access_token_hook(jsonb) TO supabase_auth_admin;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON TABLE agentpass.oauth_resource_clients FROM anon;
    REVOKE ALL ON FUNCTION agentpass.oauth_access_token_hook(jsonb) FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON TABLE agentpass.oauth_resource_clients FROM authenticated;
    REVOKE ALL ON FUNCTION agentpass.oauth_access_token_hook(jsonb) FROM authenticated;
  END IF;
END $$;

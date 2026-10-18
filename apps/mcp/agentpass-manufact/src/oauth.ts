import { OAuthError, OAuthErrorCode, oauthCustomProvider, type OAuthAuthInfo, type OAuthProvider, type OAuthTokenVerifier } from 'mcp-use/oauth';
import { oauthSupabaseProvider } from 'mcp-use/oauth/supabase';
import { createAuthorityClient } from './authority-client.js';

export const SUPABASE_OPENID_SCOPE = 'openid';
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 600;

export interface HumanOAuthConfig {
  /** Canonical Supabase Auth issuer, normally https://<project>.supabase.co/auth/v1. */
  issuer: string | URL;
  resource: string | URL;
  clientIds: readonly string[];
}

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  client_id: string;
}

export interface AgentPassOAuthUser {
  id: string;
  kind: 'HUMAN' | 'AGENT';
  organization_id?: string;
}

type OAuthEnvironment = Readonly<Record<string, string | undefined>>;

function invalidToken(): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, 'The bearer token is invalid or expired.');
}

function parseUrl(value: string | URL, name: string, allowBareHost = false): URL {
  const raw = value instanceof URL ? value.href : value.trim();
  let url: URL;
  try {
    url = new URL(allowBareHost && !raw.includes('://') ? `https://${raw}` : raw);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must use HTTPS, or HTTP for localhost, without credentials, query, or fragment.`);
  }
  return url;
}

function normalizedConfig(config: HumanOAuthConfig): { issuer: URL; supabaseUrl: URL; resource: URL; clientIds: Set<string> } {
  const issuer = parseUrl(config.issuer, 'Supabase Auth issuer', true);
  if (issuer.pathname.replace(/\/+$/, '') !== '/auth/v1') throw new Error('Supabase issuer must identify the canonical /auth/v1 endpoint.');
  const supabaseUrl = new URL(issuer.origin);
  const resource = parseUrl(config.resource, 'MCP resource');
  if (resource.pathname !== '/mcp') throw new Error('MCP_PUBLIC_URL must identify the canonical /mcp endpoint.');
  if (!config.clientIds.length || config.clientIds.some((id) => !id || id !== id.trim()) || new Set(config.clientIds).size !== config.clientIds.length) {
    throw new Error('AGENTPASS_OAUTH_CLIENT_IDS must contain unique, non-empty client IDs.');
  }
  return { issuer: new URL('/auth/v1', supabaseUrl), supabaseUrl, resource, clientIds: new Set(config.clientIds) };
}

export function humanOAuthConfigFromEnv(env: OAuthEnvironment = process.env): HumanOAuthConfig | undefined {
  const legacyAuth0Configured = env.MCP_USE_OAUTH_AUTH0_DOMAIN !== undefined || env.MCP_USE_OAUTH_AUTH0_AUDIENCE !== undefined;
  if (legacyAuth0Configured) throw new Error('Auth0 OAuth configuration is no longer supported; configure Supabase OAuth instead.');

  const keys = ['MCP_USE_OAUTH_SUPABASE_URL', 'MCP_PUBLIC_URL', 'AGENTPASS_OAUTH_CLIENT_IDS'] as const;
  const oauthConfigured = env.MCP_USE_OAUTH_SUPABASE_URL !== undefined || env.AGENTPASS_OAUTH_CLIENT_IDS !== undefined;
  if (!oauthConfigured) return undefined;
  const present = keys.filter((key) => env[key] !== undefined);
  if (present.length !== keys.length) throw new Error('Configure MCP_USE_OAUTH_SUPABASE_URL, MCP_PUBLIC_URL, and AGENTPASS_OAUTH_CLIENT_IDS together.');

  const supabaseUrl = parseUrl(env.MCP_USE_OAUTH_SUPABASE_URL!, 'MCP_USE_OAUTH_SUPABASE_URL');
  if (supabaseUrl.pathname !== '/') throw new Error('MCP_USE_OAUTH_SUPABASE_URL must be the project origin without a path.');
  const resource = parseUrl(env.MCP_PUBLIC_URL!, 'MCP_PUBLIC_URL');
  const rawClientIds = env.AGENTPASS_OAUTH_CLIENT_IDS!.split(',');
  const clientIds = rawClientIds.map((id) => id.trim());
  if (clientIds.some((id) => !id) || new Set(clientIds).size !== clientIds.length) {
    throw new Error('AGENTPASS_OAUTH_CLIENT_IDS must be a comma-separated list of unique, non-empty client IDs.');
  }
  const config = { issuer: new URL('/auth/v1', supabaseUrl), resource, clientIds };
  normalizedConfig(config);
  return config;
}

function requiredClaimString(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw invalidToken();
  return value;
}

function optionalClaimString(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw invalidToken();
  return value;
}

function verifiedPayload(authInfo: OAuthAuthInfo): Record<string, unknown> {
  const payload = authInfo.extra?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidToken();
  return payload as Record<string, unknown>;
}

function verifiedClaims(authInfo: OAuthAuthInfo, config: ReturnType<typeof normalizedConfig>): VerifiedIdentity {
  const payload = verifiedPayload(authInfo);
  const issuer = requiredClaimString(payload, 'iss');
  const subject = requiredClaimString(payload, 'sub');
  const clientId = optionalClaimString(payload, 'client_id');
  const authorizedParty = optionalClaimString(payload, 'azp');
  if ((!clientId && !authorizedParty) || (clientId && authorizedParty && clientId !== authorizedParty)) throw invalidToken();
  const verifiedClientId = clientId ?? authorizedParty!;
  if (!config.clientIds.has(verifiedClientId) || subject === verifiedClientId || subject.endsWith('@clients')) throw invalidToken();

  if (issuer !== config.issuer.href || payload.aud !== config.resource.href || payload.role !== 'authenticated' || payload.is_anonymous !== false) {
    throw invalidToken();
  }
  if (payload.user_id !== undefined && payload.user_id !== subject) throw invalidToken();

  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  const now = Date.now() / 1000;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)
    || expiresAt <= now || issuedAt > now + 60 || now - issuedAt > MAX_ACCESS_TOKEN_LIFETIME_SECONDS
    || expiresAt - issuedAt > MAX_ACCESS_TOKEN_LIFETIME_SECONDS
    || expiresAt - now > MAX_ACCESS_TOKEN_LIFETIME_SECONDS) throw invalidToken();

  const scope = payload.scope;
  const scopes = typeof scope === 'string' ? scope.split(/\s+/) : Array.isArray(scope) ? scope : [];
  if (!scopes.includes(SUPABASE_OPENID_SCOPE)) {
    throw new OAuthError(OAuthErrorCode.InsufficientScope, `The ${SUPABASE_OPENID_SCOPE} scope is required.`);
  }
  return { issuer, subject, client_id: verifiedClientId };
}

function createSupabaseVerifier(config: HumanOAuthConfig) {
  if (process.env.MCP_USE_OAUTH_SUPABASE_JWT_SECRET !== undefined) {
    throw new Error('AgentPass requires ES256/JWKS; remove MCP_USE_OAUTH_SUPABASE_JWT_SECRET.');
  }
  const normalized = normalizedConfig(config);
  const provider = oauthSupabaseProvider({
    supabaseUrl: normalized.supabaseUrl,
    audience: normalized.resource.href,
    resource: normalized.resource,
    requiredScopes: [SUPABASE_OPENID_SCOPE],
    scopesSupported: [SUPABASE_OPENID_SCOPE],
    resourceName: 'AgentPass',
  });
  const verifier = provider.createTokenVerifier(normalized.resource);
  const verify = async (token: string): Promise<{ authInfo: OAuthAuthInfo; identity: VerifiedIdentity }> => {
    if (Buffer.byteLength(token, 'utf8') > MAX_ACCESS_TOKEN_BYTES || !token.includes('.')) throw invalidToken();
    const authInfo = await verifier.verifyAccessToken(token);
    const identity = verifiedClaims(authInfo, normalized);
    return { authInfo, identity };
  };
  return { oauthMetadata: provider.oauthMetadata, verify };
}

export function createHumanTokenVerifier(config: HumanOAuthConfig): (token: string) => Promise<VerifiedIdentity> {
  const { verify } = createSupabaseVerifier(config);
  return async (token) => (await verify(token)).identity;
}

export function createHumanTokenVerifierFromEnv(env: OAuthEnvironment = process.env): ((token: string) => Promise<VerifiedIdentity>) | undefined {
  const config = humanOAuthConfigFromEnv(env);
  return config ? createHumanTokenVerifier(config) : undefined;
}

function serviceAuthInfo(token: string, resource: URL, data: Record<string, unknown>): OAuthAuthInfo {
  const principalId = data.principal_id;
  if (typeof principalId !== 'string' || !principalId) throw invalidToken();
  return {
    token,
    clientId: principalId,
    scopes: [SUPABASE_OPENID_SCOPE],
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    resource,
    extra: { payload: {
      sub: principalId,
      organization_id: typeof data.organization_id === 'string' ? data.organization_id : undefined,
      agentpass_identity_type: 'AGENT',
    } },
  };
}

export function createAgentPassOAuthProvider(config: HumanOAuthConfig, authorityUrl: string): OAuthProvider<AgentPassOAuthUser> {
  const supabase = createSupabaseVerifier(config);
  const resource = parseUrl(config.resource, 'MCP resource');
  const normalized = normalizedConfig(config);
  return oauthCustomProvider<AgentPassOAuthUser>({
    resource,
    requiredScopes: [SUPABASE_OPENID_SCOPE],
    scopesSupported: [SUPABASE_OPENID_SCOPE],
    resourceName: 'AgentPass',
    oauthMetadata: supabase.oauthMetadata,
    createTokenVerifier: (expectedResource): OAuthTokenVerifier => ({
      async verifyAccessToken(token) {
        if (expectedResource.href !== resource.href) throw new Error('Configured MCP resource must match the canonical MCP endpoint.');
        if (Buffer.byteLength(token, 'utf8') > MAX_ACCESS_TOKEN_BYTES) throw invalidToken();
        if (token.includes('.')) {
          const { authInfo, identity } = await supabase.verify(token);
          const payload = verifiedPayload(authInfo);
          return {
            ...authInfo,
            clientId: identity.client_id,
            resource: expectedResource,
            extra: { payload: { ...payload, agentpass_identity_type: 'HUMAN' } },
          };
        }
        const me = await createAuthorityClient({ authorityUrl, agentApiKey: token })('GET', 'v1/me');
        if (me.status !== 'OK') {
          if (me.code === 'SERVICE_UNAVAILABLE') throw new OAuthError(OAuthErrorCode.TemporarilyUnavailable, 'The authority service is unavailable.');
          throw invalidToken();
        }
        return serviceAuthInfo(token, normalized.resource, me.data);
      },
    }),
    mapAuthInfo(authInfo) {
      const payload = verifiedPayload(authInfo);
      const id = requiredClaimString(payload, 'sub');
      const kind = payload.agentpass_identity_type === 'HUMAN' ? 'HUMAN' : 'AGENT';
      return {
        user: { id, kind, ...(typeof payload.organization_id === 'string' ? { organization_id: payload.organization_id } : {}) },
        payload,
        permissions: [],
      };
    },
  });
}

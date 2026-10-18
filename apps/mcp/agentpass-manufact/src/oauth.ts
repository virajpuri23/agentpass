import { OAuthError, OAuthErrorCode, oauthCustomProvider, type OAuthAuthInfo, type OAuthProvider, type OAuthTokenVerifier } from 'mcp-use/oauth';
import { oauthAuth0Provider } from 'mcp-use/oauth/auth0';
import { createAuthorityClient } from './authority-client.js';

export const AGENTPASS_CONNECT_SCOPE = 'agentpass:connect';
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 600;

export interface HumanOAuthConfig {
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

function normalizedConfig(config: HumanOAuthConfig): { issuer: URL; resource: URL; clientIds: Set<string> } {
  const issuer = parseUrl(config.issuer, 'Auth0 issuer', true);
  const resource = parseUrl(config.resource, 'MCP resource');
  if (resource.pathname !== '/mcp') throw new Error('MCP_PUBLIC_URL must identify the canonical /mcp endpoint.');
  if (!config.clientIds.length || config.clientIds.some((id) => !id || id !== id.trim()) || new Set(config.clientIds).size !== config.clientIds.length) {
    throw new Error('AGENTPASS_OAUTH_CLIENT_IDS must contain unique, non-empty client IDs.');
  }
  return { issuer, resource, clientIds: new Set(config.clientIds) };
}

export function humanOAuthConfigFromEnv(env: OAuthEnvironment = process.env): HumanOAuthConfig | undefined {
  const keys = ['MCP_USE_OAUTH_AUTH0_DOMAIN', 'MCP_PUBLIC_URL', 'AGENTPASS_OAUTH_CLIENT_IDS'] as const;
  const oauthConfigured = env.MCP_USE_OAUTH_AUTH0_DOMAIN !== undefined
    || env.AGENTPASS_OAUTH_CLIENT_IDS !== undefined
    || env.MCP_USE_OAUTH_AUTH0_AUDIENCE !== undefined;
  if (!oauthConfigured) return undefined;
  const present = keys.filter((key) => env[key] !== undefined);
  if (present.length !== keys.length) throw new Error('Configure MCP_USE_OAUTH_AUTH0_DOMAIN, MCP_PUBLIC_URL, and AGENTPASS_OAUTH_CLIENT_IDS together.');

  const resource = parseUrl(env.MCP_PUBLIC_URL!, 'MCP_PUBLIC_URL');
  if (env.MCP_USE_OAUTH_AUTH0_AUDIENCE !== undefined) {
    const audience = parseUrl(env.MCP_USE_OAUTH_AUTH0_AUDIENCE, 'MCP_USE_OAUTH_AUTH0_AUDIENCE', true);
    if (audience.href.replace(/\/$/, '') !== resource.href.replace(/\/$/, '')) {
      throw new Error('MCP_USE_OAUTH_AUTH0_AUDIENCE must match MCP_PUBLIC_URL or be unset.');
    }
  }

  const rawClientIds = env.AGENTPASS_OAUTH_CLIENT_IDS!.split(',');
  const clientIds = rawClientIds.map((id) => id.trim());
  if (clientIds.some((id) => !id) || new Set(clientIds).size !== clientIds.length) {
    throw new Error('AGENTPASS_OAUTH_CLIENT_IDS must be a comma-separated list of unique, non-empty client IDs.');
  }
  const config = { issuer: env.MCP_USE_OAUTH_AUTH0_DOMAIN!, resource, clientIds };
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

function verifiedClaims(authInfo: OAuthAuthInfo, clientIds: Set<string>): VerifiedIdentity {
  const payload = verifiedPayload(authInfo);
  const issuer = requiredClaimString(payload, 'iss');
  const subject = requiredClaimString(payload, 'sub');
  const clientId = optionalClaimString(payload, 'client_id');
  const authorizedParty = optionalClaimString(payload, 'azp');
  if (!clientId && !authorizedParty || clientId && authorizedParty && clientId !== authorizedParty) throw invalidToken();
  const verifiedClientId = clientId ?? authorizedParty!;
  if (!clientIds.has(verifiedClientId) || subject === verifiedClientId || subject.endsWith('@clients')) throw invalidToken();

  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  const now = Date.now() / 1000;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)
    || expiresAt <= now || issuedAt > now + 60 || now - issuedAt > MAX_ACCESS_TOKEN_LIFETIME_SECONDS
    || expiresAt - issuedAt > MAX_ACCESS_TOKEN_LIFETIME_SECONDS
    || expiresAt - now > MAX_ACCESS_TOKEN_LIFETIME_SECONDS) throw invalidToken();

  const scope = payload.scope;
  const scopes = typeof scope === 'string' ? scope.split(/\s+/) : Array.isArray(scope) ? scope : [];
  if (!scopes.includes(AGENTPASS_CONNECT_SCOPE)) {
    throw new OAuthError(OAuthErrorCode.InsufficientScope, `The ${AGENTPASS_CONNECT_SCOPE} scope is required.`);
  }
  return { issuer, subject, client_id: verifiedClientId };
}

function createAuth0Verifier(config: HumanOAuthConfig) {
  const normalized = normalizedConfig(config);
  const provider = oauthAuth0Provider({
    domain: normalized.issuer,
    resource: normalized.resource,
    requiredScopes: [AGENTPASS_CONNECT_SCOPE],
    scopesSupported: [AGENTPASS_CONNECT_SCOPE],
    resourceName: 'AgentPass',
  });
  const verifier = provider.createTokenVerifier(normalized.resource);
  const verify = async (token: string): Promise<{ authInfo: OAuthAuthInfo; identity: VerifiedIdentity }> => {
    if (Buffer.byteLength(token, 'utf8') > MAX_ACCESS_TOKEN_BYTES || !token.includes('.')) throw invalidToken();
    const authInfo = await verifier.verifyAccessToken(token);
    const identity = verifiedClaims(authInfo, normalized.clientIds);
    return { authInfo, identity };
  };
  return { oauthMetadata: provider.oauthMetadata, verify };
}

export function createHumanTokenVerifier(config: HumanOAuthConfig): (token: string) => Promise<VerifiedIdentity> {
  const { verify } = createAuth0Verifier(config);
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
    scopes: [AGENTPASS_CONNECT_SCOPE],
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
  const auth0 = createAuth0Verifier(config);
  const resource = parseUrl(config.resource, 'MCP resource');
  return oauthCustomProvider<AgentPassOAuthUser>({
    resource,
    requiredScopes: [AGENTPASS_CONNECT_SCOPE],
    scopesSupported: [AGENTPASS_CONNECT_SCOPE],
    resourceName: 'AgentPass',
    oauthMetadata: auth0.oauthMetadata,
    createTokenVerifier: (expectedResource): OAuthTokenVerifier => ({
      async verifyAccessToken(token) {
        if (expectedResource.href !== resource.href) throw new Error('Configured MCP resource must match the canonical MCP endpoint.');
        if (Buffer.byteLength(token, 'utf8') > MAX_ACCESS_TOKEN_BYTES) throw invalidToken();
        if (token.includes('.')) {
          const { authInfo, identity } = await auth0.verify(token);
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
        return serviceAuthInfo(token, resource, me.data);
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

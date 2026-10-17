import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentPassOAuthProvider, createHumanTokenVerifier, createHumanTokenVerifierFromEnv, humanOAuthConfigFromEnv, type HumanOAuthConfig } from '../agentpass-manufact/src/oauth.js';

const resource = 'https://agentpass.example/mcp';
const clientIds = ['chatgpt-client', 'claude-client'];
let server: Server;
let issuer = '';
let privateKey = '';
let otherPrivateKey = '';
let jwk: Record<string, unknown>;
let authorityRequests = 0;

async function listen(app: Server): Promise<string> {
  app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { app.once('listening', resolve); app.once('error', reject); });
  return `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
}

function config(): HumanOAuthConfig {
  return { issuer, resource, clientIds };
}

async function token(overrides: {
  iss?: string;
  aud?: string;
  sub?: string;
  azp?: string | null;
  client_id?: string | null;
  scope?: string;
  iat?: number;
  exp?: number;
  key?: string;
  kid?: string;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: overrides.iss ?? `${issuer}/`,
    sub: overrides.sub ?? 'auth0|fixture-person',
    aud: overrides.aud ?? resource,
    iat: overrides.iat ?? now,
    exp: overrides.exp ?? now + 600,
    scope: overrides.scope ?? 'agentpass:connect',
  };
  if (typeof overrides.azp === 'string') claims.azp = overrides.azp;
  else if (overrides.azp === undefined) claims.azp = 'claude-client';
  if (typeof overrides.client_id === 'string') claims.client_id = overrides.client_id;
  else if (overrides.client_id === undefined) claims.client_id = 'claude-client';
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: overrides.kid ?? 'fixture-key', typ: 'JWT' });
  const signingInput = `${header}.${encode(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(overrides.key ?? privateKey).toString('base64url')}`;
}

beforeAll(async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  jwk = keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk.kid = 'fixture-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  otherPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  server = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url === '/v1/me') {
      authorityRequests++;
      if (req.headers.authorization !== 'Bearer fixture-agent-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'DENIED', code: 'INVALID_CALLER', reason: 'invalid' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK', data: { principal_id: 'agent-fixture', organization_id: 'org-fixture', role: 'SERVICE', grants: [] } }));
      return;
    }
    res.writeHead(404).end();
  });
  issuer = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Auth0 human access-token verification (local JWKS fixture)', () => {
  it('accepts a signed token bound to the MCP resource, an allowed client, and the connect scope', async () => {
    const verify = createHumanTokenVerifier(config());
    const accepted = await verify(await token());
    expect(accepted).toEqual({ issuer: `${issuer}/`, subject: 'auth0|fixture-person', client_id: 'claude-client' });
  });

  it('supports a separately allowlisted first-party verifier without changing the MCP client allowlist', async () => {
    const verifyConsentToken = createHumanTokenVerifier({ ...config(), clientIds: ['first-party-consent'] });
    const accepted = await verifyConsentToken(await token({ azp: 'first-party-consent', client_id: 'first-party-consent' }));
    expect(accepted.client_id).toBe('first-party-consent');
  });

  it.each([
    ['wrong issuer', { iss: 'https://untrusted.example/' }],
    ['wrong resource audience', { aud: 'https://other.example/mcp' }],
    ['unapproved client', { azp: 'unknown-client', client_id: 'unknown-client' }],
    ['conflicting client claims', { azp: 'claude-client', client_id: 'chatgpt-client' }],
    ['missing client claims', { azp: null, client_id: null }],
    ['machine-to-machine subject', { sub: 'client-id@clients' }],
    ['missing connect scope', { scope: 'openid profile' }],
    ['overlong token', { scope: 'agentpass:connect'.padEnd(16 * 1024, 'x') }],
  ] as const)('rejects %s', async (_label, overrides) => {
    const signed = await token(overrides as Parameters<typeof token>[0]);
    await expect(createHumanTokenVerifier(config())(signed)).rejects.toBeDefined();
  });

  it('rejects expired, stale, and longer-than-ten-minute tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const verify = createHumanTokenVerifier(config());
    await expect(verify(await token({ iat: now - 700, exp: now - 100 }))).rejects.toBeDefined();
    await expect(verify(await token({ iat: now - 601, exp: now + 100 }))).rejects.toBeDefined();
    await expect(verify(await token({ iat: now, exp: now + 601 }))).rejects.toBeDefined();
  });

  it('rejects a token with a valid issuer and claims but an unknown signing key', async () => {
    const signed = await token({ key: otherPrivateKey, kid: 'untrusted-key' });
    await expect(createHumanTokenVerifier(config())(signed)).rejects.toBeDefined();
  });
});

describe('MCP OAuth provider and existing opaque agent credentials', () => {
  it('binds opaque keys through canonical /v1/me and maps the persisted service principal', async () => {
    const authorityUrl = issuer;
    const provider = createAgentPassOAuthProvider(config(), authorityUrl);
    const verified = await provider.createTokenVerifier(new URL(resource)).verifyAccessToken('fixture-agent-key');
    expect(verified.clientId).toBe('agent-fixture');
    expect(verified.scopes).toContain('agentpass:connect');
    expect(provider.mapAuthInfo(verified).user).toEqual({ id: 'agent-fixture', kind: 'AGENT', organization_id: 'org-fixture' });
    expect(authorityRequests).toBeGreaterThan(0);
  });

  it('never retries an invalid JWT as an opaque service key', async () => {
    authorityRequests = 0;
    const provider = createAgentPassOAuthProvider(config(), issuer);
    await expect(provider.createTokenVerifier(new URL(resource)).verifyAccessToken(await token({ aud: 'https://other.example/mcp' }))).rejects.toBeDefined();
    expect(authorityRequests).toBe(0);
  });

  it('requires the MCP SDK to use the same canonical resource as provider configuration', async () => {
    const provider = createAgentPassOAuthProvider(config(), issuer);
    await expect(provider.createTokenVerifier(new URL('https://other.example/mcp')).verifyAccessToken('fixture-agent-key')).rejects.toThrow(/canonical MCP endpoint/);
    expect(authorityRequests).toBe(0);
  });
});

describe('OAuth environment validation', () => {
  it('keeps legacy bearer-only startup when OAuth is absent and rejects partial/unsafe config', () => {
    expect(humanOAuthConfigFromEnv({})).toBeUndefined();
    expect(createHumanTokenVerifierFromEnv({})).toBeUndefined();
    expect(() => humanOAuthConfigFromEnv({ MCP_USE_OAUTH_AUTH0_DOMAIN: issuer })).toThrow(/together/);
    expect(() => humanOAuthConfigFromEnv({
      MCP_USE_OAUTH_AUTH0_DOMAIN: issuer,
      MCP_PUBLIC_URL: resource,
      AGENTPASS_OAUTH_CLIENT_IDS: 'chatgpt-client',
      MCP_USE_OAUTH_AUTH0_AUDIENCE: 'https://other.example/mcp',
    })).toThrow(/match/);
    expect(() => createHumanTokenVerifier({ ...config(), resource: 'https://agentpass.example/other' })).toThrow(/canonical \/mcp/);
  });
});

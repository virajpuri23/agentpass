import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuthorityStore } from '../../../db/store.js';
import { ConsentSessions } from './consent-sessions.js';

export const SUPABASE_AUTHORIZATION_PATH = '/onboarding/identity';

export interface SupabaseLoginConfig {
  origin: string;
  supabaseUrl: string;
  publishableKey: string;
  sessionKey: Buffer;
  clientIds: string[];
  redirectUris?: string[];
}

type IdentitySession = {
  phase: 'LOGIN' | 'OTP' | 'CONSENT';
  authorization_id: string;
  csrf: string;
  email?: string;
  access_token?: string;
};

class LoginError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const cookieName = 'agentpass_identity';
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!));
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const html = (title: string, content: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><main><h1>${escape(title)}</h1>${content}</main></html>`;

export function createSupabaseLoginRouter(
  db: AuthorityStore,
  config: SupabaseLoginConfig,
  now = () => new Date(),
  fetcher: typeof fetch = fetch,
) {
  const origin = new URL(config.origin);
  const supabaseUrl = new URL(config.supabaseUrl);
  const local = (url: URL) => ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (origin.origin !== config.origin || origin.username || origin.password || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local(origin)))) {
    throw new Error('Canonical HTTPS identity origin required');
  }
  if (supabaseUrl.username || supabaseUrl.password || supabaseUrl.search || supabaseUrl.hash ||
      !['', '/'].includes(supabaseUrl.pathname) ||
      (supabaseUrl.protocol !== 'https:' && !(supabaseUrl.protocol === 'http:' && local(supabaseUrl)))) {
    throw new Error('Canonical Supabase Auth URL required');
  }
  if (!config.publishableKey || config.sessionKey.length !== 32 || !config.clientIds.length ||
      config.clientIds.some(id => !id.trim()) || new Set(config.clientIds).size !== config.clientIds.length) {
    throw new Error('Supabase identity configuration is incomplete');
  }

  const responseParameters = new Set(['code', 'state', 'error', 'error_description']);
  const configuredRedirectUris = [new URL('/onboarding/callback', origin).href, ...(config.redirectUris ?? [])];
  for (const value of configuredRedirectUris) {
    const callback = new URL(value);
    if (callback.username || callback.password || callback.hash ||
        (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && local(callback))) ||
        [...callback.searchParams.keys()].some(key => responseParameters.has(key))) {
      throw new Error('A registered OAuth callback URI is invalid');
    }
  }

  const authBase = new URL('/auth/v1/', supabaseUrl);
  const sessions = new ConsentSessions(db, config.sessionKey, now);
  const router = express.Router();
  const cookie = (id: string) => `${cookieName}=${id}; HttpOnly; Secure; SameSite=Lax; Path=${SUPABASE_AUTHORIZATION_PATH}; Max-Age=${id ? 300 : 0}`;
  const sessionId = (req: express.Request) => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
  const route = (fn: (req: express.Request, res: express.Response) => Promise<void>) => async (req: express.Request, res: express.Response) => {
    try { await fn(req, res); }
    catch (error) {
      if (error instanceof LoginError) res.status(error.status).type('html').send(html('Sign-in unavailable', `<p>${escape(error.message)}</p>`));
      else if (error instanceof z.ZodError) res.status(400).type('html').send(html('Invalid request', '<p>Restart sign-in from the requesting application.</p>'));
      else res.status(503).type('html').send(html('Sign-in unavailable', '<p>Restart sign-in and try again.</p>'));
    }
  };
  router.use((_req, res, next) => {
    res.set({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    });
    next();
  });
  router.use(express.urlencoded({ extended: false, limit: '2kb' }));

  async function authRequest(path: string, options: { method?: 'GET' | 'POST'; accessToken?: string; body?: unknown } = {}) {
    const response = await fetcher(new URL(path, authBase), {
      method: options.method ?? 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        apikey: config.publishableKey,
        ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
        origin: origin.origin,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) throw new LoginError(503, 'Supabase authentication could not be completed.');
    try { return await response.json() as unknown; }
    catch { throw new LoginError(503, 'Supabase authentication returned an invalid response.'); }
  }

  const userSchema = z.object({
    id: z.string().min(1),
    email: z.string().email(),
    email_confirmed_at: z.string().nullable().optional(),
    confirmed_at: z.string().nullable().optional(),
  }).passthrough();
  async function verifiedUser(accessToken: string, expectedEmail: string) {
    const user = userSchema.parse(await authRequest('user', { accessToken }));
    if (!(user.email_confirmed_at || user.confirmed_at) || user.email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()) {
      throw new LoginError(403, 'Verify the email address before continuing.');
    }
    return user;
  }

  const detailsSchema = z.object({
    authorization_id: z.string().min(1).max(128),
    redirect_uri: z.string().url().max(2048),
    client: z.object({ id: z.string().min(1), name: z.string().optional() }).passthrough(),
    scope: z.string().optional(),
  }).passthrough();
  type AuthorizationDetails = z.infer<typeof detailsSchema>;
  type AuthorizationLookup = { kind: 'pending'; details: AuthorizationDetails } | { kind: 'redirect'; redirect_url: string };
  async function authorizationDetails(authorizationId: string, accessToken: string): Promise<AuthorizationLookup> {
    const result = await authRequest(`oauth/authorizations/${encodeURIComponent(authorizationId)}`, { accessToken });
    if (result && typeof result === 'object' && !('authorization_id' in result) && 'redirect_url' in result) {
      return { kind: 'redirect', redirect_url: validatedRedirect((result as { redirect_url: unknown }).redirect_url, configuredRedirectUris, 'return') };
    }
    const details = detailsSchema.parse(result);
    if (details.authorization_id !== authorizationId || !config.clientIds.includes(details.client.id)) {
      throw new LoginError(403, 'This OAuth client is not approved for sign-in.');
    }
    const callback = new URL(details.redirect_uri);
    if (callback.username || callback.password || callback.hash ||
        (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && local(callback)))) {
      throw new LoginError(403, 'The requesting application callback is invalid.');
    }
    return { kind: 'pending', details };
  }

  function validatedRedirect(value: unknown, callbackUris: string[], decision: 'approve' | 'deny' | 'return') {
    const redirectUrl = z.string().url().parse(
      typeof value === 'string' ? value : (value as { redirect_url?: unknown } | null)?.redirect_url,
    );
    const actual = new URL(redirectUrl);
    if (actual.username || actual.password || actual.hash) throw new LoginError(502, 'Supabase returned an unexpected OAuth callback.');
    for (const callbackUri of callbackUris) {
      const expected = new URL(callbackUri);
      if (expected.origin !== actual.origin || expected.pathname !== actual.pathname) continue;
      const fixed = new Map<string, string[]>();
      for (const [key, value] of expected.searchParams) fixed.set(key, [...(fixed.get(key) ?? []), value]);
      let matchesFixed = true;
      for (const [key, values] of fixed) {
        const actualValues = actual.searchParams.getAll(key);
        if (actualValues.length !== values.length || actualValues.some((value, index) => value !== values[index])) matchesFixed = false;
      }
      if (!matchesFixed) continue;
      const dynamicKeys = [...actual.searchParams.keys()].filter(key => !fixed.has(key));
      const allowedResponseParameters = decision === 'return'
        ? new Set(['code', 'state', 'error'])
        : responseParameters;
      if (dynamicKeys.some(key => !allowedResponseParameters.has(key)) ||
          dynamicKeys.some(key => actual.searchParams.getAll(key).length !== 1)) continue;
      const hasCode = actual.searchParams.has('code') && actual.searchParams.get('code') !== '';
      const hasError = actual.searchParams.has('error') && actual.searchParams.get('error') !== '';
      if (hasCode === hasError ||
          (decision === 'approve' && !hasCode) || (decision === 'deny' && !hasError) ||
          (actual.searchParams.has('state') && actual.searchParams.get('state') === '') ||
          (actual.searchParams.has('error_description') && !hasError)) continue;
      return redirectUrl;
    }
    throw new LoginError(502, 'Supabase returned an unexpected OAuth callback.');
  }

  function requireOrigin(req: express.Request) {
    if (req.get('origin') !== origin.origin) throw new LoginError(403, 'The sign-in request origin is invalid.');
  }
  async function requireSession(req: express.Request, phase: IdentitySession['phase']) {
    const id = sessionId(req), session = await sessions.read(id) as IdentitySession | null;
    if (!session || session.phase !== phase || !/^[A-Za-z0-9_-]{1,128}$/.test(session.authorization_id)) {
      throw new LoginError(401, 'This sign-in session expired. Restart from the requesting application.');
    }
    return { id, session };
  }
  function requireCsrf(body: { csrf: string }, session: IdentitySession) {
    if (!session.csrf || !equal(body.csrf, session.csrf)) throw new LoginError(403, 'The sign-in session or CSRF state is invalid.');
  }

  router.get('/', route(async (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'authorization_id')) throw new LoginError(400, 'Invalid authorization request.');
    const authorizationId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(req.query.authorization_id);
    const csrf = cryptoRandomToken();
    const id = await sessions.create({ phase: 'LOGIN', authorization_id: authorizationId, csrf });
    res.setHeader('set-cookie', cookie(id));
    res.type('html').send(html('Sign in to AgentPass', `<p>Verify your email to review the requesting application.</p><form method="post" action="${SUPABASE_AUTHORIZATION_PATH}/login"><input type="hidden" name="csrf" value="${escape(csrf)}"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="320" required><button type="submit">Send sign-in email</button></form>`));
  }));

  router.post('/login', route(async (req, res) => {
    requireOrigin(req);
    const body = z.object({ csrf: z.string().min(1).max(128), email: z.string().trim().email().max(320) }).strict().parse(req.body);
    const { id, session } = await requireSession(req, 'LOGIN');
    requireCsrf(body, session);
    if (!await sessions.consume(id)) throw new LoginError(403, 'This sign-in form was already used.');
    await authRequest('otp', { method: 'POST', body: { email: body.email, create_user: true } });
    const next = await sessions.create({ phase: 'OTP', authorization_id: session.authorization_id, email: body.email, csrf: cryptoRandomToken() });
    res.setHeader('set-cookie', cookie(next));
    res.redirect(303, `${SUPABASE_AUTHORIZATION_PATH}/verify`);
  }));

  router.get('/verify', route(async (req, res) => {
    const { session } = await requireSession(req, 'OTP');
    res.type('html').send(html('Verify your email', `<p>If the address can sign in, an email was sent to ${escape(session.email ?? '')}. Copy the sign-in link from that email and paste it below without opening it, or enter its numeric code.</p><form method="post" action="${SUPABASE_AUTHORIZATION_PATH}/verify"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><label for="token">Sign-in link or email code</label><input id="token" name="token" type="text" autocomplete="off" maxlength="1200" required><button type="submit">Verify email</button></form>`));
  }));

  router.post('/verify', route(async (req, res) => {
    requireOrigin(req);
    const body = z.object({ csrf: z.string().min(1).max(128), token: z.string().trim().min(1).max(1200) }).strict().parse(req.body);
    const { id, session } = await requireSession(req, 'OTP');
    requireCsrf(body, session);
    if (!session.email) throw new LoginError(401, 'This sign-in session expired.');
    let verification: Record<string, string> = { email: session.email, token: body.token, type: 'email' };
    if (!/^\d{6,8}$/.test(body.token)) {
      let link: URL;
      try { link = new URL(body.token); }
      catch { throw new LoginError(400, 'Paste the original sign-in link or email code.'); }
      const parameters = new Set(['token', 'type', 'redirect_to']);
      if (link.origin !== supabaseUrl.origin || link.pathname !== '/auth/v1/verify' || link.username || link.password || link.hash ||
          [...link.searchParams.keys()].some(key => !parameters.has(key) || link.searchParams.getAll(key).length !== 1) ||
          !['email', 'signup', 'magiclink'].includes(link.searchParams.get('type') ?? '') ||
          !/^[A-Za-z0-9_-]{20,256}$/.test(link.searchParams.get('token') ?? '')) {
        throw new LoginError(400, 'Paste the original sign-in link from this project.');
      }
      // Verify only the email token; never fetch or follow the submitted link or its redirect.
      verification = { token_hash: link.searchParams.get('token')!, type: 'email' };
    }
    if (!await sessions.consume(id)) throw new LoginError(403, 'This sign-in form was already used.');
    const tokenResponse = z.object({ access_token: z.string().min(1).max(16384) }).passthrough().parse(
      await authRequest('verify', { method: 'POST', body: verification }),
    );
    await verifiedUser(tokenResponse.access_token, session.email);
    const next = await sessions.create({ phase: 'CONSENT', authorization_id: session.authorization_id, email: session.email, access_token: tokenResponse.access_token, csrf: cryptoRandomToken() });
    res.setHeader('set-cookie', cookie(next));
    res.redirect(303, `${SUPABASE_AUTHORIZATION_PATH}/review`);
  }));

  router.get('/review', route(async (req, res) => {
    const { session } = await requireSession(req, 'CONSENT');
    if (!session.access_token || !session.email) throw new LoginError(401, 'This sign-in session expired.');
    await verifiedUser(session.access_token, session.email);
    const authorization = await authorizationDetails(session.authorization_id, session.access_token);
    if (authorization.kind === 'redirect') {
      const id = sessionId(req);
      if (!await sessions.consume(id)) throw new LoginError(401, 'This sign-in session expired.');
      res.setHeader('set-cookie', cookie(''));
      res.redirect(303, authorization.redirect_url);
      return;
    }
    const details = authorization.details;
    const scopes = (details.scope ?? '').trim().split(/\s+/).filter(Boolean);
    const scopeHtml = scopes.length ? `<ul>${scopes.map(scope => `<li>${escape(scope)}</li>`).join('')}</ul>` : '<p>No additional scopes requested.</p>';
    const clientName = details.client.name?.trim() || details.client.id;
    res.type('html').send(html('Review sign-in request', `<p><strong>Application:</strong> ${escape(clientName)}</p><p><strong>Client ID:</strong> ${escape(details.client.id)}</p><p><strong>Redirect URI:</strong> ${escape(details.redirect_uri)}</p><p><strong>Requested permissions:</strong></p>${scopeHtml}<form method="post" action="${SUPABASE_AUTHORIZATION_PATH}/decision"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form>`));
  }));

  router.post('/decision', route(async (req, res) => {
    requireOrigin(req);
    const body = z.object({ csrf: z.string().min(1).max(128), decision: z.enum(['approve', 'deny']) }).strict().parse(req.body);
    const { id, session } = await requireSession(req, 'CONSENT');
    requireCsrf(body, session);
    if (!session.access_token || !session.email || !await sessions.consume(id)) throw new LoginError(403, 'This consent form was already used.');
    await verifiedUser(session.access_token, session.email);
    const authorization = await authorizationDetails(session.authorization_id, session.access_token);
    if (authorization.kind === 'redirect') {
      res.setHeader('set-cookie', cookie(''));
      res.redirect(303, authorization.redirect_url);
      return;
    }
    const result = await authRequest(`oauth/authorizations/${encodeURIComponent(session.authorization_id)}/consent`, {
      method: 'POST', accessToken: session.access_token, body: { action: body.decision },
    });
    const redirectUrl = validatedRedirect(result, [authorization.details.redirect_uri], body.decision);
    res.setHeader('set-cookie', cookie(''));
    res.redirect(303, redirectUrl);
  }));

  return router;
}

function cryptoRandomToken() {
  return randomBytes(32).toString('base64url');
}

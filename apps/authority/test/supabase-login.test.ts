import express from 'express';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { migrateStore } from '../../../db/migrations.js';
import { sqliteStore } from '../../../db/store.js';
import { createSupabaseLoginRouter } from '../src/supabase-login.js';

const origin = 'https://authority.example';
const accessToken = 'supabase-user-access-token-fixture';
const email = 'person@example.test';

describe('Supabase identity and OAuth consent UI', () => {
  let db: ReturnType<typeof openDatabase>;
  let server: ReturnType<express.Express['listen']> | undefined;
  let baseUrl: string;
  let calls: Array<{ path: string; method: string; authorization: string | null; apikey: string | null; origin: string | null; body: any }>;
  let oauthClientId: string;
  let callbackResult: string;
  let userConfirmedAt: string | null;
  let authorizationLookupResponse: unknown | undefined;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    await migrateStore(sqliteStore(db), 'sqlite');
    calls = [];
    oauthClientId = 'trusted-mcp-client';
    callbackResult = 'https://client.example/callback?code=oauth-code-fixture&state=original-state';
    userConfirmedAt = '2026-10-17T23:30:00.000Z';
    authorizationLookupResponse = undefined;
    const provider: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      let body: any = null;
      if (typeof init?.body === 'string') body = JSON.parse(init.body);
      calls.push({ path: url.pathname, method, authorization: headers.get('authorization'), apikey: headers.get('apikey'), origin: headers.get('origin'), body });

      if (url.pathname === '/auth/v1/otp' && method === 'POST') return Response.json({ message_id: 'fixture-message' });
      if (url.pathname === '/auth/v1/verify' && method === 'POST') return Response.json({ access_token: accessToken, token_type: 'bearer' });
      if (url.pathname === '/auth/v1/user' && method === 'GET') return Response.json({
        id: 'supabase-user-id-fixture', email, email_confirmed_at: userConfirmedAt, confirmed_at: userConfirmedAt,
      });
      if (url.pathname === '/auth/v1/oauth/authorizations/authz-fixture' && method === 'GET') return Response.json(authorizationLookupResponse ?? {
          authorization_id: 'authz-fixture',
          redirect_uri: 'https://client.example/callback',
          client: { id: oauthClientId, name: 'Trusted <MCP> client' },
          scope: 'openid email profile',
        });
      if (url.pathname === '/auth/v1/oauth/authorizations/authz-fixture/consent' && method === 'POST') return Response.json({ redirect_url: callbackResult });
      return Response.json({ message: 'not found' }, { status: 404 });
    };

    const app = express();
    app.use('/onboarding/identity', createSupabaseLoginRouter(sqliteStore(db), {
      origin,
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_fixture',
      sessionKey: randomBytes(32),
      clientIds: ['trusted-mcp-client', 'agentpass-first-party-consent'],
      redirectUris: ['https://client.example/callback?tenant=trusted'],
    }, () => new Date('2026-10-17T23:30:00.000Z'), provider));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    db.close();
  });

  function cookiePair(response: Response) {
    const value = response.headers.get('set-cookie');
    expect(value).toBeTruthy();
    return value!.split(';')[0]!;
  }

  function csrfFrom(body: string) {
    const match = body.match(/name="csrf" value="([^"]+)"/);
    expect(match).toBeTruthy();
    return match![1]!;
  }

  function post(path: string, cookie: string, body: Record<string, string>, requestOrigin = origin) {
    return fetch(`${baseUrl}/onboarding/identity${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, origin: requestOrigin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
  }

  async function authenticatedReview() {
    const start = await fetch(`${baseUrl}/onboarding/identity?authorization_id=authz-fixture`, { redirect: 'manual' });
    expect(start.status).toBe(200);
    const loginCookie = cookiePair(start);
    const loginForm = await start.text();
    const sent = await post('/login', loginCookie, { csrf: csrfFrom(loginForm), email });
    expect(sent.status).toBe(303);
    const otpCookie = cookiePair(sent);
    const codeForm = await fetch(`${baseUrl}/onboarding/identity/verify`, { headers: { cookie: otpCookie } });
    expect(codeForm.status).toBe(200);
    const verified = await post('/verify', otpCookie, { csrf: csrfFrom(await codeForm.text()), token: '12345678' });
    expect(verified.status).toBe(303);
    const consentCookie = cookiePair(verified);
    const review = await fetch(`${baseUrl}/onboarding/identity/review`, { headers: { cookie: consentCookie }, redirect: 'manual' });
    return { cookie: consentCookie, page: review, text: await review.text() };
  }

  it('sends an email OTP, verifies the provider user, displays trusted consent, and redirects only to the registered callback', async () => {
    const start = await fetch(`${baseUrl}/onboarding/identity?authorization_id=authz-fixture`, { redirect: 'manual' });
    expect(start.status).toBe(200);
    const firstCookie = cookiePair(start);
    expect(start.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax; Path=/onboarding/identity; Max-Age=300');
    const startPage = await start.text();
    const csrf = csrfFrom(startPage);

    const firstSession = db.prepare('SELECT payload_ciphertext FROM consent_sessions').get() as { payload_ciphertext: string };
    expect(firstSession.payload_ciphertext).not.toContain('authz-fixture');

    const sendCode = await post('/login', firstCookie, { csrf, email });
    expect(sendCode.status).toBe(303);
    expect(sendCode.headers.get('location')).toBe('/onboarding/identity/verify');
    const otpCookie = cookiePair(sendCode);
    expect(otpCookie).not.toBe(firstCookie);
    expect(calls.find(call => call.path === '/auth/v1/otp')).toMatchObject({
      method: 'POST', authorization: null, apikey: 'sb_publishable_fixture', origin,
      body: { email, create_user: true },
    });

    const codePage = await fetch(`${baseUrl}/onboarding/identity/verify`, { headers: { cookie: otpCookie } });
    const verify = await post('/verify', otpCookie, { csrf: csrfFrom(await codePage.text()), token: '12345678' });
    expect(verify.status).toBe(303);
    const consentCookie = cookiePair(verify);
    expect(consentCookie).not.toBe(otpCookie);
    expect(calls.find(call => call.path === '/auth/v1/verify')).toMatchObject({
      method: 'POST', authorization: null, apikey: 'sb_publishable_fixture', body: { email, token: '12345678', type: 'email' },
    });
    expect(calls.find(call => call.path === '/auth/v1/user')).toMatchObject({
      method: 'GET', authorization: `Bearer ${accessToken}`, apikey: 'sb_publishable_fixture', origin,
    });

    const storedSession = db.prepare('SELECT payload_ciphertext FROM consent_sessions').get() as { payload_ciphertext: string };
    expect(storedSession.payload_ciphertext).not.toContain(accessToken);
    expect(storedSession.payload_ciphertext).not.toContain('authz-fixture');

    const review = await fetch(`${baseUrl}/onboarding/identity/review`, { headers: { cookie: consentCookie } });
    expect(review.status).toBe(200);
    const reviewPage = await review.text();
    expect(reviewPage).toContain('Trusted &lt;MCP&gt; client');
    expect(reviewPage).toContain('https://client.example/callback');
    expect(reviewPage).toContain('<li>openid</li>');
    expect(reviewPage).toContain('<li>email</li>');
    expect(reviewPage).not.toContain(accessToken);
    expect(calls.find(call => call.path.endsWith('/oauth/authorizations/authz-fixture'))).toMatchObject({
      method: 'GET', authorization: `Bearer ${accessToken}`, apikey: 'sb_publishable_fixture', origin,
    });

    const decision = await post('/decision', consentCookie, { csrf: csrfFrom(reviewPage), decision: 'approve' });
    expect(decision.status).toBe(303);
    expect(decision.headers.get('location')).toBe(callbackResult);
    expect(decision.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(calls.find(call => call.path.endsWith('/consent'))).toMatchObject({
      method: 'POST', authorization: `Bearer ${accessToken}`, apikey: 'sb_publishable_fixture', origin,
      body: { action: 'approve' },
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM grants').get() as { count: number }).count).toBe(0);

    const replay = await post('/decision', consentCookie, { csrf: csrfFrom(reviewPage), decision: 'approve' });
    expect(replay.status).toBe(401);
    expect(calls.filter(call => call.path.endsWith('/consent'))).toHaveLength(1);
  });

  it('requires exact Origin and one-use CSRF state before sending an OTP', async () => {
    const start = await fetch(`${baseUrl}/onboarding/identity?authorization_id=authz-fixture`, { redirect: 'manual' });
    const cookie = cookiePair(start), csrf = csrfFrom(await start.text());

    expect((await post('/login', cookie, { csrf, email }, 'https://attacker.example')).status).toBe(403);
    expect((await post('/login', cookie, { csrf: 'wrong-csrf', email })).status).toBe(403);
    expect(calls.filter(call => call.path === '/auth/v1/otp')).toHaveLength(0);

    const accepted = await post('/login', cookie, { csrf, email });
    expect(accepted.status).toBe(303);
    expect((await post('/login', cookie, { csrf, email })).status).toBe(401);
    expect(calls.filter(call => call.path === '/auth/v1/otp')).toHaveLength(1);
  });

  it('blocks an OAuth client outside the configured allowlist', async () => {
    oauthClientId = 'untrusted-mcp-client';
    const flow = await authenticatedReview();
    expect(flow.page.status).toBe(403);
    expect(flow.text).toContain('not approved');
    expect(calls.filter(call => call.path.endsWith('/consent'))).toHaveLength(0);
  });

  it.each([
    'https://attacker.example/callback?code=stolen-code&state=original-state',
    'https://client.example/different?code=stolen-code&state=original-state',
    'https://client.example/callback?code=stolen-code&state=original-state&next=https%3A%2F%2Fattacker.example',
  ])('does not redirect when Supabase returns an untrusted callback: %s', async returnedUrl => {
    callbackResult = returnedUrl;
    const flow = await authenticatedReview();
    expect(flow.page.status).toBe(200);
    const decision = await post('/decision', flow.cookie, { csrf: csrfFrom(flow.text), decision: 'approve' });
    expect(decision.status).toBe(502);
    expect(decision.headers.get('location')).toBeNull();
  });

  it('posts an explicit denial and redirects only to the registered callback', async () => {
    callbackResult = 'https://client.example/callback?error=access_denied&error_description=User%20denied&state=original-state';
    const flow = await authenticatedReview();
    expect(flow.page.status).toBe(200);
    const denied = await post('/decision', flow.cookie, { csrf: csrfFrom(flow.text), decision: 'deny' });
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe(callbackResult);
    expect(calls.find(call => call.path.endsWith('/consent'))?.body).toEqual({ action: 'deny' });
  });

  it('returns a previously approved request only to an exact server-registered callback', async () => {
    const previouslyApproved = 'https://client.example/callback?tenant=trusted&code=existing-code&state=original-state';
    authorizationLookupResponse = {
      redirect_url: previouslyApproved,
    };
    const flow = await authenticatedReview();
    expect(flow.page.status).toBe(303);
    expect(flow.page.headers.get('location')).toBe(previouslyApproved);
    expect(flow.page.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(calls.filter(call => call.path.endsWith('/consent'))).toHaveLength(0);
  });

  it('handles approval appearing between review and decision without posting another consent action', async () => {
    const previouslyApproved = 'https://client.example/callback?tenant=trusted&code=existing-code&state=original-state';
    const flow = await authenticatedReview();
    expect(flow.page.status).toBe(200);
    authorizationLookupResponse = {
      redirect_url: previouslyApproved,
    };
    const decision = await post('/decision', flow.cookie, { csrf: csrfFrom(flow.text), decision: 'approve' });
    expect(decision.status).toBe(303);
    expect(decision.headers.get('location')).toBe(previouslyApproved);
    expect(calls.filter(call => call.path.endsWith('/consent'))).toHaveLength(0);
  });

  it.each([
    'https://attacker.example/callback?code=stolen&state=original-state',
    'https://client.example/callback?code=existing-code&state=original-state',
    'https://client.example/callback?tenant=attacker&code=existing-code&state=original-state',
    'https://client.example/callback?tenant=trusted&code=existing-code&state=original-state&next=https%3A%2F%2Fattacker.example',
    'https://client.example/callback?tenant=trusted&error=access_denied&state=original-state&error_description=Denied',
  ])('rejects previously approved callback outside the allowlist or response contract: %s', async returnedUrl => {
    authorizationLookupResponse = {
      redirect_url: returnedUrl,
    };
    const flow = await authenticatedReview();
    expect(flow.page.status).toBe(502);
    expect(flow.page.headers.get('location')).toBeNull();
    expect(calls.filter(call => call.path.endsWith('/consent'))).toHaveLength(0);
  });

  it('requires the Supabase user endpoint to confirm the submitted email before OAuth consent', async () => {
    userConfirmedAt = null;
    const start = await fetch(`${baseUrl}/onboarding/identity?authorization_id=authz-fixture`, { redirect: 'manual' });
    const login = await post('/login', cookiePair(start), { csrf: csrfFrom(await start.text()), email });
    const otpCookie = cookiePair(login);
    const codePage = await fetch(`${baseUrl}/onboarding/identity/verify`, { headers: { cookie: otpCookie } });
    const verify = await post('/verify', otpCookie, { csrf: csrfFrom(await codePage.text()), token: '12345678' });
    expect(verify.status).toBe(403);
    expect(calls.filter(call => call.path.includes('/oauth/authorizations/'))).toHaveLength(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM consent_sessions').get() as { count: number }).count).toBe(0);
  });
});

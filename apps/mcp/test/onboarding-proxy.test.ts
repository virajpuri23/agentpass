import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOnboardingProxy } from '../agentpass-manufact/src/onboarding-proxy.js';

let authority: Server;
let authorityUrl = '';
let requests: Array<{ method: string; url: string | undefined; headers: Record<string, string | string[] | undefined>; body: string }> = [];

beforeAll(async () => {
  authority = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(303, {
        location: 'https://login.example/authorize?state=fixture',
        'set-cookie': ['agentpass_consent=fixture; HttpOnly; Secure; SameSite=Lax; Path=/onboarding', 'second=fixture; Secure; Path=/onboarding'],
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      res.end();
    });
  });
  authority.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { authority.once('listening', resolve); authority.once('error', reject); });
  authorityUrl = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => authority.close(() => resolve()));
});

describe('trusted onboarding consent proxy', () => {
  it('forwards only cookie, origin and content type, preserves redirect/cookies, and adds security headers', async () => {
    requests = [];
    const mcpOrigin = 'https://mcp.example';
    const proxy = createOnboardingProxy(authorityUrl);
    const response = await proxy(new Request(`${mcpOrigin}/onboarding/?connection=connection-1`, {
      headers: {
        authorization: 'Bearer must-not-forward',
        cookie: 'agentpass_consent=prior',
        origin: mcpOrigin,
        'content-type': 'application/x-www-form-urlencoded',
        'x-untrusted-forwarded': 'ignored',
      },
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://login.example/authorize?state=fixture');
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/onboarding/?connection=connection-1' });
    expect(requests[0].headers).toMatchObject({ cookie: 'agentpass_consent=prior', origin: mcpOrigin, 'content-type': 'application/x-www-form-urlencoded' });
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[0].headers['x-untrusted-forwarded']).toBeUndefined();
  });

  it('forwards a bounded approval form body', async () => {
    requests = [];
    const proxy = createOnboardingProxy(authorityUrl);
    const body = 'csrf=fixture&budget=0.00';
    const response = await proxy(new Request('https://mcp.example/onboarding/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://mcp.example' },
      body,
    }));
    expect(response.status).toBe(303);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/onboarding/approve', body });
  });

  it('rejects methods and bodies over two KiB without contacting the authority', async () => {
    requests = [];
    const proxy = createOnboardingProxy(authorityUrl);
    const method = await proxy(new Request('https://mcp.example/onboarding/approve', { method: 'PUT' }));
    const oversized = await proxy(new Request('https://mcp.example/onboarding/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'x'.repeat(2049),
    }));
    expect(method.status).toBe(405);
    expect(oversized.status).toBe(413);
    expect(requests).toEqual([]);
  });
});

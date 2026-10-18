/**
 * B's protected workforce gateway as an HTTP service: service-key auth,
 * contract validation, own path validation (fail closed), dedup by
 * execution_id. Exercised the way AgentPass calls it (docs/11), plus one
 * real end-to-end hop: AgentPass configured from environment → HTTP → gateway.
 */
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workforceFromEnvironment } from '../../authority/src/workforce-client.js';
import { createGatewayService, requestedPaths, type GatewayService } from '../src/gateway-service.js';
import { RealWorkforceAuthority } from '../src/real/authority.js';
import { copyDemoProject, cred, startAgentPass, type AgentPassFixture } from './helpers.js';

const KEY = cred();
const principal = { id: 'buyer-agent', organization_id: 'buyer-co', kind: 'AGENT', role: 'BUYER' } as const;
let root: string;
let service: GatewayService;
let base: string;
let server: import('node:http').Server;

const call = (path: string, body?: unknown, key: string | null = KEY) => fetch(`${base}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'x-service-key': key } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const envelope = (execution_id: string, input: Record<string, unknown>) => ({ execution_id, principal, input: { grant_id: 'grant-root-lead', resource: 'demo-project', idempotency_key: `k-${execution_id}`, ...input } });

beforeAll(async () => {
  root = copyDemoProject('agentpass-gateway-');
  service = createGatewayService({ serviceKey: KEY, repoRoot: root, analyticsFile: join(root, 'data/analytics-events.json'), organization_id: 'buyer-co', owner_principal_id: 'owner-1', requestLog: false });
  server = await new Promise((r) => { const s = service.app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await service.stop(); await new Promise((r) => server.close(r)); rmSync(root, { recursive: true, force: true }); });

describe('gateway service', () => {
  it('serves health without a key', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'OK', resource: 'demo-project' });
  });

  it('refuses a missing or wrong service key with 401 and performs nothing', async () => {
    const body = envelope('exec-unauth', { action: 'repo.read', parameters: { path: 'package.json' } });
    expect((await call('/internal/workforce/execute', body, null)).status).toBe(401);
    const wrong = await call('/internal/workforce/execute', body, 'not-the-key');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ status: 'DENIED', code: 'INVALID_CALLER' });
    expect(service.executions()).toBe(0);
  });

  it('performs a valid repo.read and returns the public result in the OK envelope', async () => {
    const res = await call('/internal/workforce/execute', envelope('exec-read-1', { action: 'repo.read', parameters: { path: 'src/lib/newsletter.ts' } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('OK');
    expect(json.data.path).toBe('src/lib/newsletter.ts');
    expect(json.data.content).toBe(readFileSync(join(root, 'src/lib/newsletter.ts'), 'utf8'));
  });

  it('fails closed on traversal, dotfiles, absolute paths and symlinks (400, nothing executed)', async () => {
    symlinkSync(join(root, '.env'), join(root, 'src', 'linked.ts'));
    const bad = ['../package.json', '.env', 'src/../.env', '/etc/hosts', 'src/linked.ts', 'src/.hidden/x.ts'];
    for (const path of bad) {
      const res = await call('/internal/workforce/execute', envelope(`exec-bad-${path}`, { action: 'repo.read', parameters: { path } }));
      expect(res.status, path).toBe(400);
      const json = await res.json();
      expect(json).toMatchObject({ status: 'ERROR', code: 'INVALID_REQUEST' });
      expect(JSON.stringify(json), path).not.toMatch(/FAKE_FIXTURE|\/Users|\/tmp|\/private/);
    }
    // security.audit.run validates every listed path, not only the first.
    const audit = await call('/internal/workforce/execute', envelope('exec-bad-audit', { action: 'security.audit.run', parameters: { paths: ['package.json', '.env'] } }));
    expect(audit.status).toBe(400);
    expect(service.executions()).toBe(1); // only exec-read-1 so far
  });

  it('rejects envelopes that do not match the contract (unknown action, extra parameter, wrong resource)', async () => {
    for (const input of [
      { action: 'shell.run', parameters: { cmd: 'ls' } },
      { action: 'repo.read', parameters: { path: 'package.json', url: 'https://evil.invalid' } },
      { action: 'repo.read', resource: 'other-project', parameters: { path: 'package.json' } },
      { action: 'deploy.production', parameters: { environment: 'production', artifact_digest: 'a'.repeat(64) } },
    ]) {
      const res = await call('/internal/workforce/execute', envelope(`exec-shape-${JSON.stringify(input).length}`, input));
      expect(res.status, JSON.stringify(input)).toBe(400);
    }
    expect((await call('/internal/workforce/execute', { execution_id: 'x', input: {} })).status).toBe(400);
  });

  it('replays the same execution_id from memory without re-executing', async () => {
    const file = join(root, 'src/components/Hero.tsx');
    const original = readFileSync(file, 'utf8');
    const first = await (await call('/internal/workforce/execute', envelope('exec-replay', { action: 'repo.read', parameters: { path: 'src/components/Hero.tsx' } }))).json();
    expect(first.data.content).toBe(original);
    const before = service.executions();
    writeFileSync(file, original + '\n// changed after the first execution\n');
    const again = await (await call('/internal/workforce/execute', envelope('exec-replay', { action: 'repo.read', parameters: { path: 'src/components/Hero.tsx' } }))).json();
    expect(again).toEqual(first); // the first result, not the changed file
    expect(service.executions()).toBe(before);
    // A write replay must not write twice either.
    const w = envelope('exec-write-once', { action: 'repo.write', parameters: { path: 'src/components/Hero.tsx', content: original } });
    expect((await (await call('/internal/workforce/execute', w)).json()).data.bytes).toBe(Buffer.byteLength(original));
    writeFileSync(file, 'overwritten between replays');
    expect((await (await call('/internal/workforce/execute', w)).json()).data.bytes).toBe(Buffer.byteLength(original));
    expect(readFileSync(file, 'utf8')).toBe('overwritten between replays');
  });

  it('derives paths exactly like AgentPass', () => {
    expect(requestedPaths({ grant_id: 'g', resource: 'r', idempotency_key: 'k', action: 'repo.write', parameters: { path: 'a.ts', content: '' } })).toEqual(['a.ts']);
    expect(requestedPaths({ grant_id: 'g', resource: 'r', idempotency_key: 'k', action: 'security.audit.run', parameters: { paths: ['a.ts', 'b.ts'] } })).toEqual(['a.ts', 'b.ts']);
    expect(requestedPaths({ grant_id: 'g', resource: 'r', idempotency_key: 'k', action: 'analytics.raw.read', parameters: {} })).toEqual([]);
  });
});

describe('AgentPass → HTTP → gateway (the hosted configuration, locally)', () => {
  let agentpass: AgentPassFixture;
  beforeAll(async () => {
    const env = {
      WORKFORCE_RESOURCES_JSON: JSON.stringify([{ resource: 'demo-project', organization_id: 'buyer-co', owner_principal_id: 'owner-1', repo_root: root, allowed_actions: ['repo.read', 'repo.write', 'security.audit.run', 'deploy.preview', 'analytics.aggregate.read'] }]),
      WORKFORCE_GATEWAY_URL: base, WORKFORCE_SERVICE_KEY: KEY,
    };
    agentpass = await startAgentPass(root, workforceFromEnvironment(env)!);
  });
  afterAll(async () => { await agentpass.stop(); });

  it('executes a granted read through the remote gateway and refuses an ungranted path before any HTTP call', async () => {
    const auth = new RealWorkforceAuthority({ authorityUrl: agentpass.url, identity: { organization_id: 'buyer-co', owner_principal_id: 'owner-1' } });
    const lead = await auth.connect(agentpass.keys.lead);
    expect(lead.status).toBe('OK');
    if (lead.status !== 'OK') throw new Error('lead connect failed');
    const session = lead.data as import('../src/real/authority.js').RealSession;
    const before = service.executions();
    const ok = await session.execute({ grant_id: agentpass.rootGrantId, action: 'repo.read', resource: 'package.json', parameters: {}, idempotency_key: 'remote-read-1' });
    if (ok.status !== 'OK') throw new Error(`execute failed: ${ok.code}`);
    expect(String(ok.data.result.content)).toContain('"name"');
    expect(service.executions()).toBe(before + 1);
    // Outside the root grant's paths: AgentPass denies; the gateway never sees it.
    const denied = await session.execute({ grant_id: agentpass.rootGrantId, action: 'repo.read', resource: 'data/analytics-events.json', parameters: {}, idempotency_key: 'remote-read-2' });
    expect(denied.status).not.toBe('OK');
    expect(service.executions()).toBe(before + 1);
    // Same idempotency key at AgentPass: replayed from its ledger, the gateway is not called again.
    const replay = await session.execute({ grant_id: agentpass.rootGrantId, action: 'repo.read', resource: 'package.json', parameters: {}, idempotency_key: 'remote-read-1' });
    expect(replay.status).toBe('OK');
    expect(service.executions()).toBe(before + 1);
  });
});

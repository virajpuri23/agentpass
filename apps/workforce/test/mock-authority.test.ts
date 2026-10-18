/**
 * Rules the workforce authority must enforce. Written against the MOCK; the
 * same suite is the acceptance bar for Developer A's real implementation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult, WorkforceScope, WorkforceSession } from '../src/contract.js';
import { MockWorkforceAuthority } from '../src/mock-authority.js';
import { isSubset, resourceMatches } from '../src/scope.js';

const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const ROOT: WorkforceScope = {
  actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'],
  resources: ['src/**', 'public/**', 'package.json', 'preview', 'landing-page'],
  expires_at: later(60), max_delegation_depth: 2,
};
const uiScope = (over: Partial<WorkforceScope> = {}): WorkforceScope => ({
  actions: ['repo.read', 'repo.write'], resources: ['src/components/**', 'src/styles/**'], expires_at: later(30), max_delegation_depth: 0, ...over,
});

let auth: MockWorkforceAuthority;
let owner: WorkforceSession, lead: WorkforceSession, design: WorkforceSession, hosting: WorkforceSession;
let rootId: string;

const ok = async <T>(p: Promise<ApiResult<T>>): Promise<T> => {
  const r = await p;
  expect(r.status, JSON.stringify(r)).toBe('OK');
  return (r as { data: T }).data;
};
/** Error code of a result, or 'OK' when it succeeded. */
const code = (r: ApiResult<unknown>) => (r.status === 'OK' ? 'OK' : r.code);

beforeEach(async () => {
  auth = new MockWorkforceAuthority();
  for (const [id, credential] of [['owner-1', 'k-owner'], ['lead-agent', 'k-lead'], ['design-agent', 'k-design'], ['hosting-agent', 'k-hosting']]) {
    auth.addPrincipal({ id: id!, organization_id: 'acme', credential: credential! });
  }
  rootId = auth.issueRoot({ id: 'grant-root-lead', issuer: 'owner-1', subject: 'lead-agent', organization_id: 'acme', scope: ROOT }).id;
  owner = await ok(auth.connect('k-owner'));
  lead = await ok(auth.connect('k-lead'));
  design = await ok(auth.connect('k-design'));
  hosting = await ok(auth.connect('k-hosting'));
});

describe('resource globs', () => {
  it('match within allow-lists and never across them', () => {
    expect(resourceMatches('src/components/**', 'src/components/Hero.tsx')).toBe(true);
    expect(resourceMatches('src/components/**', 'src/components/nested/Cta.tsx')).toBe(true);
    expect(resourceMatches('src/components/**', 'src/lib/db.ts')).toBe(false);
    expect(resourceMatches('src/components/**', '.env')).toBe(false);
    expect(resourceMatches('src/*.css', 'src/app.css')).toBe(true);
    expect(resourceMatches('src/*.css', 'src/deep/app.css')).toBe(false);
  });
  it('treats an empty resource list as nothing, not everything', () => {
    expect(isSubset(uiScope({ resources: [] }), ROOT).ok).toBe(false);
  });
});

describe('identity and delegation', () => {
  it('rejects unknown credentials', async () => {
    expect((await auth.connect('nope')).status).toBe('DENIED');
  });
  it('binds identity to the credential, so a session cannot act on grants it does not hold', async () => {
    const r = await design.delegate({ parent_grant_id: rootId, recipient_principal_id: 'hosting-agent', scope: uiScope() });
    expect(r).toMatchObject({ status: 'DENIED', code: 'INVALID_CALLER' });
  });
  it('delegates strict subsets only', async () => {
    const g = await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'design-agent', scope: uiScope() }));
    expect(g.subject_principal_id).toBe('design-agent');
    for (const bad of [
      uiScope({ actions: ['repo.read', 'repo.write', 'deploy.production'] }),
      uiScope({ resources: ['src/**', '.env'] }),
      uiScope({ expires_at: later(120) }),
      uiScope({ max_delegation_depth: 2 }),
    ]) {
      expect(code(await lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'design-agent', scope: bad }))).toBe('OUTSIDE_PARENT_SCOPE');
    }
  });
});

describe('authorize', () => {
  it('allows in-scope actions and denies out-of-scope resources (.env) without a recovery hint', async () => {
    const g = await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'design-agent', scope: uiScope() }));
    const a = await ok(design.authorize({ grant_id: g.id, action: 'repo.write', resource: 'src/components/Hero.tsx' }));
    expect(a.chain).toEqual([rootId, g.id]);
    const env = await design.authorize({ grant_id: g.id, action: 'repo.read', resource: '.env' });
    expect(env).toMatchObject({ status: 'DENIED', code: 'RESOURCE_DENIED' });
    expect((env as any).next_action).not.toBe('request_authority');
    const lib = await design.authorize({ grant_id: g.id, action: 'repo.write', resource: 'src/lib/db.ts' });
    expect(code(lib)).toBe('RESOURCE_DENIED');
  });
  it('refuses deploy.production with a recoverable hint pointing at deploy.preview', async () => {
    const g = await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'hosting-agent', scope: { actions: ['repo.read'], resources: ['src/**', 'package.json'], expires_at: later(30), max_delegation_depth: 0 } }));
    const r = await hosting.authorize({ grant_id: g.id, action: 'deploy.production', resource: 'production' });
    expect(r).toMatchObject({ status: 'AUTHORITY_REQUIRED', code: 'INSUFFICIENT_SCOPE', next_action: 'request_authority' });
    expect((r as any).alternative_scope.actions).toEqual(['deploy.preview']);
  });
  it('denies a session that passes a grant it does not hold', async () => {
    const g = await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'design-agent', scope: uiScope() }));
    expect(code(await hosting.authorize({ grant_id: g.id, action: 'repo.read', resource: 'src/components/Hero.tsx' }))).toBe('INVALID_CALLER');
  });
});

describe('negotiation', () => {
  it('child requests, parent counteroffers narrower, child accepts; production is never offered', async () => {
    const g = await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'hosting-agent', scope: { actions: ['repo.read'], resources: ['src/**'], expires_at: later(30), max_delegation_depth: 0 } }));
    const preview: WorkforceScope = { actions: ['deploy.preview'], resources: ['preview'], expires_at: later(30), max_delegation_depth: 0 };
    const req = await ok(hosting.requestAuthority({ parent_grant_id: rootId, requested_scope: preview, reason: 'Production was refused; preview is the permitted alternative' }));
    expect(code(await hosting.respond({ request_id: req.request_id, decision: 'COUNTEROFFER', offered_scope: preview }))).toBe('INVALID_CALLER');
    const prod = { ...preview, actions: ['deploy.production' as const], resources: ['production'] };
    expect(code(await lead.respond({ request_id: req.request_id, decision: 'COUNTEROFFER', offered_scope: prod }))).toBe('OUTSIDE_PARENT_SCOPE');
    const offered = await ok(lead.respond({ request_id: req.request_id, decision: 'COUNTEROFFER', offered_scope: { ...preview, expires_at: later(10) } }));
    expect(offered.status).toBe('COUNTEROFFERED');
    const issued = await ok(hosting.accept({ request_id: req.request_id, idempotency_key: 'accept-1' }));
    expect(issued.subject_principal_id).toBe('hosting-agent');
    expect((await ok(hosting.accept({ request_id: req.request_id, idempotency_key: 'accept-1' }))).id).toBe(issued.id);
    await ok(hosting.authorize({ grant_id: issued.id, action: 'deploy.preview', resource: 'preview' }));
    expect((await hosting.authorize({ grant_id: g.id, action: 'deploy.preview', resource: 'preview' })).status).toBe('AUTHORITY_REQUIRED');
  });
  it('only an existing child of the parent grant may request', async () => {
    const r = await design.requestAuthority({ parent_grant_id: rootId, requested_scope: uiScope(), reason: 'x' });
    expect(code(r)).toBe('INVALID_CALLER');
  });
});

describe('revocation', () => {
  it('revoked and descendant grants stop authorizing; reuse fails', async () => {
    const g = await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'design-agent', scope: uiScope() }));
    await ok(design.authorize({ grant_id: g.id, action: 'repo.read', resource: 'src/components/Hero.tsx' }));
    expect(code(await design.revoke({ grant_id: rootId, reason: 'nope' }))).toBe('INVALID_CALLER');
    await ok(lead.revoke({ grant_id: g.id, reason: 'done' }));
    expect(code(await design.authorize({ grant_id: g.id, action: 'repo.read', resource: 'src/components/Hero.tsx' }))).toBe('GRANT_REVOKED');
    await ok(owner.revoke({ grant_id: rootId, reason: 'end of task' }));
    const g2 = await lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'design-agent', scope: uiScope() });
    expect(code(g2)).toBe('GRANT_REVOKED');
  });
  it('records every decision with source MOCK', async () => {
    const g = await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'design-agent', scope: uiScope() }));
    await design.authorize({ grant_id: g.id, action: 'repo.read', resource: '.env' });
    const events = await auth.audit();
    expect(events.every((e) => e.source === 'MOCK')).toBe(true);
    expect(events.map((e) => e.decision)).toEqual(expect.arrayContaining(['ISSUED', 'DENY']));
    expect(events.find((e) => e.decision === 'DENY')).toMatchObject({ principal_id: 'design-agent', resource: '.env', reason_code: 'RESOURCE_DENIED' });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkforceFixture, insertWorkforceGrant, listenWorkforceApp, workforceChildId, workforceKeys, workforceOrgId, workforceOwnerId, workforceRequest, workforceRootId, workforceScope } from './fixtures/workforce.js';
import type { WorkforceExecutionContext } from '../src/workforce.js';

describe('workforce HTTP gateway', () => {
  let fixture: Awaited<ReturnType<typeof createWorkforceFixture>>;
  let listener: Awaited<ReturnType<typeof listenWorkforceApp>>;

  beforeEach(async () => {
    fixture = await createWorkforceFixture();
    listener = await listenWorkforceApp(fixture.app);
  });
  afterEach(async () => {
    await listener?.close();
    await fixture?.close();
  });

  const action = (grant_id: string, action: string, parameters: Record<string, unknown>, idempotency_key: string) => ({
    grant_id, action, resource: 'demo-project', parameters, idempotency_key,
  });

  it('denies secret, traversal, symlink, backend, and security paths before the adapter runs', async () => {
    const writeScope = workforceScope({ actions: ['repo.write'], paths: ['src/'] });
    insertWorkforceGrant(fixture.db, { id: 'grant-workforce-write', subject_principal_id: 'sourcing-agent', scope: writeScope });

    const results = await Promise.all([
      workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: '.env' }, 'secret-read'), workforceKeys['sourcing-agent']),
      workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: '../outside.txt' }, 'traversal'), workforceKeys['sourcing-agent']),
      workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: 'src/linked.ts' }, 'symlink'), workforceKeys['sourcing-agent']),
      workforceRequest(listener.baseUrl, '/v1/actions/execute', action('grant-workforce-write', 'repo.write', { path: 'backend/server.ts', content: 'changed' }, 'backend-write'), workforceKeys['sourcing-agent']),
      workforceRequest(listener.baseUrl, '/v1/actions/execute', action('grant-workforce-write', 'repo.write', { path: 'security/audit-policy.json', content: 'changed' }, 'security-write'), workforceKeys['sourcing-agent']),
    ]);

    expect(results.map(result => result.body.status)).toEqual(['DENY', 'DENY', 'DENY', 'AUTHORITY_REQUIRED', 'AUTHORITY_REQUIRED']);
    expect(results.map(result => result.body.code)).toEqual([
      'INSUFFICIENT_SCOPE', 'INSUFFICIENT_SCOPE', 'INSUFFICIENT_SCOPE', 'INSUFFICIENT_SCOPE', 'INSUFFICIENT_SCOPE',
    ]);
    expect(JSON.stringify(results)).not.toContain('must-not-return');
    expect(fixture.callbackCalls).toHaveLength(0);
  });

  it('executes an allowed repository write through a safe file handle', async () => {
    const grant = await workforceRequest(listener.baseUrl, `/v1/grants/${workforceRootId}/delegate`, {
      recipient_principal_id: 'worker-2',
      scope: workforceScope({ actions: ['repo.write'], paths: ['src/'], max_executions: 1 }),
    }, workforceKeys['buyer-agent']);
    const content = 'export const generated = true;\n';
    const result = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(grant.body.data.id, 'repo.write', {
      path: 'src/generated.ts', content,
    }, 'write-src'), workforceKeys['worker-2']);
    expect(result.body).toMatchObject({ status: 'ALLOW', result: { written: true } });
    expect(await readFile(join(fixture.repoRoot, 'src', 'generated.ts'), 'utf8')).toBe(content);
  });

  it('suggests preview for production and executes preview after a parent counteroffer is accepted', async () => {
    const directProduction = await workforceRequest(listener.baseUrl, `/v1/grants/${workforceRootId}/delegate`, {
      recipient_principal_id: 'worker-2',
      scope: workforceScope({ actions: ['deploy.production'], paths: [], max_executions: 1 }),
    }, workforceKeys['buyer-agent']);
    expect(directProduction.http).toBe(403);
    expect(directProduction.body.code).toBe('OUTSIDE_PARENT_SCOPE');

    const production = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'deploy.production', {
      environment: 'production', artifact_digest: 'a'.repeat(64),
    }, 'production'), workforceKeys['sourcing-agent']);
    expect(production.body).toMatchObject({ status: 'DENY', suggested_action: 'deploy.preview', next_action: 'request_authority' });

    const offeredScope = production.body.required_scope;
    const requested = await workforceRequest(listener.baseUrl, '/v1/authority/requests', {
      parent_grant_id: workforceRootId, requested_scope: offeredScope, reason: 'Preview this build',
    }, workforceKeys['sourcing-agent']);
    expect(requested.body.data.status).toBe('PENDING');

    const counteroffer = await workforceRequest(listener.baseUrl, `/v1/authority/requests/${requested.body.data.request_id}/respond`, {
      decision: 'COUNTEROFFER', offered_scope: offeredScope,
    }, workforceKeys['buyer-agent']);
    expect(counteroffer.body.data).toMatchObject({ status: 'COUNTEROFFERED', offered_scope: offeredScope });

    const accepted = await workforceRequest(listener.baseUrl, `/v1/authority/requests/${requested.body.data.request_id}/accept`, {
      idempotency_key: 'accept-preview',
    }, workforceKeys['sourcing-agent']);
    expect(accepted.body.data.scope).toEqual(offeredScope);

    const preview = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(accepted.body.data.id, 'deploy.preview', {
      environment: 'preview', artifact_digest: 'a'.repeat(64),
    }, 'preview'), workforceKeys['sourcing-agent']);
    expect(preview.body).toMatchObject({ status: 'ALLOW', code: 'EXECUTED', result: { simulated: true } });
    expect(fixture.callbackCalls).toHaveLength(1);
  });

  it('accepts a narrow cross-organization security grant while denying raw reads', async () => {
    const securityScope = workforceScope({ actions: ['security.audit.run'], paths: ['security/'], max_executions: 1 });
    const grant = await workforceRequest(listener.baseUrl, `/v1/grants/${workforceRootId}/delegate`, {
      recipient_principal_id: 'security-agent', scope: securityScope,
    }, workforceKeys['buyer-agent']);
    expect(grant.body.data.subject_principal_id).toBe('security-agent');
    expect(grant.body.data.organization_id).toBe(workforceOrgId);
    expect(grant.body.data.scope).toEqual(securityScope);

    const audit = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(grant.body.data.id, 'security.audit.run', {
      paths: ['security/audit-policy.json'],
    }, 'security-audit'), workforceKeys['security-agent']);
    expect(audit.body).toMatchObject({ status: 'ALLOW', result: { simulated: true } });
    const ownerAudit = await workforceRequest(listener.baseUrl, '/v1/audit', undefined, workforceKeys['owner-1']);
    expect(ownerAudit.body.data.some((event: { principal_id: string; action: string; decision: string }) =>
      event.principal_id === 'security-agent' && event.action === 'security.audit.run' && event.decision === 'ALLOW')).toBe(true);

    const raw = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(grant.body.data.id, 'analytics.raw.read', {}, 'raw-read'), workforceKeys['security-agent']);
    expect(raw.body.status).toBe('DENY');
    expect(JSON.stringify(raw.body)).not.toContain('raw fixture data');
    expect(fixture.callbackCalls).toHaveLength(1);
  });

  it('keeps cross-organization authority requests private and revocable', async () => {
    const securityScope = workforceScope({ actions: ['security.audit.run'], paths: ['security/'], max_executions: 2 });
    const delegated = await workforceRequest(listener.baseUrl, `/v1/grants/${workforceRootId}/delegate`, {
      recipient_principal_id: 'security-agent', scope: securityScope,
    }, workforceKeys['buyer-agent']);
    const requestedScope = workforceScope({ actions: ['repo.read'], paths: ['README.md'], max_executions: 1 });
    const request = await workforceRequest(listener.baseUrl, '/v1/authority/requests', {
      parent_grant_id: workforceRootId, requested_scope: requestedScope, reason: 'Read the public project summary',
    }, workforceKeys['security-agent']);
    expect(request.body.data.status).toBe('PENDING');

    const requestPath = `/v1/authority/requests/${request.body.data.request_id}`;
    expect((await workforceRequest(listener.baseUrl, requestPath, undefined, workforceKeys['buyer-agent'])).body.data.requester_principal_id).toBe('security-agent');
    const privateRead = await workforceRequest(listener.baseUrl, requestPath, undefined, workforceKeys['worker-2']);
    expect(privateRead.http).toBe(403);
    expect(privateRead.body.code).toBe('INVALID_CALLER');

    const counteroffer = await workforceRequest(listener.baseUrl, `${requestPath}/respond`, {
      decision: 'COUNTEROFFER', offered_scope: requestedScope,
    }, workforceKeys['buyer-agent']);
    expect(counteroffer.body.data.status).toBe('COUNTEROFFERED');
    const accepted = await workforceRequest(listener.baseUrl, `${requestPath}/accept`, { idempotency_key: 'accept-public-read' }, workforceKeys['security-agent']);
    const read = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(accepted.body.data.id, 'repo.read', { path: 'README.md' }, 'public-read'), workforceKeys['security-agent']);
    expect(read.body.status).toBe('ALLOW');

    await workforceRequest(listener.baseUrl, `/v1/grants/${accepted.body.data.id}/revoke`, { reason: 'End external access' }, workforceKeys['buyer-agent']);
    const afterRevocation = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(accepted.body.data.id, 'repo.read', { path: 'README.md' }, 'public-read-after-revoke'), workforceKeys['security-agent']);
    expect(afterRevocation.body).toMatchObject({ status: 'DENY', code: 'GRANT_REVOKED' });
    expect(delegated.body.data.subject_principal_id).toBe('security-agent');
    expect(fixture.callbackCalls).toHaveLength(1);
  });

  it('allows aggregate analytics and rejects extra caller identity fields', async () => {
    const aggregateScope = workforceScope({ actions: ['analytics.aggregate.read'], paths: [], max_executions: 2 });
    const grant = await workforceRequest(listener.baseUrl, `/v1/grants/${workforceRootId}/delegate`, {
      recipient_principal_id: 'worker-2', scope: aggregateScope,
    }, workforceKeys['buyer-agent']);
    const aggregate = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(grant.body.data.id, 'analytics.aggregate.read', { metric: 'builds' }, 'aggregate'), workforceKeys['worker-2']);
    expect(aggregate.body).toMatchObject({ status: 'ALLOW', result: { simulated: true } });

    const raw = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(grant.body.data.id, 'analytics.raw.read', {}, 'raw'), workforceKeys['worker-2']);
    expect(raw.body.status).toBe('DENY');
    const spoofed = await workforceRequest(listener.baseUrl, '/v1/actions/execute', {
      ...action(grant.body.data.id, 'analytics.aggregate.read', { metric: 'builds' }, 'spoof'),
      principal_id: 'owner-1', agent_id: 'owner-1',
    }, workforceKeys['worker-2']);
    expect(spoofed.http).toBe(400);
    expect(spoofed.body.code).toBe('INVALID_REQUEST');
    expect(fixture.callbackCalls).toHaveLength(1);
  });

  it('rejects child scope widening and stops executions after expiry or revocation', async () => {
    const widenedScopes = [
      workforceScope({ actions: ['repo.read', 'deploy.preview'], paths: ['src/'] }),
      workforceScope({ actions: ['repo.read'], paths: ['src/', 'backend/'] }),
      workforceScope({ actions: ['repo.read'], paths: ['src/'], expires_at: '2026-10-20T20:00:00.000Z' }),
      workforceScope({ actions: ['repo.read'], paths: ['src/'], max_executions: 21 }),
      workforceScope({ actions: ['repo.read'], paths: ['src/'], max_delegation_depth: 2 }),
    ];
    const wrongResource = workforceScope({ actions: ['repo.read'], paths: ['src/'] });
    wrongResource.resources[0].resource = 'another-project';
    widenedScopes.push(wrongResource);
    const wrongOrganization = workforceScope({ actions: ['repo.read'], paths: ['src/'] });
    wrongOrganization.resources[0].organization_id = 'security-co';
    widenedScopes.push(wrongOrganization);
    const wrongOwner = workforceScope({ actions: ['repo.read'], paths: ['src/'] });
    wrongOwner.resources[0].owner_principal_id = 'security-agent';
    widenedScopes.push(wrongOwner);

    for (const scope of widenedScopes) {
      const widened = await workforceRequest(listener.baseUrl, `/v1/grants/${workforceChildId}/delegate`, {
        recipient_principal_id: 'worker-2', scope,
      }, workforceKeys['sourcing-agent']);
      expect(widened.http).toBe(403);
      expect(widened.body.code).toBe('OUTSIDE_PARENT_SCOPE');
    }
    const invalidBudgetScopes = [
      { ...workforceScope({ actions: ['repo.read'], paths: ['src/'] }), supplier_ids: ['supplier-co'] },
      { ...workforceScope({ actions: ['repo.read'], paths: ['src/'] }), sku_ids: ['private-sku'] },
      { ...workforceScope({ actions: ['repo.read'], paths: ['src/'] }), max_per_action_cents: 1 },
      { ...workforceScope({ actions: ['repo.read'], paths: ['src/'] }), total_budget_cents: 1 },
    ];
    for (const scope of invalidBudgetScopes) {
      const result = await workforceRequest(listener.baseUrl, `/v1/grants/${workforceChildId}/delegate`, {
        recipient_principal_id: 'worker-2', scope,
      }, workforceKeys['sourcing-agent']);
      expect(result.http).toBe(400);
      expect(result.body.code).toBe('INVALID_REQUEST');
    }

    fixture.setNow(new Date('2026-10-20T00:00:00.000Z'));
    const expired = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: 'src/app.ts' }, 'expired'), workforceKeys['sourcing-agent']);
    expect(expired.body).toMatchObject({ status: 'DENY', code: 'GRANT_EXPIRED' });
  });

  it('stops execution after a parent revokes a child grant', async () => {
    const revoked = await workforceRequest(listener.baseUrl, `/v1/grants/${workforceChildId}/revoke`, { reason: 'Fixture revocation' }, workforceKeys['buyer-agent']);
    expect(revoked.body.status).toBe('OK');
    const result = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: 'src/app.ts' }, 'revoked'), workforceKeys['sourcing-agent']);
    expect(result.body).toMatchObject({ status: 'DENY', code: 'GRANT_REVOKED' });
    expect(fixture.callbackCalls).toHaveLength(0);
  });

  it('shares execution quota across sibling grants under concurrent requests', async () => {
    await listener.close();
    await fixture.close();
    fixture = await createWorkforceFixture({ maxExecutions: 1 });
    listener = await listenWorkforceApp(fixture.app);
    insertWorkforceGrant(fixture.db, {
      id: 'grant-worker-two', subject_principal_id: 'worker-2',
      scope: workforceScope({ actions: ['analytics.aggregate.read'], paths: [], max_executions: 1 }),
    });
    const results = await Promise.all([
      workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: 'src/app.ts' }, 'sibling-one'), workforceKeys['sourcing-agent']),
      workforceRequest(listener.baseUrl, '/v1/actions/execute', action('grant-worker-two', 'analytics.aggregate.read', { metric: 'builds' }, 'sibling-two'), workforceKeys['worker-2']),
    ]);
    expect(results.filter(result => result.body.status === 'ALLOW')).toHaveLength(1);
    expect(results.filter(result => result.body.code === 'BUDGET_EXCEEDED')).toHaveLength(1);
    expect(fixture.callbackCalls).toHaveLength(1);
  });

  it('runs a concurrent duplicate callback once and denies changed-payload replay', async () => {
    let callbackStarted!: () => void;
    let releaseCallback!: () => void;
    const started = new Promise<void>(resolve => { callbackStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseCallback = resolve; });
    await listener.close();
    await fixture.close();
    fixture = await createWorkforceFixture({ execute: async (_context: WorkforceExecutionContext) => {
      callbackStarted();
      await gate;
      return { simulated: true };
    } });
    listener = await listenWorkforceApp(fixture.app);

    const firstRequest = workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: 'src/app.ts' }, 'duplicate'), workforceKeys['sourcing-agent']);
    await started;
    const duplicate = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: 'src/app.ts' }, 'duplicate'), workforceKeys['sourcing-agent']);
    expect(duplicate.body).toMatchObject({ status: 'REQUEST_PENDING', code: 'EXECUTION_PENDING' });
    releaseCallback();
    expect((await firstRequest).body.status).toBe('ALLOW');

    const changed = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: 'src/other.ts' }, 'duplicate'), workforceKeys['sourcing-agent']);
    expect(changed.body).toMatchObject({ status: 'DENY', code: 'ALREADY_EXECUTED' });
    expect(fixture.callbackCalls).toHaveLength(1);
  });

  it('sanitizes database failures from action execution', async () => {
    fixture.db.exec('DROP TABLE workforce_usage');
    const result = await workforceRequest(listener.baseUrl, '/v1/actions/execute', action(workforceChildId, 'repo.read', { path: 'src/app.ts' }, 'database-error'), workforceKeys['sourcing-agent']);
    expect(result.http).toBe(503);
    expect(result.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(result.body)).not.toMatch(/workforce_usage|no such table|SELECT/i);
    expect(fixture.callbackCalls).toHaveLength(0);
  });
});

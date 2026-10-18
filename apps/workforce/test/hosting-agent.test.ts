/** Hosting agent: production refused -> reads the hint -> preview requested, granted, deployed for real. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkforceSession } from '../src/contract.js';
import { runHostingAgent } from '../src/agents/hosting.js';
import { createDeployGateway, type DeployGateway } from '../src/gateways/deploy.js';
import { MockWorkforceAuthority } from '../src/mock-authority.js';

const SOURCE = fileURLToPath(new URL('../../../demo-project/', import.meta.url));
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

let root: string, auth: MockWorkforceAuthority, lead: WorkforceSession, hosting: WorkforceSession, deploy: DeployGateway;
let rootId: string, hostingGrant: string;
const trace: { kind: string; text: string; code?: string }[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentpass-hosting-'));
  cpSync(SOURCE, root, { recursive: true, filter: (src) => !/node_modules|\.next/.test(src) });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--silent'], { cwd: root, stdio: 'ignore' });
  auth = new MockWorkforceAuthority();
  auth.addPrincipal({ id: 'lead-agent', organization_id: 'acme', credential: 'k-lead' });
  auth.addPrincipal({ id: 'hosting-agent', organization_id: 'acme', credential: 'k-hosting' });
  rootId = auth.issueRoot({ id: 'grant-root-lead', issuer: 'owner-1', subject: 'lead-agent', organization_id: 'acme', scope: {
    actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'], resources: ['src/**', 'package.json', 'preview', 'landing-page'], expires_at: later(60), max_delegation_depth: 2,
  } }).id;
  lead = (await auth.connect('k-lead') as any).data;
  hosting = (await auth.connect('k-hosting') as any).data;
  const g = await lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'hosting-agent', scope: { actions: ['repo.read'], resources: ['src/**', 'package.json'], expires_at: later(30), max_delegation_depth: 0 } });
  hostingGrant = (g as any).data.id;
  deploy = createDeployGateway(root);
}, 240_000);

afterAll(async () => { await deploy.stopAll(); rmSync(root, { recursive: true, force: true }); });

describe('hosting agent', () => {
  it('negotiates from a refused production deploy to a real preview', async () => {
    const result = await runHostingAgent(
      { name: 'hosting-agent', session: hosting, grant_id: hostingGrant, gateways: { deploy }, trace: (l) => trace.push(l) },
      {
        parent_grant_id: rootId,
        // The lead answers with exactly the requested preview scope (the orchestrator will do this for real).
        notifyParent: async (request_id) => {
          const r = (await lead.getRequest(request_id) as any).data;
          await lead.respond({ request_id, decision: 'COUNTEROFFER', offered_scope: r.requested_scope });
        },
      },
    );
    expect(result.production_attempt).toMatchObject({ status: 'AUTHORITY_REQUIRED', code: 'INSUFFICIENT_SCOPE', alternative: ['deploy.preview'] });
    expect(result.negotiation).toMatchObject({ status: 'COUNTEROFFERED', requested: { actions: ['deploy.preview'], resources: ['preview'] } });
    expect(result.ok, JSON.stringify(result.failure)).toBe(true);
    expect(result.deployment?.provider).toBe('local-next-start');
    expect(result.deployment?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(result.deployment!.url)).ok).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual(['deploy.production', 'request deploy.preview', 'lead decision', 'accept offer', 'deploy.preview']);
    // The trace shows the denial as a real event, and the request carried a justification.
    expect(trace.some((t) => t.kind === 'denied' && t.code === 'INSUFFICIENT_SCOPE')).toBe(true);
    const audit = await auth.audit();
    expect(audit.filter((e) => e.principal_id === 'hosting-agent').map((e) => e.decision)).toEqual(expect.arrayContaining(['AUTHORITY_REQUIRED', 'REQUESTED', 'ACCEPTED', 'ALLOW']));
  }, 180_000);

  it('stops cleanly when the lead rejects the preview request', async () => {
    const result = await runHostingAgent(
      { name: 'hosting-agent', session: hosting, grant_id: hostingGrant, gateways: { deploy }, trace: () => {} },
      { parent_grant_id: rootId, notifyParent: async (request_id) => { await lead.respond({ request_id, decision: 'REJECT' }); } },
    );
    expect(result.ok).toBe(false);
    expect(result.negotiation?.status).toBe('REJECTED');
    expect(result.deployment).toBeUndefined();
  }, 60_000);
});

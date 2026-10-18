/**
 * Real-mode gateways: the same RepoGateway / DeployGateway / AnalyticsGateway
 * interfaces the agents already use, but every protected call goes through
 * AgentPass's execute gateway, which validates the live chain and quota and
 * then invokes the registered `demo-project` resource adapter. The agents
 * never touch files, builds or data directly in this mode.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ApiResult, WorkforceSession } from '../contract.js';
import type { AnalyticsGateway, AnalyticsSummary } from '../gateways/analytics.js';
import type { DeployGateway, Deployment } from '../gateways/deploy.js';
import type { RepoGateway } from '../gateways/repo.js';
import type { RealSession } from './authority.js';
import { digestOf } from './resource-adapter.js';

const IGNORED = new Set(['node_modules', '.next', '.git']);
const SECRET_FILE = /(^|\/)\.env(\.|$)/;

function real(session: WorkforceSession): RealSession | undefined {
  return 'execute' in session ? (session as RealSession) : undefined;
}
const notReal = (): ApiResult<never> => ({ status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'This gateway needs an AgentPass session' });

export function createRealGateways(opts: { repoRoot: string; analyticsFile: string }): { repo: RepoGateway; deploy: DeployGateway; analytics: AnalyticsGateway } {
  const root = opts.repoRoot;
  let seq = 0;
  const key = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

  const repo: RepoGateway = {
    root,
    /** Directory listing is not a protected action in AgentPass; each candidate file is checked through verify so the list only shows what the grant can read. */
    async list(session, grant_id, dir) {
      const s = real(session); if (!s) return notReal();
      const start = join(root, dir || '.');
      const out: string[] = [];
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          if (IGNORED.has(name)) continue;
          const full = join(d, name);
          if (statSync(full).isDirectory()) walk(full);
          else { const rel = relative(root, full).split(sep).join('/'); if (!SECRET_FILE.test(rel)) out.push(rel); }
        }
      };
      try { walk(start); } catch { return { status: 'OK', data: [] }; }
      const allowed: string[] = [];
      for (const rel of out.sort()) {
        const v = await s.authorize({ grant_id, action: 'repo.read', resource: rel });
        if (v.status === 'OK') allowed.push(rel);
      }
      return { status: 'OK', data: allowed };
    },
    async read(session, grant_id, path) {
      const s = real(session); if (!s) return notReal();
      const r = await s.execute({ grant_id, action: 'repo.read', resource: path, parameters: {}, idempotency_key: key('read') });
      if (r.status !== 'OK') return r;
      return { status: 'OK', data: { path, content: String(r.data.result.content ?? '') } };
    },
    async write(session, grant_id, path, content) {
      const s = real(session); if (!s) return notReal();
      const r = await s.execute({ grant_id, action: 'repo.write', resource: path, parameters: { content }, idempotency_key: key('write') });
      if (r.status !== 'OK') return r;
      return { status: 'OK', data: { path, bytes: Number(r.data.result.bytes ?? Buffer.byteLength(content)) } };
    },
  };

  const deploy: DeployGateway = {
    async deploy(session, grant_id, environment) {
      const s = real(session); if (!s) return notReal();
      // The digest names exactly the tree being deployed; the adapter refuses if the tree changed since.
      const artifact_digest = digestOf(root);
      const r = await s.execute({ grant_id, action: environment === 'production' ? 'deploy.production' : 'deploy.preview', resource: environment, parameters: { artifact_digest }, idempotency_key: key(`deploy-${environment}`) });
      if (r.status !== 'OK') return r;
      const out = r.data.result as { deployed?: boolean; reason?: string } & Partial<Deployment>;
      if (!out.deployed || !out.url) return { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: out.reason ?? 'Deployment did not complete' };
      return { status: 'OK', data: { environment: 'preview', url: out.url, provider: 'local-next-start', pid: out.pid ?? -1, build_log_tail: out.build_log_tail ?? [] } };
    },
    async stopAll() { /* servers are owned by the resource adapter */ },
  };

  const analytics: AnalyticsGateway = {
    async aggregate(session, grant_id, dataset) {
      const s = real(session); if (!s) return notReal();
      const r = await s.execute({ grant_id, action: 'analytics.aggregate', resource: dataset, parameters: {}, idempotency_key: key('agg') });
      if (r.status !== 'OK') return r;
      const summary = r.data.result.summary as AnalyticsSummary | undefined;
      if (!summary) return { status: 'ERROR', code: 'INVALID_REQUEST', reason: String(r.data.result.error ?? 'No summary returned') };
      return { status: 'OK', data: summary };
    },
    async raw(session, grant_id, dataset) {
      const s = real(session); if (!s) return notReal();
      const r = await s.execute({ grant_id, action: 'analytics.raw', resource: dataset, parameters: {}, idempotency_key: key('raw') });
      if (r.status !== 'OK') return r;
      return { status: 'OK', data: (r.data.result.events as never[]) ?? [] };
    },
  };

  return { repo, deploy, analytics };
}

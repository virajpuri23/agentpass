/**
 * The external Security agent as its OWN process.
 *
 * This service holds exactly one secret: the security agent's AgentPass
 * credential (`SECURITY_CREDENTIAL`). The lead never sees it, and this
 * process never sees the lead's. The lead talks to it over HTTP with a
 * per-task token (`X-Task-Token`), delegates a read-only grant to the
 * principal it reports, and asks it to audit under that grant. Every
 * protected call the agent then makes goes from this process straight to
 * AgentPass with its own bearer, so the authority's audit trail shows the
 * external principal, not the lead.
 *
 *   POST /identify {authority_url}                    -> {principal_id, organization_id}
 *   POST /audit    {grant_id, authority_url}          -> {report: SecurityReport, trace: [...]}
 *   POST /probe    {grant_id, authority_url, action, resource} -> {status, code?}  (reuse-after-revoke proof)
 *
 * `authority_url` must be HTTPS or loopback HTTP; when `SECURITY_AUTHORITY_URL`
 * is configured the request must name exactly that authority, so a caller with
 * the task token still cannot redirect the credential elsewhere.
 */
import express from 'express';
import { z } from 'zod';
import { runSecurityAgent, type SecurityReport } from './agents/security.js';
import type { Trace } from './agent-base.js';
import { WORKFORCE_ACTIONS, type ApiResult, type WorkforceAction } from './contract.js';
import { sameSecret } from './gateway-service.js';
import { RealWorkforceAuthority, type ResourceIdentity } from './real/authority.js';
import { createRealGateways } from './real/gateways.js';

const id = z.string().min(1).max(200);
const url = z.url().max(2000);
const identifyBody = z.object({ authority_url: url }).strict();
const auditBody = z.object({ grant_id: id, authority_url: url }).strict();
const probeBody = z.object({ grant_id: id, authority_url: url, action: z.enum(WORKFORCE_ACTIONS as [WorkforceAction, ...WorkforceAction[]]), resource: z.string().min(1).max(1000) }).strict();

export type TraceLine = Parameters<Trace>[0];
export interface AuditResponse { report: SecurityReport; trace: TraceLine[] }

export interface SecurityServiceOptions {
  /** The security agent's own AgentPass credential: the only secret this process holds. */
  credential: string;
  /** Per-task shared secret the lead presents as X-Task-Token. */
  taskToken: string;
  repoRoot: string;
  analyticsFile: string;
  /** When set, requests must name exactly this authority. */
  authorityUrl?: string;
  identity?: ResourceIdentity;
  requestLog?: boolean;
}

function trustedAuthority(value: string, pinned?: string): URL | undefined {
  let u: URL;
  try { u = new URL(value); } catch { return undefined; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!['https:', 'http:'].includes(u.protocol) || (u.protocol === 'http:' && !loopback) || u.username || u.password || u.search || u.hash) return undefined;
  if (pinned && new URL(pinned).origin !== u.origin) return undefined;
  return u;
}

export function createSecurityService(opts: SecurityServiceOptions) {
  if (!opts.credential) throw new Error('SECURITY_CREDENTIAL is required');
  if (!opts.taskToken) throw new Error('SECURITY_TASK_TOKEN is required');
  const identity = opts.identity ?? { organization_id: 'buyer-co', owner_principal_id: 'owner-1' };
  const gateways = createRealGateways({ repoRoot: opts.repoRoot, analyticsFile: opts.analyticsFile });
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const started = Date.now();
    const path = req.path;
    res.on('finish', () => {
      if (path === '/health' || opts.requestLog === false) return;
      console.log(JSON.stringify({ service: 'security-agent', method: req.method, path, status: res.statusCode, ms: Date.now() - started }));
    });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', (_req, res) => { res.json({ status: 'OK', process: 'security-agent', organization: 'sentinel-sec' }); });

  app.use((req, res, next) => {
    if (sameSecret(req.header('x-task-token'), opts.taskToken)) return next();
    res.status(401).json({ status: 'DENIED', code: 'INVALID_CALLER', reason: 'Valid X-Task-Token required' });
  });

  /** A fresh session per request: the credential is used only to talk to the named, trusted authority. */
  async function connect(authority_url: string): Promise<{ auth: RealWorkforceAuthority; session: Awaited<ReturnType<RealWorkforceAuthority['connect']>> } | undefined> {
    const u = trustedAuthority(authority_url, opts.authorityUrl);
    if (!u) return undefined;
    const auth = new RealWorkforceAuthority({ authorityUrl: u.origin, identity });
    return { auth, session: await auth.connect(opts.credential) };
  }
  const fail = (res: express.Response, status: number, body: unknown) => void res.status(status).json(body);
  const untrusted = (res: express.Response) => fail(res, 400, { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'authority_url is not a trusted authority' });

  app.post('/identify', async (req, res, next) => {
    try {
      const body = identifyBody.safeParse(req.body);
      if (!body.success) return fail(res, 400, { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Invalid request body' });
      const c = await connect(body.data.authority_url);
      if (!c) return untrusted(res);
      if (c.session.status !== 'OK') return fail(res, 502, { status: c.session.status, code: c.session.code, reason: 'The authority did not accept this agent\'s credential' });
      const me = await c.session.data.me();
      if (me.status !== 'OK') return fail(res, 502, { status: me.status, code: me.code, reason: me.reason });
      res.json({ status: 'OK', data: { principal_id: me.data.principal_id, organization_id: me.data.organization_id } });
    } catch (error) { next(error); }
  });

  app.post('/audit', async (req, res, next) => {
    try {
      const body = auditBody.safeParse(req.body);
      if (!body.success) return fail(res, 400, { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Invalid request body' });
      const c = await connect(body.data.authority_url);
      if (!c) return untrusted(res);
      if (c.session.status !== 'OK') return fail(res, 502, { status: c.session.status, code: c.session.code, reason: 'The authority did not accept this agent\'s credential' });
      const trace: TraceLine[] = [];
      const report = await runSecurityAgent({ name: c.session.data.principal_id, session: c.session.data, grant_id: body.data.grant_id, gateways, trace: (l) => trace.push(l) });
      const data: AuditResponse = { report, trace };
      res.json({ status: 'OK', data });
    } catch (error) {
      // The agent throws when a happy-path read is refused (e.g. a revoked or too-narrow grant). Report the refusal, never the stack.
      const message = error instanceof Error ? error.message : 'audit failed';
      const code = /failed: ([A-Z_]+)/.exec(message)?.[1];
      if (code) return fail(res, 403, { status: 'DENIED', code, reason: 'The audit could not be completed under the given grant' });
      next(error);
    }
  });

  app.post('/probe', async (req, res, next) => {
    try {
      const body = probeBody.safeParse(req.body);
      if (!body.success) return fail(res, 400, { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Invalid request body' });
      const c = await connect(body.data.authority_url);
      if (!c) return untrusted(res);
      // A disabled credential is itself the answer: the grant can no longer be used by this agent.
      if (c.session.status !== 'OK') return void res.json({ status: 'OK', data: { status: c.session.status, code: c.session.code } });
      const r: ApiResult<unknown> = await c.session.data.authorize({ grant_id: body.data.grant_id, action: body.data.action, resource: body.data.resource });
      res.json({ status: 'OK', data: r.status === 'OK' ? { status: 'OK' } : { status: r.status, code: r.code } });
    } catch (error) { next(error); }
  });

  app.use((_req: express.Request, res: express.Response) => { res.status(404).json({ status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Not found' }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError || (error as { type?: string })?.type === 'entity.parse.failed') return void res.status(400).json({ status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Invalid request body' });
    console.error(JSON.stringify({ service: 'security-agent', error: 'unhandled', name: (error as Error)?.name }));
    res.status(503).json({ status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'Security agent temporarily unavailable', next_action: 'retry' });
  });

  return { app };
}

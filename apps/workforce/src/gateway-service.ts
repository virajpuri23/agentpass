/**
 * Developer B's protected workforce gateway as an HTTP service
 * (docs/11-WORKFORCE-CONTRACT.md, "Protected execution adapter").
 *
 * AgentPass (Developer A's authority) validates the live grant chain, the
 * paths and the quota, reserves an execution and then POSTs
 * `/internal/workforce/execute` with `{execution_id, principal, input}`
 * signed by the shared `X-Service-Key`. This service authenticates that key,
 * re-validates the body against the contract schemas, re-resolves every path
 * against its own trusted repository root (fail closed), performs exactly the
 * validated action through the `demo-project` resource adapter and returns
 * `{status:'OK', data}`. Nothing in the body may choose a command, a URL or
 * a credential: the action set is the contract's closed enum.
 *
 * Deduplication: `execution_id` is the durable idempotency key. This service
 * keeps the completed results in memory for the lifetime of the process, which
 * is what A's authority also does for its own ledger in the demo; replaying an
 * id returns the first result without re-executing, and a concurrent duplicate
 * awaits the in-flight execution. A multi-instance deployment would move this
 * map into shared storage.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { workforceActionSchema, type WorkforceActionInput } from '../../../packages/contracts/src/workforce.js';
import { resolveWorkforcePath } from '../../authority/src/workforce-paths.js';
import type { WorkforceExecutionContext } from '../../authority/src/workforce.js';
import { createDemoProjectResource, type DemoResourceOptions } from './real/resource-adapter.js';

const id = z.string().min(1).max(200);
/** `principal` is whatever AgentPass authenticated on its transport; only its shape is checked here, never trusted for authority. */
const principalSchema = z.object({ id, organization_id: id, kind: z.enum(['HUMAN', 'AGENT', 'SERVICE']), role: z.enum(['OWNER', 'BUYER', 'SOURCING', 'SUPPLIER', 'SERVICE']) }).strict();
const executeBody = z.object({ execution_id: id, principal: principalSchema, input: workforceActionSchema }).strict();

/** Same derivation as AgentPass's `requestedPaths`: file actions name their paths, the rest touch no file. */
export function requestedPaths(input: WorkforceActionInput): string[] {
  if (input.action === 'repo.read' || input.action === 'repo.write') return [input.parameters.path];
  if (input.action === 'security.audit.run') return input.parameters.paths;
  return [];
}

export function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface GatewayServiceOptions extends DemoResourceOptions {
  serviceKey: string;
  /** One JSON line per request (no bodies, paths or keys). Off for embedded tests. */
  requestLog?: boolean;
}

export function createGatewayService(opts: GatewayServiceOptions) {
  if (!opts.serviceKey) throw new Error('WORKFORCE_SERVICE_KEY is required');
  const adapter = createDemoProjectResource(opts);
  const done = new Map<string, Promise<Record<string, unknown>>>(); // execution_id -> result (settled or in flight)
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const started = Date.now();
    const path = req.path;
    const presented = req.header('x-service-key');
    const serviceKeyStatus = !path.startsWith('/internal') ? undefined : sameSecret(presented, opts.serviceKey) ? 'valid' : presented ? 'invalid' : 'missing';
    res.on('finish', () => {
      if (path === '/health' || opts.requestLog === false) return;
      console.log(JSON.stringify({ service: 'workforce-gateway', method: req.method, path, status: res.statusCode, ms: Date.now() - started, service_key: serviceKeyStatus, action: res.locals.action, replay: res.locals.replay }));
    });
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => { res.json({ status: 'OK', resource: adapter.resource, executions: adapter.executions() }); });

  app.use('/internal', (req, res, next) => {
    if (sameSecret(req.header('x-service-key'), opts.serviceKey)) return next();
    res.status(401).json({ status: 'DENIED', code: 'INVALID_CALLER', reason: 'Valid X-Service-Key required' });
  });

  app.post('/internal/workforce/execute', async (req, res, next) => {
    try {
      const parsed = executeBody.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Invalid execution envelope' });
      const { execution_id, principal, input } = parsed.data;
      res.locals.action = input.action;
      if (!adapter.allowed_actions.includes(input.action) || input.resource !== adapter.resource) {
        return void res.status(400).json({ status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Action is not registered for this resource' });
      }
      const prior = done.get(execution_id);
      if (prior) { res.locals.replay = true; return void res.json({ status: 'OK', data: await prior }); }
      // Own path validation, independent of the authority's: every component resolved under the trusted root, no symlinks, no dotfiles.
      const paths = requestedPaths(input);
      try { for (const p of paths) await resolveWorkforcePath(opts.repoRoot, p, input.action === 'repo.write'); }
      catch { return void res.status(400).json({ status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Repository path is not permitted' }); }
      const context: WorkforceExecutionContext = { input, principal, execution_id, paths };
      const pending = adapter.execute(context);
      done.set(execution_id, pending);
      let data: Record<string, unknown>;
      try { data = await pending; } catch (error) { done.delete(execution_id); throw error; }
      res.json({ status: 'OK', data });
    } catch (error) { next(error); }
  });

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Not found' });
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError || (error as { type?: string })?.type === 'entity.parse.failed' || (error as { type?: string })?.type === 'entity.too.large') {
      return void res.status(400).json({ status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Invalid request body' });
    }
    // Never echo internal errors: they could carry file system names or contents.
    console.error(JSON.stringify({ service: 'workforce-gateway', error: 'unhandled', name: (error as Error)?.name }));
    res.status(503).json({ status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'Gateway temporarily unavailable', next_action: 'retry' });
  });

  return { app, adapter, executions: () => done.size, stop: () => adapter.stop() };
}

export type GatewayService = ReturnType<typeof createGatewayService>;

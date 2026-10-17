/**
 * Supplier HTTP API (frozen contract, docs/02-API-CONTRACTS.md + docs/13-AUTHORITY-HANDOFF.md).
 * Every /internal route requires the AgentPass backend's X-Service-Key; agents never call this directly.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { SupplierError, type SupplierService } from './service.js';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

const quoteBody = z.object({
  buyer_principal_id: id,
  supplier_id: id,
  sku_id: id,
  quantity: z.number().int().positive().max(1_000_000),
  request_id: id,
}).strict();

const fulfillBody = z.object({ quote_id: id, buyer_principal_id: id, request_id: id }).strict();

const policyBody = z.object({
  principal_id: id,
  action: z.string().min(1).max(200),
  resource: z.object({ supplier_id: id, sku_id: id }).strict(),
}).strict();

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createSupplierApp({ service, serviceKey, healthCheck }: {
  service: SupplierService;
  serviceKey: string;
  healthCheck?: () => Promise<unknown>;
}) {
  if (!serviceKey) throw new Error('SUPPLIER_SERVICE_KEY is required');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', async (_req, res) => {
    try {
      await healthCheck?.();
      res.json({ status: 'OK' });
    } catch {
      res.status(503).json({ status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'Supplier storage unavailable' });
    }
  });

  app.use('/internal', (req, res, next) => {
    if (sameSecret(req.header('x-service-key'), serviceKey)) return next();
    res.status(401).json({ status: 'DENIED', code: 'INVALID_CALLER', reason: 'Valid X-Service-Key required' });
  });

  const route = (fn: (req: express.Request) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json({ status: 'OK', data: await fn(req) }); } catch (error) { next(error); }
    };

  app.post('/internal/quote', route((req) => service.quote(quoteBody.parse(req.body))));
  app.get('/internal/quotes/:id', route((req) => service.getQuote(id.parse(req.params.id))));
  app.post('/internal/fulfill', route((req) => service.fulfill(fulfillBody.parse(req.body))));
  app.post('/internal/policy/evaluate', route((req) => service.evaluate(policyBody.parse(req.body))));

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Not found' });
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof SupplierError) return void res.status(error.httpStatus).json(error.body);
    if (error instanceof z.ZodError || (error as { type?: string })?.type === 'entity.parse.failed') {
      return void res.status(400).json({ status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Invalid request body' });
    }
    // Never echo internal errors: they could carry private row data.
    console.error(JSON.stringify({ service: 'supplier', error: 'unhandled', name: (error as Error)?.name }));
    res.status(503).json({ status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'Supplier temporarily unavailable', next_action: 'retry' });
  });

  return app;
}

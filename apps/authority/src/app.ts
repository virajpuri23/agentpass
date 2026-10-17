import express from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Principal } from '../../../packages/contracts/src/index.js';
import type { SupplierService } from './supplier.js';
import { AuthorityEngine, Denial, deny } from './engine.js';
import { id, scopeSchema, executeSchema } from './validation.js';

export function createAuthorityApp(options: { db: Database.Database; supplier: SupplierService; now?: () => Date }) {
  const app = express();
  const engine = new AuthorityEngine(options.db,options.supplier,options.now);
  app.disable('x-powered-by');
  app.use(express.json({limit:'32kb'}));
  app.get('/health',(_req,res) => { options.db.prepare('SELECT 1').get(); res.json({status:'OK'}); });
  app.use('/v1',(req,res,next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ') || !header.slice(7)) deny('INVALID_CALLER','Valid bearer credentials required',401);
      res.locals.principal = engine.authenticate(header.slice(7));
      next();
    } catch (error) { next(error); }
  });
  const route = (fn: (p: Principal, req: express.Request) => unknown) => async (req: express.Request,res: express.Response,next: express.NextFunction) => {
    try { res.json({status:'OK',data:await fn(res.locals.principal,req)}); }
    catch (error) { next(error); }
  };
  app.get('/v1/me',route(p => ({principal_id:p.id,organization_id:p.organization_id,role:p.role,grants:engine.grants(p)})));
  app.post('/v1/grants/:id/delegate',route((p,req) => {
    const body = z.object({recipient_principal_id:id,scope:scopeSchema}).strict().parse(req.body);
    return engine.delegate(p,String(req.params.id),body.recipient_principal_id,body.scope);
  }));
  app.post('/v1/grants/:id/revoke',route((p,req) => {
    z.object({reason:z.string().min(1).max(2000)}).strict().parse(req.body);
    return engine.revoke(p,String(req.params.id));
  }));
  app.post('/v1/authority/requests',route((p,req) => {
    const b = z.object({parent_grant_id:id,requested_scope:scopeSchema,reason:z.string().min(1).max(2000)}).strict().parse(req.body);
    return engine.request(p,b.parent_grant_id,b.requested_scope,b.reason);
  }));
  app.get('/v1/authority/requests/:id',route((p,req) => engine.getRequest(p,String(req.params.id))));
  app.post('/v1/authority/requests/:id/respond',route((p,req) => {
    const b = z.object({decision:z.enum(['COUNTEROFFER','REJECT']),offered_scope:scopeSchema.optional()}).strict().parse(req.body);
    return engine.respond(p,String(req.params.id),b.decision,b.offered_scope);
  }));
  app.post('/v1/authority/requests/:id/accept',route((p,req) => {
    z.object({idempotency_key:id}).strict().parse(req.body);
    return engine.accept(p,String(req.params.id));
  }));
  app.post('/v1/actions/execute',route((p,req) => engine.execute(p,executeSchema.parse(req.body))));
  app.get('/v1/audit',route(p => {
    if (p.role !== 'OWNER') deny('INVALID_CALLER','Audit requires organization owner');
    return options.db.prepare('SELECT e.event_id,e.timestamp,e.principal_id,e.grant_id,e.action,e.decision,e.reason_code,e.request_id,e.trace_id FROM audit_events e JOIN principals p ON p.id = e.principal_id WHERE p.organization_id = ? ORDER BY e.timestamp,e.rowid').all(p.organization_id);
  }));
  app.use((_req,_res,next) => { next(new Denial({status:'DENIED',code:'INVALID_REQUEST',reason:'Unknown endpoint'},404)); });
  app.use((error: unknown,req: express.Request,res: express.Response,_next: express.NextFunction) => {
    let result; let status;
    if (error instanceof Denial) { result=error.result; status=error.http; }
    else if (error instanceof z.ZodError || (error instanceof SyntaxError && 'body' in error)) {
      result={status:'DENIED',code:'INVALID_REQUEST',reason:'Request does not match the API contract'}; status=400;
    } else { result={status:'ERROR',code:'SERVICE_UNAVAILABLE',reason:'Operation unavailable; retry the same idempotency key',next_action:'retry'}; status=503; }
    if (res.locals.principal) {
      try { engine.audit(res.locals.principal,req.route?.path ?? 'http.request','DENY',undefined,result.code as any); }
      catch { result={status:'ERROR',code:'SERVICE_UNAVAILABLE',reason:'Persistence unavailable',next_action:'retry'}; status=503; }
    }
    res.status(status).json(result);
  });
  return app;
}

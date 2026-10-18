import express from 'express';
import { consoleSnapshot } from './console.js';
import { randomUUID } from 'node:crypto';
import { auditContext, setAuditContext } from './audit.js';
import { SupplierPolicyDenial } from './supplier.js';
import type Database from 'better-sqlite3';
import { sqliteStore, type AuthorityStore } from '../../../db/store.js';
import { z } from 'zod';
import type { Principal } from '../../../packages/contracts/src/index.js';
import type { SupplierService } from './supplier.js';
import { AuthorityEngine, Denial, deny } from './engine.js';
import { id, scopeSchema, executeSchema } from './validation.js';
import { AccountService,AccountBootstrapError,type VerifiedConnectionIdentity } from './accounts.js';
import { createConsentRouter,type ConsentBrowserConfig } from './consent-browser.js';
import { onboardingSchemas } from '../../../packages/contracts/src/onboarding.js';
import { ConsentService } from './consent.js';
import { mountAgentControl,type AgentControlOptions,agentControlFromEnvironment,assertManagedPrincipalLive } from './agent-control.js';
import { createSupabaseLoginRouter,type SupabaseLoginConfig } from './supabase-login.js';

export function createAuthorityApp(options: { db: Database.Database | AuthorityStore; supplier: SupplierService; now?: () => Date;verifyHumanToken?:(token:string)=>Promise<VerifiedConnectionIdentity>;consentBrowser?:ConsentBrowserConfig;supabaseLogin?:SupabaseLoginConfig;agentControl?:AgentControlOptions|{environment:NodeJS.ProcessEnv} }) {
  const app = express();
  const db = 'pragma' in options.db ? sqliteStore(options.db) : options.db;
  const accounts=new AccountService(db,options.now);
  const engine = new AuthorityEngine(db,options.supplier,options.now,(options.verifyHumanToken||options.agentControl||options.consentBrowser)?async(principal,requireAuthority)=>{
    const connection=await accounts.connectionForPrincipal(principal.id);
    if(connection&&(connection.account_state!=='ACTIVE'||connection.membership_state!=='ACTIVE'||!connection.principal_active||connection.state==='REVOKED'||connection.revoked_at))deny('INVALID_CALLER','Connection or membership is inactive',401);
    if(connection&&requireAuthority&&connection.state!=='ACTIVE')deny('INSUFFICIENT_SCOPE','Connection requires trusted owner consent');
    if(options.agentControl)await assertManagedPrincipalLive(db,principal,(options.now??(()=>new Date()))());
  }:undefined);
  app.disable('x-powered-by');
  app.use((_req,_res,next) => {
    auditContext.run({traceId:randomUUID(),requestId:randomUUID(),action:'http.request'},next);
  });
  app.use(express.json({limit:'32kb'}));
  app.get('/health',async (_req,res) => { await db.prepare('SELECT 1').get(); res.json({status:'OK'}); });
  if(options.supabaseLogin)app.use('/onboarding/identity',createSupabaseLoginRouter(db,options.supabaseLogin,options.now));
  if(options.consentBrowser)app.use('/onboarding',createConsentRouter(engine,options.consentBrowser,options.now));
  else app.use('/onboarding',(_req,res)=>res.status(503).json({status:'ERROR',code:'SERVICE_UNAVAILABLE',reason:'Trusted browser consent is not configured',next_action:'contact_owner'}));
  app.use('/v1',async (req,res,next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ') || !header.slice(7)) deny('INVALID_CALLER','Valid bearer credentials required',401);
      const token=header.slice(7);
      if(options.verifyHumanToken&&token.includes('.')){
        let identity:VerifiedConnectionIdentity;
        try{identity=await options.verifyHumanToken(token);}catch{deny('INVALID_CALLER','OAuth token is invalid or expired',401);}
        const context=await accounts.bootstrap(identity!);res.locals.account_context=context;
        res.locals.principal=await engine.principal(context.connection.principal_id);
      }else res.locals.principal = await engine.authenticate(token);
      next();
    } catch (error) { next(error); }
  });
  const route = (fn: (p: Principal, req: express.Request) => unknown) => async (req: express.Request,res: express.Response,next: express.NextFunction) => {
    try { res.json({status:'OK',data:await fn(res.locals.principal,req)}); }
    catch (error) { next(error); }
  };
  app.get('/v1/me',route(async p => ({principal_id:p.id,organization_id:p.organization_id,role:p.role,grants:await engine.grants(p),inspector:await engine.inspect(p)})));
  app.get('/v1/onboarding/context',route((_p,req)=>{
    const context=(req.res as express.Response).locals.account_context;if(!context)deny('INVALID_CALLER','Human OAuth connection required',403);
    return onboardingSchemas.context_data.parse({account_id:context.account_id,organization:context.organization,connection:context.connection,simulated:true});
  }));
  app.post('/v1/onboarding/connection/revoke',route(async(_p,req)=>{
    onboardingSchemas.revoke_connection_request.parse(req.body);
    const context=(req.res as express.Response).locals.account_context;if(!context)deny('INVALID_CALLER','Human OAuth connection required',403);
    const policy=options.consentBrowser?.policy??(()=>{throw new Error('Consent policy unavailable');});
    return new ConsentService(engine,policy,options.now).revoke(context.account_id,context.connection.id);
  }));
  app.get('/v1/console',route(p => consoleSnapshot(engine,p)));
  app.post('/v1/grants/:id/delegate',route((p,req) => {
    const body = z.object({recipient_principal_id:id,scope:scopeSchema}).strict().parse(req.body);
    setAuditContext({action:'grant.delegate',grantId:id.parse(req.params.id)});
    return engine.delegate(p,String(req.params.id),body.recipient_principal_id,body.scope);
  }));
  app.post('/v1/grants/:id/provision-child',route((p,req) => {
    if((req.res as express.Response).locals.account_context){setAuditContext({action:'principal.provision'});throw new Denial({status:'DENIED',code:'INVALID_REQUEST',reason:'Human OAuth connections must use provision_agent for managed provisioning',next_action:'contact_owner'},403);}
    const body = z.object({scope:scopeSchema,credential_hash:z.string().regex(/^[a-f0-9]{64}$/),idempotency_key:id}).strict().parse(req.body);
    setAuditContext({action:'principal.provision',grantId:id.parse(req.params.id)});
    return engine.provisionChild(p,String(req.params.id),body.scope,body.credential_hash,body.idempotency_key);
  }));
  app.post('/v1/grants/:id/revoke',route((p,req) => {
    z.object({reason:z.string().min(1).max(2000)}).strict().parse(req.body);
    setAuditContext({action:'grant.revoke',grantId:id.parse(req.params.id)});
    return engine.revoke(p,String(req.params.id));
  }));
  app.post('/v1/authority/requests',route((p,req) => {
    const b = z.object({parent_grant_id:id,requested_scope:scopeSchema,reason:z.string().min(1).max(2000)}).strict().parse(req.body);
    setAuditContext({action:'authority.request',grantId:b.parent_grant_id});
    return engine.request(p,b.parent_grant_id,b.requested_scope,b.reason);
  }));
  app.get('/v1/authority/requests/:id',route((p,req) => {setAuditContext({action:'authority.read',requestId:id.parse(req.params.id)});return engine.getRequest(p,String(req.params.id));}));
  app.post('/v1/authority/requests/:id/respond',route((p,req) => {
    const b = z.object({decision:z.enum(['COUNTEROFFER','REJECT']),offered_scope:scopeSchema.optional()}).strict().parse(req.body);
    setAuditContext({action:'authority.respond',requestId:id.parse(req.params.id)});
    return engine.respond(p,String(req.params.id),b.decision,b.offered_scope);
  }));
  app.post('/v1/authority/requests/:id/accept',route((p,req) => {
    z.object({idempotency_key:id}).strict().parse(req.body);
    setAuditContext({action:'authority.accept',requestId:id.parse(req.params.id)});
    return engine.accept(p,String(req.params.id));
  }));
  app.post('/v1/actions/execute',route((p,req) => {
    const input=executeSchema.parse(req.body);
    setAuditContext({action:input.action,grantId:input.grant_id});
    return engine.execute(p,input);
  }));
  app.get('/v1/audit',route(async p => {
    if (p.role !== 'OWNER') deny('INVALID_CALLER','Audit requires organization owner');
    return db.prepare('SELECT e.event_id,e.timestamp,e.principal_id,e.grant_id,e.action,e.decision,e.reason_code,e.request_id,e.trace_id FROM audit_events e JOIN principals p ON p.id = e.principal_id WHERE p.organization_id = ? ORDER BY e.timestamp,e.rowid').all(p.organization_id);
  }));
  if(options.agentControl)app.locals.agentControl=mountAgentControl(app,engine,'environment' in options.agentControl?agentControlFromEnvironment(engine,options.agentControl.environment):options.agentControl);
  app.use((_req,_res,next) => { next(new Denial({status:'DENIED',code:'INVALID_REQUEST',reason:'Unknown endpoint'},404)); });
  app.use(async (error: unknown,req: express.Request,res: express.Response,_next: express.NextFunction) => {
    let result; let status;
    if (error instanceof SupplierPolicyDenial) { result={status:'DENIED',code:'SELLER_POLICY_DENIED',reason:'Supplier policy denied operation',next_action:'contact_owner'}; status=403; }
    else if (error instanceof Denial) { result=error.result; status=error.http; }
    else if (error instanceof AccountBootstrapError) { result={status:'DENIED',code:'INVALID_CALLER',reason:'Account or connection unavailable',next_action:'contact_owner'};status=401; }
    else if (error instanceof z.ZodError || (error instanceof SyntaxError && 'body' in error)) {
      result={status:'DENIED',code:'INVALID_REQUEST',reason:'Request does not match the API contract'}; status=400;
    } else { result={status:'ERROR',code:'SERVICE_UNAVAILABLE',reason:'Operation unavailable; retry the same idempotency key',next_action:'retry'}; status=503; }
    if (res.locals.principal) {
      try { await engine.audit(res.locals.principal,auditContext.getStore()?.action ?? 'http.request','DENY',undefined,result.code as any); }
      catch { result={status:'ERROR',code:'SERVICE_UNAVAILABLE',reason:'Persistence unavailable',next_action:'retry'}; status=503; }
    }
    res.status(status).json(result);
  });
  return app;
}

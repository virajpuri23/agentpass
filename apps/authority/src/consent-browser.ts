import express from 'express';
import { createHash,randomBytes,timingSafeEqual } from 'node:crypto';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import { AccountService } from './accounts.js';
import { AuthorityEngine,deny } from './engine.js';
import { ConsentService } from './consent.js';
import { ConsentSessions } from './consent-sessions.js';
import { z } from 'zod';

export interface ConsentBrowserConfig {
  origin:string;issuer:string;resource:string;clientId:string;clientSecret:string;sessionKey:Buffer;
  verifyHumanToken:(token:string)=>Promise<{issuer:string;subject:string;client_id:string}>;
  policy:()=>AuthorityScope;
}
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const equal=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
export function createConsentRouter(engine:AuthorityEngine,config:ConsentBrowserConfig,now=()=>new Date()){
  const origin=new URL(config.origin),issuer=new URL(config.issuer),resource=new URL(config.resource);
  if(origin.origin!==config.origin||resource.origin!==origin.origin||resource.pathname!=='/mcp'||[origin,issuer,resource].some(url=>url.protocol!=='https:'||url.username||url.password||url.search||url.hash))throw new Error('Canonical HTTPS consent configuration required');
  const router=express.Router(),sessions=new ConsentSessions(engine.db,config.sessionKey,now),consent=new ConsentService(engine,config.policy,now),accounts=new AccountService(engine.db,now);
  const callback=new URL('/onboarding/callback',origin).href;
  const cookie=(id:string)=>`agentpass_consent=${id}; HttpOnly; Secure; SameSite=Lax; Path=/onboarding; Max-Age=${id?'300':'0'}`;
  const sessionId=(req:express.Request)=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('agentpass_consent='))?.slice(18)??'';
  const route=(fn:(req:express.Request,res:express.Response)=>Promise<unknown>)=>async(req:express.Request,res:express.Response,next:express.NextFunction)=>{try{await fn(req,res);}catch(error){next(error);}};
  router.use((_req,res,next)=>{res.set({'cache-control':'no-store','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'referrer-policy':'no-referrer','x-content-type-options':'nosniff'});next();});
  router.use(express.urlencoded({extended:false,limit:'2kb'}));
  router.get('/',route(async(req,res)=>{
    const connection=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/).parse(req.query.connection),state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
    const id=await sessions.create({phase:'LOGIN',connection,state,verifier});
    const url=new URL('authorize',issuer.href.endsWith('/')?issuer:new URL(issuer.href+'/'));
    for(const [name,value] of Object.entries({client_id:config.clientId,response_type:'code',redirect_uri:callback,scope:'openid agentpass:connect',resource:resource.href,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'login'}))url.searchParams.set(name,value);
    res.setHeader('set-cookie',cookie(id));res.redirect(303,url.href);
  }));
  router.get('/callback',route(async(req,res)=>{
    const id=sessionId(req),session=await sessions.read(id),query=z.object({code:z.string().min(1).max(4096),state:z.string().min(1).max(128)}).parse(req.query);
    if(!session||session.phase!=='LOGIN'||typeof session.state!=='string'||!equal(query.state,session.state))deny('INVALID_CALLER','Invalid consent login state',403);
    if(!await sessions.consume(id))deny('INVALID_CALLER','Consent login already consumed',403);
    const response=await fetch(new URL('oauth/token',issuer.href.endsWith('/')?issuer:new URL(issuer.href+'/')),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',code:query.code,redirect_uri:callback,client_id:config.clientId,client_secret:config.clientSecret,code_verifier:session.verifier})});
    if(!response.ok)deny('INVALID_CALLER','Consent login unavailable',401);
    const {access_token}=z.object({access_token:z.string().min(1).max(16384)}).parse(await response.json());
    const identity=await config.verifyHumanToken(access_token);
    if(identity.client_id!==config.clientId)deny('INVALID_CALLER','Consent browser client mismatch',401);
    const account=await accounts.accountForIdentity(identity);
    if(!account)deny('INVALID_CALLER','Connect your assistant before authorizing it',403);
    const connection=await engine.db.prepare('SELECT account_id FROM assistant_connections WHERE id=?').get(session.connection);
    if(!connection||connection.account_id!==account.account_id)deny('INVALID_CALLER','Connection unavailable',403);
    const next=await sessions.create({phase:'REVIEW',connection:session.connection,account_id:account.account_id,csrf:randomBytes(32).toString('base64url')});
    res.setHeader('set-cookie',cookie(next));res.redirect(303,'/onboarding/approve');
  }));
  router.get('/approve',route(async(req,res)=>{
    const session=await sessions.read(sessionId(req));if(!session||session.phase!=='REVIEW')deny('INVALID_CALLER','Sign in to authorize this connection',401);
    const connection=await engine.db.prepare('SELECT client_id FROM assistant_connections WHERE id=? AND account_id=?').get(session.connection,session.account_id);
    if(!connection)deny('INVALID_CALLER','Connection unavailable',403);
    const policy=config.policy();
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize AgentPass</title><main><h1>Authorize your assistant connection</h1><p>All orders are simulated. Approve only the access you want this assistant and its children to have.</p><p>Client: ${escape(connection.client_id)}. Connection: ${escape(String(session.connection))}</p><p>Suppliers: ${escape(policy.supplier_ids.join(', ')||'None')}. Products: ${escape(policy.sku_ids.join(', ')||'None')}. Expires within one hour; delegation depth at most ${policy.max_delegation_depth}.</p><form method="post" action="/onboarding/approve"><input type="hidden" name="csrf" value="${escape(String(session.csrf))}"><label for="budget">Total simulated purchase budget (USD)</label><input id="budget" name="budget" type="number" min="0" max="${(policy.total_budget_cents/100).toFixed(2)}" step="0.01" value="0.00" required><p>Zero permits quotes only. Maximum per purchase is ${(policy.max_per_action_cents/100).toFixed(2)} USD. Reconnecting will not reset this budget.</p><button type="submit">Approve this limited access</button></form></main></html>`);
  }));
  router.post('/approve',route(async(req,res)=>{
    const id=sessionId(req),session=await sessions.read(id),body=z.object({csrf:z.string().min(1).max(128),budget:z.string().regex(/^\d{1,10}(\.\d{1,2})?$/)}).strict().parse(req.body);
    if(req.get('origin')!==origin.origin||!session||session.phase!=='REVIEW'||typeof session.csrf!=='string'||!equal(body.csrf,session.csrf))deny('INVALID_CALLER','Consent session or CSRF invalid',403);
    const [whole,fraction='']=body.budget.split('.'),budget=Number(whole)*100+Number(fraction.padEnd(2,'0')),policy=config.policy();
    if(!Number.isSafeInteger(budget)||budget>policy.total_budget_cents)deny('OUTSIDE_PARENT_SCOPE','Purchase budget exceeds service policy');
    const scope:AuthorityScope={...policy,actions:budget?['supplier.quote.request','supplier.purchase.execute']:['supplier.quote.request'],max_per_action_cents:Math.min(budget,policy.max_per_action_cents),total_budget_cents:budget,expires_at:new Date(Math.min(Date.parse(policy.expires_at),now().getTime()+3600000)).toISOString()};
    if(!await sessions.consume(id))deny('INVALID_CALLER','Consent session already consumed',403);
    const request=await consent.request(String(session.account_id),String(session.connection),scope);await consent.approve(String(session.account_id),request.id);
    res.setHeader('set-cookie',cookie(''));res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>AgentPass authorized</title><main><h1>Connection authorized</h1><p>Return to your assistant and inspect your granted authority. No credential was shared with the conversation.</p></main></html>');
  }));
  return router;
}

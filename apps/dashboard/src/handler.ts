import { probeMcp } from './probe.js';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAuthorityClient } from '../../mcp/agentpass-manufact/src/authority-client.js';

type Options = { authorityUrl: string; mcpUrl: string; origin: string; now?: () => number };
export function createConsoleHandler(options: Options) {
  const origin = new URL(options.origin).origin;
  const secure = origin.startsWith('https:');
  if (!secure && !['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)) throw new Error('Console requires HTTPS outside loopback.');
  const endpoint = new URL(options.mcpUrl);
  for (const target of [endpoint,new URL(options.authorityUrl)]) {
    if (target.username || target.password || target.search || target.hash || (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname)))) throw new Error('Service URLs require HTTPS outside loopback and cannot contain credentials or query parameters.');
  }
  // shortcut: sessions are process-local and expire after one hour; use a shared session store before running multiple replicas.
  const sessions = new Map<string,{token:string;expires:number}>();
  const now = options.now ?? Date.now;
  const headers = {'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY',
    'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"};
  const json = (body: unknown, status = 200, extra = {}) => Response.json(body,{status,headers:{...headers,...extra}});
  const failure = (code: string, reason: string, status: number) => json({status:'DENIED',code,reason},status);
  const cookie = (id: string) => `agentpass_session=${id}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin) return failure('INVALID_ORIGIN','Console origin mismatch.',403);
      if (url.search) return failure('INVALID_REQUEST','Query parameters are not supported.',400);
      if (request.method === 'GET' && ['/connect','/console','/console.js','/console.css'].includes(url.pathname)) {
        const file = url.pathname.endsWith('.js') ? 'console.js' : url.pathname.endsWith('.css') ? 'console.css' : 'index.html';
        return new Response(await readFile(resolve(process.env.CONSOLE_ASSETS_DIR ?? 'apps/dashboard/public',file),'utf8'),{headers:{...headers,'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'}});
      }
      if (request.method === 'GET' && url.pathname === '/console-api/config') return json({mcp_url:endpoint.href,oauth:'not_configured'});
      if (request.method !== 'GET' && (request.headers.get('origin') !== origin || !request.headers.get('content-type')?.startsWith('application/json'))) return failure('INVALID_ORIGIN','Same-origin JSON request required.',403);
      const sessionId = request.headers.get('cookie')?.split(';').map(c => c.trim()).find(c => c.startsWith('agentpass_session='))?.slice(18);
      for (const [id,session] of sessions) if (session.expires <= now()) sessions.delete(id);
      if (request.method === 'POST' && url.pathname === '/console-api/logout') {
        if (sessionId) sessions.delete(sessionId);
        return json({status:'OK'},200,{'set-cookie':`${cookie('')}; Max-Age=0`});
      }
      let text = '';
      if (request.method === 'POST' && request.body) {
        const reader = request.body.getReader();const decoder = new TextDecoder();let bytes = 0;
        for (;;) {
          const {done,value} = await reader.read();if (done) break;
          bytes += value.byteLength;
          if (bytes>32768) {await reader.cancel();return failure('INVALID_REQUEST','Request too large.',413);}
          text += decoder.decode(value,{stream:true});
        }
        text += decoder.decode();
      }
      const body = text ? JSON.parse(text) : undefined;
      if (request.method === 'POST' && url.pathname === '/console-api/session') {
        if (sessionId) sessions.delete(sessionId);
        if (!body?.credential) return failure('MISSING_CREDENTIAL','Supply your existing agent credential.',401);
        if (Object.keys(body).length !== 1 || typeof body.credential !== 'string' || !/^[^\s]{1,1024}$/.test(body.credential)) return failure('INVALID_CREDENTIAL','Credential format is invalid.',401);
        const result = await createAuthorityClient({authorityUrl:options.authorityUrl,agentApiKey:body.credential})('GET','v1/me');
        if (result.status !== 'OK') return json({...result,code:result.code==='INVALID_CALLER'?'INVALID_CREDENTIAL':result.code},result.code==='INVALID_CALLER'?401:503);
        await probeMcp(endpoint.href,body.credential,{principal_id:result.data.principal_id,organization_id:result.data.organization_id});
        if (sessions.size >= 1000) return failure('SERVICE_UNAVAILABLE','Session capacity reached. Retry later.',503);
        const id = randomBytes(32).toString('base64url');
        sessions.set(id,{token:body.credential,expires:now()+3600000});
        return json({status:'OK',data:{...result.data,mcp_url:endpoint.href}},200,{'set-cookie':cookie(id)});
      }
      const session = sessionId && sessions.get(sessionId);
      if (!session) return failure('MISSING_CREDENTIAL','Connect with your credential to continue.',401);
      const client = createAuthorityClient({authorityUrl:options.authorityUrl,agentApiKey:session.token});
      if (request.method === 'GET' && url.pathname === '/console-api/snapshot') {
        const result = await client('GET','v1/console');
        return json(result,result.status==='OK'?200:result.code==='INVALID_CALLER'?401:503);
      }
      const match = url.pathname.match(/^\/console-api(\/v1\/(?:authority\/requests(?:\/[a-zA-Z0-9_-]+\/(?:respond|accept))?|grants\/[a-zA-Z0-9_-]+\/revoke))$/);
      if (request.method === 'POST' && match) {
        const result = await client('POST',match[1].slice(1),body);
        return json(result,result.status==='OK'?200:result.status==='ERROR'?503:403);
      }
      return failure('INVALID_REQUEST','Unknown console endpoint.',404);
    } catch (error) { if (error instanceof SyntaxError) return failure('INVALID_REQUEST','Invalid JSON request.',400);return json({status:'ERROR',code:'SERVICE_UNAVAILABLE',reason:'Console unavailable. Refresh or reconnect.'},503); }
  };
}

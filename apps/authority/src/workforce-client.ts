import { z } from 'zod';
import { WORKFORCE_ACTIONS, workforceActionSchema, workforceDecisionSchema, type WorkforceActionInput, type WorkforceDecision, type WorkforceScope } from '../../../packages/contracts/src/workforce.js';
import type { WorkforceOptions, WorkforceExecutionContext } from './workforce.js';

function baseUrl(value:string) {
  const url = new URL(value);
  if (!['https:','http:'].includes(url.protocol) || (url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) || url.username || url.password || url.search || url.hash) throw new Error('A trusted HTTPS or loopback service URL is required');
  return url;
}

/** Mock `fetch` in B's contract tests; keep each agent's credential separate. */
export function createWorkforceClient(config:{authorityUrl:string;credential:string;fetch?:typeof fetch}) {
  const base=baseUrl(config.authorityUrl);
  const request=async(path:string,body?:unknown)=>{
    const response=await (config.fetch??fetch)(new URL(path,base),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{authorization:`Bearer ${config.credential}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return response.json();
  };
  const action=async(path:string,input:WorkforceActionInput):Promise<WorkforceDecision>=>{
    const result=await request(path,workforceActionSchema.parse(input));
    const decision=workforceDecisionSchema.safeParse(result);
    if (decision.success) return decision.data;
    if (result.status==='DENIED'||result.status==='ERROR') return {status:'DENY',code:result.code,reason:result.reason,next_action:result.next_action};
    throw new Error('Invalid authority response');
  };
  return {
    grants:()=>request('/v1/me'),
    verify:(input:WorkforceActionInput)=>action('/v1/actions/verify',input),
    execute:(input:WorkforceActionInput)=>action('/v1/actions/execute',input),
    delegate:(parent:string,recipient:string,scope:WorkforceScope)=>request(`/v1/grants/${encodeURIComponent(parent)}/delegate`,{recipient_principal_id:recipient,scope}),
    request:(parent:string,scope:WorkforceScope,reason:string)=>request('/v1/authority/requests',{parent_grant_id:parent,requested_scope:scope,reason}),
    getRequest:(id:string)=>request(`/v1/authority/requests/${encodeURIComponent(id)}`),
    respond:(id:string,scope:WorkforceScope)=>request(`/v1/authority/requests/${encodeURIComponent(id)}/respond`,{decision:'COUNTEROFFER',offered_scope:scope}),
    accept:(id:string,key:string)=>request(`/v1/authority/requests/${encodeURIComponent(id)}/accept`,{idempotency_key:key}),
    revoke:(id:string,reason:string)=>request(`/v1/grants/${encodeURIComponent(id)}/revoke`,{reason}),
  };
}

/** Server-only adapter for B's fixed authenticated gateway; never expose its key to agents. */
export function createProtectedWorkforceClient(config:{gatewayUrl:string;serviceKey:string;fetch?:typeof fetch}) {
  const base=baseUrl(config.gatewayUrl);
  if (!config.serviceKey) throw new Error('Protected gateway service key required');
  return async(context:WorkforceExecutionContext):Promise<Record<string,unknown>>=>{
    const response=await (config.fetch??fetch)(new URL('/internal/workforce/execute',base),{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json','x-service-key':config.serviceKey},
      body:JSON.stringify({execution_id:context.execution_id,principal:context.principal,input:context.input}),
    });
    if (!response.ok) throw new Error('Protected gateway unavailable');
    const result=await response.json();
    if (!result || result.status!=='OK' || !result.data || typeof result.data!=='object' || Array.isArray(result.data)) throw new Error('Invalid protected gateway result');
    return result.data;
  };
}

/** Optional server-owned registrations; agent input never chooses an upstream URL. */
export function workforceFromEnvironment(env:NodeJS.ProcessEnv = process.env):WorkforceOptions|undefined {
  if (!env.WORKFORCE_RESOURCES_JSON && !env.WORKFORCE_GATEWAY_URL && !env.WORKFORCE_SERVICE_KEY) return undefined;
  if (!env.WORKFORCE_RESOURCES_JSON || !env.WORKFORCE_GATEWAY_URL || !env.WORKFORCE_SERVICE_KEY) throw new Error('Workforce gateway configuration is incomplete');
  const resources=z.array(z.object({resource:z.string().min(1),organization_id:z.string().min(1),owner_principal_id:z.string().min(1),repo_root:z.string().min(1).optional(),allowed_actions:z.array(z.enum(WORKFORCE_ACTIONS))}).strict()).parse(JSON.parse(env.WORKFORCE_RESOURCES_JSON));
  const execute=createProtectedWorkforceClient({gatewayUrl:env.WORKFORCE_GATEWAY_URL,serviceKey:env.WORKFORCE_SERVICE_KEY});
  return {resources:resources.map(resource=>({...resource,execute}))};
}

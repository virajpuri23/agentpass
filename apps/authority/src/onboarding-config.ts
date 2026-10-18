import { z } from 'zod';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import { createHumanTokenVerifier,humanOAuthConfigFromEnv } from '../../mcp/agentpass-manufact/src/oauth.js';
import type { ConsentBrowserConfig } from './consent-browser.js';
import type { VerifiedConnectionIdentity } from './accounts.js';
import type { SupabaseLoginConfig } from './supabase-login.js';
import type { AuthorityStore } from '../../../db/store.js';
interface OnboardingRuntimeOptions {
  verifyHumanToken?:(token:string)=>Promise<VerifiedConnectionIdentity>;
  consentBrowser?:ConsentBrowserConfig;
  agentControl?:{environment:NodeJS.ProcessEnv};
  supabaseLogin?:SupabaseLoginConfig;
}

export async function assertOAuthResourceBindings(db:AuthorityStore,env:NodeJS.ProcessEnv=process.env){
  const oauth=humanOAuthConfigFromEnv(env);if(!oauth)return;
  const clients=new Set([...oauth.clientIds,...(env.AGENTPASS_CONSENT_CLIENT_ID?[env.AGENTPASS_CONSENT_CLIENT_ID]:[])]);
  for(const client of clients){
    const row=await db.prepare('SELECT resource FROM oauth_resource_clients WHERE client_id=?').get(client);
    if(row?.resource!==new URL(oauth.resource).href)throw new Error('Approved OAuth client/resource mapping is missing; configure private hook policy before startup');
  }
}

export function onboardingFromEnvironment(env:NodeJS.ProcessEnv=process.env):OnboardingRuntimeOptions{
  const oauth=humanOAuthConfigFromEnv(env);
  const consentKeys=['AGENTPASS_CONSENT_CLIENT_ID','AGENTPASS_CONSENT_CLIENT_SECRET','AGENTPASS_CONSENT_SESSION_KEY'] as const;
  const configured=consentKeys.filter(key=>env[key]!==undefined);
  if(!oauth){
    if(configured.length||env.SUPABASE_PUBLISHABLE_KEY)throw new Error('Consent requires OAuth configuration');
    if(['AGENTPASS_CREDENTIAL_STORE','AGENTPASS_RUNNERS_JSON','AGENTPASS_ONBOARDING_RUNNER_ID'].some(key=>env[key]!==undefined))throw new Error('Agent control requires OAuth configuration');
    return {};
  }
  if(configured.length!==consentKeys.length||env.SUPABASE_PUBLISHABLE_KEY===undefined)throw new Error('OAuth onboarding requires trusted consent and Supabase login settings');
  const verifyHumanToken=createHumanTokenVerifier(oauth);
  const sessionKey=z.string().regex(/^[a-f0-9]{64}$/).parse(env.AGENTPASS_CONSENT_SESSION_KEY);
  const resources=(key:string)=>z.array(z.string().min(1).max(200)).max(100).refine(ids=>new Set(ids).size===ids.length).parse(JSON.parse(env[key]??'[]'));
  const supplierIds=resources('AGENTPASS_ONBOARDING_SUPPLIER_IDS'),skuIds=resources('AGENTPASS_ONBOARDING_SKU_IDS');
  const cents=(key:string)=>z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(env[key]??'0');
  const total=cents('AGENTPASS_ONBOARDING_MAX_BUDGET_CENTS'),perAction=cents('AGENTPASS_ONBOARDING_MAX_PER_ACTION_CENTS');
  if(perAction>total)throw new Error('Per-action consent cap cannot exceed total cap');
  const resource=new URL(oauth.resource),issuer=new URL(String(oauth.issuer).includes('://')?String(oauth.issuer):`https://${oauth.issuer}`);
  const policy=():AuthorityScope=>({actions:['supplier.quote.request','supplier.purchase.execute'],supplier_ids:supplierIds,sku_ids:skuIds,max_per_action_cents:perAction,total_budget_cents:total,expires_at:new Date(Date.now()+3600000).toISOString(),max_delegation_depth:2});
  const clientId=z.string().trim().min(1).parse(env.AGENTPASS_CONSENT_CLIENT_ID),clientSecret=z.string().min(1).parse(env.AGENTPASS_CONSENT_CLIENT_SECRET);
  const consentBrowser:ConsentBrowserConfig={origin:resource.origin,issuer:issuer.href,resource:resource.href,clientId,clientSecret,sessionKey:Buffer.from(sessionKey,'hex'),policy,verifyHumanToken:createHumanTokenVerifier({...oauth,clientIds:[clientId]})};
  const publishableKey=z.string().regex(/^sb_publishable_[A-Za-z0-9_-]+$/).parse(env.SUPABASE_PUBLISHABLE_KEY);
  const redirectUris=z.array(z.url()).max(50).parse(JSON.parse(env.AGENTPASS_OAUTH_REDIRECT_URIS??'[]'));
  const supabaseLogin:SupabaseLoginConfig={origin:resource.origin,supabaseUrl:new URL(issuer.href).origin,publishableKey,sessionKey:Buffer.from(sessionKey,'hex'),clientIds:[...new Set([...oauth.clientIds,clientId])],redirectUris:[...new Set([...redirectUris,new URL('/onboarding/callback',resource).href])]};
  return {verifyHumanToken,consentBrowser,supabaseLogin,agentControl:{environment:env}};
}

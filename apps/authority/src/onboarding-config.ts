import { z } from 'zod';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import { createHumanTokenVerifier,humanOAuthConfigFromEnv } from '../../mcp/agentpass-manufact/src/oauth.js';
import type { ConsentBrowserConfig } from './consent-browser.js';
import type { VerifiedConnectionIdentity } from './accounts.js';
interface OnboardingRuntimeOptions {
  verifyHumanToken?:(token:string)=>Promise<VerifiedConnectionIdentity>;
  consentBrowser?:ConsentBrowserConfig;
  agentControl?:{environment:NodeJS.ProcessEnv};
}

export function onboardingFromEnvironment(env:NodeJS.ProcessEnv=process.env):OnboardingRuntimeOptions{
  const oauth=humanOAuthConfigFromEnv(env);
  const consentKeys=['AGENTPASS_CONSENT_CLIENT_ID','AGENTPASS_CONSENT_CLIENT_SECRET','AGENTPASS_CONSENT_SESSION_KEY'] as const;
  const configured=consentKeys.filter(key=>env[key]!==undefined);
  if(!oauth){if(configured.length)throw new Error('Consent requires OAuth configuration');return {};}
  const verifyHumanToken=createHumanTokenVerifier(oauth);
  let consentBrowser:ConsentBrowserConfig|undefined;
  if(configured.length){
    if(configured.length!==consentKeys.length)throw new Error('Configure all trusted consent client and session settings');
    const sessionKey=z.string().regex(/^[a-f0-9]{64}$/).parse(env.AGENTPASS_CONSENT_SESSION_KEY);
    const resources=(key:string)=>z.array(z.string().min(1).max(200)).max(100).refine(ids=>new Set(ids).size===ids.length).parse(JSON.parse(env[key]??'[]'));
    const supplierIds=resources('AGENTPASS_ONBOARDING_SUPPLIER_IDS'),skuIds=resources('AGENTPASS_ONBOARDING_SKU_IDS');
    const cents=(key:string)=>z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(env[key]??'0');
    const total=cents('AGENTPASS_ONBOARDING_MAX_BUDGET_CENTS'),perAction=cents('AGENTPASS_ONBOARDING_MAX_PER_ACTION_CENTS');
    if(perAction>total)throw new Error('Per-action consent cap cannot exceed total cap');
    const resource=new URL(oauth.resource),issuer=new URL(String(oauth.issuer).includes('://')?String(oauth.issuer):`https://${oauth.issuer}`);
    const policy=():AuthorityScope=>({actions:['supplier.quote.request','supplier.purchase.execute'],supplier_ids:supplierIds,sku_ids:skuIds,max_per_action_cents:perAction,total_budget_cents:total,expires_at:new Date(Date.now()+3600000).toISOString(),max_delegation_depth:2});
    const clientId=z.string().trim().min(1).parse(env.AGENTPASS_CONSENT_CLIENT_ID),clientSecret=z.string().min(1).parse(env.AGENTPASS_CONSENT_CLIENT_SECRET);
    consentBrowser={origin:resource.origin,issuer:issuer.href,resource:resource.href,clientId,clientSecret,sessionKey:Buffer.from(sessionKey,'hex'),policy,verifyHumanToken:createHumanTokenVerifier({...oauth,clientIds:[clientId]})};
  }
  return {verifyHumanToken,...(consentBrowser?{consentBrowser}:{}),agentControl:{environment:env}};
}

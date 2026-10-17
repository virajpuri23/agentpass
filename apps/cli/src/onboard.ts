import { readChildCredential } from './child-credential.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { scopeSchema } from '../../mcp/agentpass-manufact/src/authority-client.js';

const grantSchema = z.object({
  id:z.string(),organization_id:z.string(),issuer_principal_id:z.string(),subject_principal_id:z.string(),
  parent_grant_id:z.string().nullable(),scope:scopeSchema,revoked_at:z.string().nullable(),
});
const identitySchema = z.object({principal_id:z.string().min(1),organization_id:z.string().min(1),
  inspector:z.object({budgets:z.array(z.object({grant_id:z.string(),remaining_budget_cents:z.number().nullable(),authority_code:z.string()}))})});
const grantsSchema = z.object({status:z.literal('OK'),data:z.object({grants:z.array(grantSchema)})});
const descriptionSchema = z.object({status:z.literal('OK'),data:z.object({actions:z.array(z.string()),recovery_tools:z.array(z.string())})});
const failure = (code:string,reason:string,next_action='retry') => ({status:'ERROR' as const,code,reason,next_action});

export async function onboardAgent(endpoint: string | undefined, credential: string | undefined) {
  if (!credential) return failure('MISSING_CREDENTIAL','Supply this agent’s provisioned credential through AGENT_API_KEY.','contact_owner');
  if (!/^[^\s]{1,1024}$/.test(credential)) return failure('INVALID_CREDENTIAL','Credential format is invalid.','contact_owner');
  let url:URL;
  try {
    url=new URL(endpoint??'');
    if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error();
  } catch {return failure('INVALID_ENDPOINT','Supply an HTTPS MCP URL without credentials, query or fragment. HTTP is allowed only on loopback.','configure_endpoint');}
  const client=new Client({name:'agentpass-agent-onboarding',version:'1.0.0'});
  let rejectedCredential=false;
  try {
    await client.connect(new StreamableHTTPClientTransport(url,{
      requestInit:{headers:{authorization:`Bearer ${credential}`},redirect:'error'},
      fetch:async(input,init)=>{const response=await fetch(input,init);if(response.status===401||response.status===403)rejectedCredential=true;return response;},
    }),{signal:AbortSignal.timeout(5000)});
    const tools=await client.listTools({}, {signal:AbortSignal.timeout(5000)});
    if(!['describe_authority','get_my_grants'].every(name=>tools.tools.some(tool=>tool.name===name))) return failure('INCOMPATIBLE_SERVER','The endpoint does not expose AgentPass onboarding tools.','configure_endpoint');
    const description=await client.callTool({name:'describe_authority',arguments:{}},{signal:AbortSignal.timeout(5000)});
    const result=await client.callTool({name:'get_my_grants',arguments:{}},{signal:AbortSignal.timeout(5000)});
    const identity=identitySchema.parse(result._meta);
    const {grants}=grantsSchema.parse(result.structuredContent).data;
    const capabilities=descriptionSchema.parse(description.structuredContent).data;
    if(result.isError||description.isError||grants.some(g=>g.subject_principal_id!==identity.principal_id||g.organization_id!==identity.organization_id)) return failure('INVALID_IDENTITY','The server returned inconsistent caller authority.','contact_owner');
    return {status:'OK' as const,code:grants.length?'ONBOARDED':'AUTHENTICATED_NO_GRANTS',
      reason:grants.length?'Authenticated principal and grants read through MCP. Inspect scope before acting.':'Authenticated principal has no grants; initial delegation must come from a trusted parent or orchestrator.',
      next_action:grants.length?'inspect_grants':'contact_owner',
      data:{endpoint:url.href,...identity,grants,tools:tools.tools.map(tool=>tool.name),...capabilities,
        workflow:{start:['describe_authority','get_my_grants'],on_authority_required:['request_authority','get_authority_request','accept_authority_offer'],parent_response:'respond_authority_request',protected_action:'execute_action'},
        requires_browser:false,initial_authority:'trusted_provisioning',side_effects:false}};
  } catch {
    return rejectedCredential ? failure('INVALID_CREDENTIAL','The MCP endpoint rejected this agent’s credential.','contact_owner')
      : failure('SERVICE_UNAVAILABLE','Could not verify AgentPass identity and grants through the configured MCP endpoint.');
  } finally {await client.close().catch(()=>undefined);}
}

export async function runOnboarding(args:string[],env:NodeJS.ProcessEnv) {
  try {
    const {values}=parseArgs({args,options:{url:{type:'string'},help:{type:'boolean'},'credential-file':{type:'string'}},strict:true,allowPositionals:false});
    if(values.help)return {status:'OK' as const,code:'HELP',reason:'Use: npm run --silent agent:onboard -- --url <MCP_URL>. Supply AGENT_API_KEY via the runtime secret environment. MCP_PUBLIC_URL may supply the endpoint. A child runtime may instead use --credential-file <private child file>, which never falls back to the parent environment credential. This command performs read-only MCP calls; no browser, credential storage, grant issuance or purchase.',next_action:'configure_endpoint'};
    if(values['credential-file']) {
      let state;
      try {state=readChildCredential(values['credential-file']);}catch{return failure('INVALID_CREDENTIAL_FILE','Child credential file is missing, unsafe or invalid.','check_local_files');}
      if(values.url&&values.url!==state.endpoint)return failure('INVALID_ENDPOINT','Child credentials may only be sent to their recorded MCP endpoint.','configure_endpoint');
      return onboardAgent(state.endpoint,state.credential);
    }
    return onboardAgent(values.url??env.MCP_PUBLIC_URL,env.AGENT_API_KEY);
  } catch {return failure('INVALID_ARGUMENTS','Use --url <MCP_URL> or --help. Credentials must be supplied through AGENT_API_KEY, never arguments.','configure_endpoint');}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const result=await runOnboarding(process.argv.slice(2),process.env);
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=result.status==='OK'?0:1;
}

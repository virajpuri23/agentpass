import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync,statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { scopeSchema } from '../../mcp/agentpass-manufact/src/authority-client.js';
import { prepareChildCredential,childCredentialHash } from './child-credential.js';

const resultSchema=z.object({status:z.literal('OK'),data:z.object({principal:z.object({id:z.string(),organization_id:z.string(),kind:z.literal('AGENT'),role:z.literal('SERVICE')}),grant:z.object({id:z.string(),subject_principal_id:z.string(),issuer_principal_id:z.string(),organization_id:z.string(),parent_grant_id:z.string(),scope:scopeSchema,revoked_at:z.null()})})});
const failure=(code:string,reason:string,next_action='retry')=>({status:'ERROR' as const,code,reason,next_action});
export async function runProvisioning(args:string[],env:NodeJS.ProcessEnv) {
  let values;
  try {({values}=parseArgs({args,options:{url:{type:'string'},'parent-grant':{type:'string'},'scope-file':{type:'string'},'credential-file':{type:'string'},help:{type:'boolean'}},strict:true,allowPositionals:false}));}
  catch {return failure('INVALID_ARGUMENTS','Use --help. Credentials are accepted only through the runtime environment.','configure_endpoint');}
  if(values.help)return {status:'OK' as const,code:'HELP',reason:'Use: npm run --silent agent:provision -- --url <MCP_URL> --parent-grant <grant-id> --scope-file <scope.json> --credential-file <private path outside repo>. Supply the parent AGENT_API_KEY through the secret environment. Reuse the same files to retry. Only the child verifier reaches MCP; the child secret stays in the private file.',next_action:'configure_endpoint'};
  const token=env.AGENT_API_KEY;
  if(!token||!/^\S{1,1024}$/.test(token))return failure('MISSING_CREDENTIAL','Supply the parent credential through AGENT_API_KEY.','contact_owner');
  let url:URL;
  try {url=new URL(values.url??env.MCP_PUBLIC_URL??'');if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error();}
  catch{return failure('INVALID_ENDPOINT','Use an HTTPS MCP URL without embedded credentials or query parameters. HTTP is allowed only on loopback.','configure_endpoint');}
  let state;
  try {
    if(!values['parent-grant']||!values['scope-file']||!values['credential-file']||statSync(values['scope-file']).size>32768)throw new Error();
    const scope=scopeSchema.parse(JSON.parse(readFileSync(values['scope-file'],'utf8')));
    state=prepareChildCredential(values['credential-file'],{endpoint:url.href,parent_grant_id:values['parent-grant'],scope});
  } catch {return failure('INVALID_PROVISIONING_INPUT','Supply a valid scope file and a private credential-file path outside the repository. Existing files must belong to the identical request; they are never overwritten.','check_local_files');}
  const client=new Client({name:'agentpass-parent-provisioning',version:'1.0.0'});
  let rejected=false;
  try {
    await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:`Bearer ${token}`},redirect:'error'},fetch:async(input,init)=>{const r=await fetch(input,init);if(r.status===401||r.status===403)rejected=true;return r;}}),{signal:AbortSignal.timeout(5000)});
    const result=await client.callTool({name:'provision_child',arguments:{parent_grant_id:state.parent_grant_id,scope:state.scope,credential_hash:childCredentialHash(state),idempotency_key:state.idempotency_key}},{signal:AbortSignal.timeout(5000)});
    const parsed=resultSchema.safeParse(result.structuredContent);
    if(result.isError||!parsed.success){
      const denial=z.object({status:z.enum(['DENIED','ERROR']),code:z.string(),reason:z.string(),next_action:z.string().optional()}).safeParse(result.structuredContent);
      return denial.success?{...denial.data,reason:'Parent provisioning was denied by the canonical authority service.'}:failure('SERVICE_UNAVAILABLE','Provisioning result could not be verified. Retry with the same credential file.');
    }
    const {principal,grant}=parsed.data.data;
    if(grant.subject_principal_id!==principal.id||grant.organization_id!==principal.organization_id||grant.parent_grant_id!==state.parent_grant_id||JSON.stringify(grant.scope)!==JSON.stringify(state.scope))return failure('INVALID_IDENTITY','Provisioning response did not match the requested child authority.','contact_owner');
    return {status:'OK' as const,code:'CHILD_PROVISIONED',reason:'Distinct child principal and bounded grant persisted. Credential remains in the private runtime file.',next_action:'launch_child',data:{...parsed.data.data,credential_file:resolve(values['credential-file']!),requires_browser:false}};
  } catch {return rejected?failure('INVALID_CREDENTIAL','The MCP endpoint rejected the parent credential.','contact_owner'):failure('SERVICE_UNAVAILABLE','Provisioning unavailable. Retry using the same credential file; do not regenerate the child secret.');}
  finally {await client.close().catch(()=>undefined);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const result=await runProvisioning(process.argv.slice(2),process.env);process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.status==='OK'?0:1;}

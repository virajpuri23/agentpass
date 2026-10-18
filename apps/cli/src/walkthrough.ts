import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Public fixture credentials are valid only in the disposable loopback console demo.
export async function runWalkthrough(endpoint:string) {
  const url=new URL(endpoint);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new Error('Use the disposable loopback demo MCP URL.');
  const runId='run-'+randomUUID();
  const clients:Client[]=[];
  async function connect(role:string){const client=new Client({name:'walkthrough-'+role,version:'1.0.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:'Bearer console-fixture-'+role,'x-agentpass-run-id':runId},redirect:'error'}}),{signal:AbortSignal.timeout(5000)});return client;}
  async function call(client:Client,name:string,args:Record<string,unknown>={}){const result=await client.callTool({name,arguments:args},{signal:AbortSignal.timeout(5000)});const value=result.structuredContent as {status:string;code?:string;data:any};if(!value||value.status!=='OK')throw new Error(value?.code??'Invalid MCP result');return value.data;}
  const outcomes:Record<string,string>={};
  try{
    const buyer=await connect('buyer'),child=await connect('sourcing');
    const {grants}=await call(buyer,'get_my_grants');const root=grants.find((g:any)=>g.id==='grant-root-buyer');if(!root)throw new Error('Disposable demo root unavailable');
    const scope={actions:['supplier.quote.request'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:0,total_budget_cents:0,expires_at:new Date(Math.min(Date.now()+600000,Date.parse(root.scope.expires_at))).toISOString(),max_delegation_depth:0};
    const grant=await call(buyer,'delegate_authority',{parent_grant_id:root.id,recipient_principal_id:'sourcing-agent',scope});
    const base={supplier_id:'supplier-co',sku_id:'PACK-500'};
    const quote=await call(child,'execute_action',{...base,grant_id:grant.id,action:'supplier.quote.request',quantity:500,idempotency_key:runId+'-quote'});
    const purchase={...base,grant_id:grant.id,action:'supplier.purchase.execute',quote_id:quote.quote_id,idempotency_key:runId+'-purchase'};
    async function expectCode(args:Record<string,unknown>,code:string){const result=await child.callTool({name:'execute_action',arguments:args});const value=result.structuredContent as any;if(value?.code!==code)throw new Error('Expected '+code);outcomes[code]='observed';}
    await expectCode(purchase,'INSUFFICIENT_SCOPE');
    const requested={...scope,actions:['supplier.purchase.execute'],max_per_action_cents:120000,total_budget_cents:120000};
    const request=await call(child,'request_authority',{parent_grant_id:root.id,requested_scope:requested,reason:'Local product walkthrough: 500 units quoted at $850.'});
    await call(buyer,'respond_authority_request',{request_id:request.request_id,decision:'COUNTEROFFER',offered_scope:{...requested,max_per_action_cents:90000,total_budget_cents:90000}});
    const accepted=await call(child,'accept_authority_offer',{request_id:request.request_id,idempotency_key:runId+'-accept'});
    purchase.grant_id=accepted.id;
    const response=await child.callTool({name:'execute_action',arguments:purchase});const receipt=response.structuredContent as any;
    if(receipt?.status==='OK'){
      if(receipt.data.amount_cents!==85000||receipt.data.simulated!==true)throw new Error('Unexpected simulated receipt');
      const retry=await child.callTool({name:'execute_action',arguments:purchase});if(JSON.stringify(retry.structuredContent)!==JSON.stringify(receipt))throw new Error('Retry receipt changed');
      outcomes.purchase='COMPLETED';outcomes.retry='IDENTICAL_RECEIPT';
      await expectCode({...purchase,idempotency_key:runId+'-over'},'BUDGET_EXCEEDED');
    }else if(receipt?.code==='BUDGET_EXCEEDED')outcomes.purchase='BLOCKED_EXISTING_BUDGET';else throw new Error(receipt?.code??'Purchase failed');
    await expectCode({...base,grant_id:accepted.id,action:'supplier.margin.read',idempotency_key:runId+'-margin'},'SELLER_POLICY_DENIED');
    await call(buyer,'revoke_authority',{grant_id:accepted.id,reason:'Local walkthrough complete'});
    await expectCode({...purchase,idempotency_key:runId+'-revoked'},'GRANT_REVOKED');
    return {status:'OK',run_id:runId,simulated:true,fixture:true,outcomes,console_url:new URL('/console#run='+runId,url).href,next_action:'get_run'};
  }finally{await Promise.all(clients.map(c=>c.close().catch(()=>undefined)));}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(await runWalkthrough(process.argv[2]??'http://127.0.0.1:3112/mcp')));}catch{console.log(JSON.stringify({status:'ERROR',code:'WALKTHROUGH_FAILED',reason:'Start the disposable console, check its MCP URL, then inspect recorded runs for the last persisted decision.'}));process.exitCode=1;}}

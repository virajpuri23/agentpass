import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { onboardAgent } from './onboard.js';

export async function inspectRuns(args:string[],env:NodeJS.ProcessEnv) {
  let values;
  try {values=parseArgs({args,options:{url:{type:'string'},run:{type:'string'},help:{type:'boolean'}},strict:true,allowPositionals:false}).values;}
  catch{return {status:'ERROR',code:'INVALID_ARGUMENTS',reason:'Use --url <MCP_URL> and optional --run <run-id>.',next_action:'configure_endpoint'};}
  if(values.help)return {status:'OK',code:'HELP',reason:'Read-only: agent:runs -- --url <MCP_URL> [--run <run-id>]. Supply this caller’s AGENT_API_KEY in its private environment. Without --run, lists visible runs. No credential is printed or stored.'};
  if(values.run&&!/^run-[a-zA-Z0-9_-]{1,80}$/.test(values.run))return {status:'ERROR',code:'INVALID_ARGUMENTS',reason:'Invalid run ID.'};
  const verified=await onboardAgent(values.url??env.MCP_PUBLIC_URL,env.AGENT_API_KEY);
  if(verified.status!=='OK')return verified;
  const tool=values.run?'get_run':'list_runs';
  if(!verified.data.tools.includes(tool))return {status:'ERROR',code:'INCOMPATIBLE_SERVER',reason:'This MCP server does not expose run inspection.'};
  const client=new Client({name:'agentpass-run-inspector',version:'1.0.0'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(verified.data.endpoint),{requestInit:{headers:{authorization:`Bearer ${env.AGENT_API_KEY}`},redirect:'error'}}),{signal:AbortSignal.timeout(5000)});
    const result=await client.callTool({name:tool,arguments:values.run?{run_id:values.run}:{}},{signal:AbortSignal.timeout(5000)});
    const data=result.structuredContent as {status?:string}|undefined;
    if(!data?.status)throw new Error('Invalid response');
    return data;
  } catch{return {status:'ERROR',code:'SERVICE_UNAVAILABLE',reason:'Run inspection unavailable.',next_action:'retry'};}
  finally{await client.close().catch(()=>undefined);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const result=await inspectRuns(process.argv.slice(2),process.env);process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.status==='OK'?0:1;}

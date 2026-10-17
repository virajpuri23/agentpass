import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export async function probeMcp(url: string, token: string, expected: {principal_id:unknown;organization_id:unknown}) {
  const client = new Client({name:'agentpass-console-connection-test',version:'1.0.0'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:`Bearer ${token}`},redirect:'error'}}),{signal:AbortSignal.timeout(5000)});
    const result = await client.callTool({name:'get_my_grants',arguments:{}},{signal:AbortSignal.timeout(5000)});
    const output = result.structuredContent as {status?:string;data?:{grants?:unknown}} | undefined;
    if (result.isError || output?.status !== 'OK' || !Array.isArray(output.data?.grants) || result._meta?.principal_id !== expected.principal_id || result._meta?.organization_id !== expected.organization_id) throw new Error('Identity mismatch');
  } finally { await client.close(); }
}

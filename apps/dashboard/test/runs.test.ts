import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createServer,type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { HttpSupplierService } from '../../authority/src/supplier.js';
import { createSupplierApp } from '../../supplier/src/app.js';
import { createSupplierService } from '../../supplier/src/service.js';
import { sqliteStore } from '../../supplier/src/store.js';
import { runWalkthrough } from '../../cli/src/walkthrough.js';
import { inspectRuns } from '../../cli/src/runs.js';
import { createConsoleHandler } from '../src/handler.js';

const keys={'owner-1':'console-fixture-owner','buyer-agent':'console-fixture-buyer','sourcing-agent':'console-fixture-sourcing','supplier-agent':'console-fixture-supplier'};
describe('recorded runs across MCP, CLI and console',()=>{
  const db=openDatabase(':memory:');const store=sqliteStore(':memory:');const servers:Server[]=[];
  let base:string,mcpUrl:string,origin:string,previous:string|undefined,first:Awaited<ReturnType<typeof runWalkthrough>>,second:typeof first;
  async function listen(server:Server){servers.push(server);server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));return `http://127.0.0.1:${(server.address() as any).port}`;}
  async function read(path:string,token=keys['owner-1']){const r=await fetch(base+path,{headers:{authorization:'Bearer '+token}});return {http:r.status,...await r.json()};}
  beforeAll(async()=>{
    seedDatabase(db,keys);const supplier=await listen(createServer(createSupplierApp({service:createSupplierService({store}),serviceKey:'fixture-service'})));
    base=await listen(createServer(createAuthorityApp({db,supplier:new HttpSupplierService(supplier,'fixture-service')})));
    previous=process.env.AUTHORITY_URL;process.env.AUTHORITY_URL=base;
    const {default:adapter}=await import(pathToFileURL(process.cwd()+'/apps/mcp/agentpass-manufact/.mcp-use/build/index.js').href+'?recorded-runs');
    const {toNodeHandler}=await import('../../mcp/agentpass-manufact/node_modules/mcp-use/dist/node-bridge.js');
    origin=await listen(createServer(toNodeHandler(adapter,{onerror:()=>{}})));mcpUrl=origin+'/mcp';
    first=await runWalkthrough(mcpUrl);second=await runWalkthrough(mcpUrl);
  },30000);
  afterAll(async()=>{await Promise.all(servers.map(s=>new Promise<void>(r=>s.close(()=>r()))));db.close();await store.close();if(previous===undefined)delete process.env.AUTHORITY_URL;else process.env.AUTHORITY_URL=previous;});
  it('separates two persisted runs and reads the same canonical receipt through MCP, CLI and console',async()=>{
    expect(first.outcomes).toMatchObject({purchase:'COMPLETED',retry:'IDENTICAL_RECEIPT',BUDGET_EXCEEDED:'observed',SELLER_POLICY_DENIED:'observed',GRANT_REVOKED:'observed'});
    expect(second.outcomes.purchase).toBe('BLOCKED_EXISTING_BUDGET');expect(second.run_id).not.toBe(first.run_id);
    const list=await inspectRuns(['--url',mcpUrl],{AGENT_API_KEY:keys['owner-1']});expect((list as any).data.runs.map((r:any)=>r.run_id)).toEqual([second.run_id,first.run_id]);
    const cli:any=await inspectRuns(['--url',mcpUrl,'--run',first.run_id],{AGENT_API_KEY:keys['owner-1']});
    expect(cli.data.activity.every((e:any)=>e.trace_id===first.run_id)).toBe(true);expect(cli.data.receipts).toHaveLength(1);expect(cli.data.receipts[0]).toMatchObject({amount_cents:85000,simulated:true});
    const secondRead=await read('/v1/runs/'+second.run_id);expect(secondRead.data.receipts).toEqual([]);expect(secondRead.data.grants.filter((g:any)=>g.parent_grant_id).every((g:any)=>!cli.data.grants.some((a:any)=>a.id===g.id))).toBe(true);
    expect(cli.data.budgets.find((b:any)=>b.grant_id==='grant-root-buyer').remaining_budget_cents).toBe(15000);
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM purchases').get() as {n:number}).n)).toBe(1);
    const handle=createConsoleHandler({authorityUrl:base,mcpUrl,origin});
    const login=await handle(new Request(origin+'/console-api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({credential:keys['owner-1']})}));const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const ui=await (await handle(new Request(origin+'/console-api/runs/'+first.run_id,{headers:{cookie}}))).json();
    expect(ui.data.receipts).toEqual(cli.data.receipts);expect(ui.data.activity).toEqual(cli.data.activity);expect(ui.data.visibility.descendants_complete).toBe(false);
    expect(JSON.stringify(ui)).not.toMatch(/console-fixture-|key_hash|internal_unit_cost/);
  });
  it('does not turn a known or spoofed run ID into permission to see other callers or organizations',async()=>{
    const owner=await read('/v1/runs/'+first.run_id);expect(owner.data.requests).toEqual([]);
    const child=await read('/v1/runs/'+first.run_id,keys['sourcing-agent']);expect(child.data.activity.every((e:any)=>e.principal_id==='sourcing-agent')).toBe(true);expect(child.data.requests).toHaveLength(1);
    const foreign=await read('/v1/runs/'+first.run_id,keys['supplier-agent']);const missing=await read('/v1/runs/run-missing',keys['supplier-agent']);expect(foreign).toEqual(missing);expect(foreign.http).toBe(404);
    const client=new Client({name:'unrelated-run-reader',version:'1.0.0'});try{
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl),{requestInit:{headers:{authorization:'Bearer '+keys['supplier-agent'],'x-agentpass-run-id':first.run_id}}}));
      const result=await client.callTool({name:'get_run',arguments:{run_id:first.run_id}});expect(result.structuredContent).toMatchObject({status:'DENIED',code:'INVALID_REQUEST'});
      expect((await client.callTool({name:'get_run',arguments:{run_id:first.run_id,principal_id:'owner-1'}})).isError).toBe(true);
    }finally{await client.close();}
    db.prepare('INSERT INTO principals(id,organization_id,kind,role) VALUES(?,?,?,?)').run('unrelated','buyer-co','AGENT','SOURCING');db.prepare('INSERT INTO principal_keys VALUES(?,?,?,NULL)').run('unrelated','unrelated',createHash('sha256').update('unrelated-key').digest('hex'));
    expect((await read('/v1/runs/'+first.run_id,'unrelated-key')).http).toBe(404);
    const invalid=await fetch(base+'/v1/me',{headers:{authorization:'Bearer '+keys['buyer-agent'],'x-agentpass-run-id':'not-a-run'}});expect(invalid.status).toBe(400);
  });
});

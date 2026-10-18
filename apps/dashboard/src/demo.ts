import { createServer, type Server, type RequestListener } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { HttpSupplierService } from '../../authority/src/supplier.js';
import { createSupplierApp } from '../../supplier/src/app.js';
import { createSupplierService } from '../../supplier/src/service.js';
import { sqliteStore } from '../../supplier/src/store.js';

// Public fixture credentials apply only to this fresh, loopback-only simulated environment.
const keys={'owner-1':'console-fixture-owner','buyer-agent':'console-fixture-buyer','sourcing-agent':'console-fixture-sourcing','supplier-agent':'console-fixture-supplier'};
const directory=process.env.CONSOLE_DEMO_DIR??mkdtempSync(join(tmpdir(),'agentpass-console-'));
mkdirSync(directory,{recursive:true,mode:0o700});
const db=openDatabase(join(directory,'authority.sqlite'));seedDatabase(db,keys);
const store=sqliteStore(join(directory,'supplier.sqlite'));
const servers:Server[]=[];
async function listen(app?:RequestListener,port=0){const s=createServer(app);servers.push(s);s.listen(port,'127.0.0.1');await new Promise<void>((resolve,reject)=>{s.once('listening',resolve);s.once('error',reject);});return {server:s,url:`http://127.0.0.1:${(s.address() as any).port}`};}
const supplier=await listen(createSupplierApp({service:createSupplierService({store}),serviceKey:'console-fixture-service'}));
const authority=await listen(createAuthorityApp({db,supplier:new HttpSupplierService(supplier.url,'console-fixture-service')}));
async function call(path:string,body:unknown,token:string){const response=await fetch(authority.url+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});return response.json();}
const scope={actions:['supplier.quote.request'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:0,total_budget_cents:0,expires_at:new Date(Date.now()+3600000).toISOString(),max_delegation_depth:0};
const child=await call('/v1/grants/grant-root-buyer/delegate',{recipient_principal_id:'sourcing-agent',scope},keys['buyer-agent']);assert.equal(child.status,'OK');
const quote=await call('/v1/actions/execute',{grant_id:child.data.id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,idempotency_key:'console-startup-quote'},keys['sourcing-agent']);assert.equal(quote.data.total_cents,85000);
const missing=await call('/v1/actions/execute',{grant_id:child.data.id,action:'supplier.purchase.execute',supplier_id:'supplier-co',sku_id:'PACK-500',quote_id:quote.data.quote_id,idempotency_key:'console-startup-denial'},keys['sourcing-agent']);assert.equal(missing.status,'AUTHORITY_REQUIRED');
const mcp=await listen(undefined,Number(process.env.CONSOLE_PORT??3110));
process.env.AUTHORITY_URL=authority.url;delete process.env.DATABASE_URL;
process.env.CONSOLE_ORIGIN=mcp.url;process.env.MCP_PUBLIC_URL=mcp.url+'/mcp';
const {default:adapter}=await import(pathToFileURL(join(process.cwd(),'apps/mcp/agentpass-manufact/.mcp-use/build/index.js')).href);
const {toNodeHandler}=await import('../../mcp/agentpass-manufact/node_modules/mcp-use/dist/node-bridge.js');
mcp.server.on('request',toNodeHandler(adapter,{onerror:()=>console.error('Local MCP request failed.')}));
console.log(JSON.stringify({console:mcp.url+'/connect',authority:authority.url,database:directory,fixture:true,simulated:true}));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{for(const server of servers)server.close();db.close();void store.close().then(()=>process.exit(0));});

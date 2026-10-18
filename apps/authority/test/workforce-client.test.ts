import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createProtectedWorkforceClient, createWorkforceClient, workforceFromEnvironment } from '../src/workforce-client.js';
import { openWorkforceFile } from '../src/workforce-paths.js';
import { createWorkforceFixture, listenWorkforceApp, workforceKeys, workforceRootId, workforceScope } from './fixtures/workforce.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Developer B workforce adapter',()=>{
  const close:Array<()=>Promise<void>>=[];
  afterEach(async()=>{for (const cleanup of close.reverse()) await cleanup();close.length=0;});

  it('binds an authenticated HTTP action to B’s service gateway and deduplicates the side effect',async()=>{
    const gateway=express();gateway.use(express.json());
    const executions=new Set<string>();
    gateway.post('/internal/workforce/execute',(req,res)=>{
      if (req.headers['x-service-key']!=='fixture-private-service') {res.sendStatus(401);return;}
      expect(req.body.principal.id).toBe('sourcing-agent');
      expect(req.body.input.action).toBe('deploy.preview');
      expect(req.body.input.parameters.environment).toBe('preview');
      executions.add(req.body.execution_id);
      res.json({status:'OK',data:{simulated:true,environment:'preview',artifact_digest:req.body.input.parameters.artifact_digest}});
    });
    const remote=await listenWorkforceApp(gateway);close.push(remote.close);
    const fixture=await createWorkforceFixture({execute:createProtectedWorkforceClient({gatewayUrl:remote.baseUrl,serviceKey:'fixture-private-service'})});close.push(()=>fixture.close());
    const api=await listenWorkforceApp(fixture.app);close.push(api.close);
    const parent=createWorkforceClient({authorityUrl:api.baseUrl,credential:workforceKeys['buyer-agent']});
    const child=createWorkforceClient({authorityUrl:api.baseUrl,credential:workforceKeys['sourcing-agent']});
    const grant=(await parent.delegate(workforceRootId,'sourcing-agent',workforceScope({actions:['deploy.preview'],paths:[],max_executions:2}))).data;
    const input={grant_id:grant.id,resource:'demo-project',action:'deploy.preview' as const,parameters:{environment:'preview' as const,artifact_digest:'a'.repeat(64)},idempotency_key:'b-remote-deploy'};
    expect(await child.verify(input)).toMatchObject({status:'ALLOW'});expect(executions.size).toBe(0);
    const result=await child.execute(input);expect(result).toMatchObject({status:'ALLOW',result:{simulated:true,environment:'preview'}});
    expect(await child.execute(input)).toEqual(result);expect(executions.size).toBe(1);
    expect(await child.execute({...input,parameters:{...input.parameters,artifact_digest:'b'.repeat(64)}})).toMatchObject({status:'DENY',code:'ALREADY_EXECUTED'});
    await parent.revoke(grant.id,'adapter test complete');
    expect(await child.execute(input)).toMatchObject({status:'DENY',code:'GRANT_REVOKED'});
    expect(JSON.stringify(result)).not.toContain('fixture-private-service');
    const invalid=createWorkforceClient({authorityUrl:api.baseUrl,credential:'invalid'});
    expect(await invalid.verify(input)).toMatchObject({status:'DENY',code:'INVALID_CALLER'});
  });

  it('opens only safe filesystem handles and truncates approved writes',async()=>{
    const fixture=await createWorkforceFixture();close.push(()=>fixture.close());
    const file=await openWorkforceFile(fixture.repoRoot,'src/app.ts',true);
    try {await file.writeFile('ok');} finally {await file.close();}
    expect(await readFile(join(fixture.repoRoot,'src/app.ts'),'utf8')).toBe('ok');
    await expect(openWorkforceFile(fixture.repoRoot,'src/linked.ts',true)).rejects.toThrow();
    await expect(openWorkforceFile(fixture.repoRoot,'../escape')).rejects.toThrow();
    await expect(openWorkforceFile(fixture.repoRoot,'.env')).rejects.toThrow();
    await writeFile(join(fixture.repoRoot,'src/credentials.json'),'fixture secret');
    await expect(openWorkforceFile(fixture.repoRoot,'src/credentials.json')).rejects.toThrow();
    const fresh=await openWorkforceFile(fixture.repoRoot,'src/new.ts',true);
    try {await fresh.writeFile('new');} finally {await fresh.close();}
    expect(await readFile(join(fixture.repoRoot,'src/new.ts'),'utf8')).toBe('new');
  });

  it('keeps optional server configuration explicit and rejects untrusted upstream destinations',()=>{
    expect(workforceFromEnvironment({})).toBeUndefined();
    expect(()=>workforceFromEnvironment({WORKFORCE_GATEWAY_URL:'https://example.test'})).toThrow('incomplete');
    expect(()=>createProtectedWorkforceClient({gatewayUrl:'http://example.test',serviceKey:'fixture'})).toThrow();
    expect(()=>createWorkforceClient({authorityUrl:'https://user:password@example.test',credential:'fixture'})).toThrow();
    const resources=[{resource:'demo-project',organization_id:'buyer-co',owner_principal_id:'owner-1',allowed_actions:['deploy.preview']}];
    const config=workforceFromEnvironment({WORKFORCE_RESOURCES_JSON:JSON.stringify(resources),WORKFORCE_GATEWAY_URL:'https://gateway.example.test',WORKFORCE_SERVICE_KEY:'fixture'});
    expect(config?.resources[0]).toMatchObject(resources[0]);
    expect(typeof config?.resources[0].execute).toBe('function');
    expect(()=>workforceFromEnvironment({WORKFORCE_RESOURCES_JSON:JSON.stringify([{...resources[0],execute:'https://attacker.test'}]),WORKFORCE_GATEWAY_URL:'https://gateway.example.test',WORKFORCE_SERVICE_KEY:'fixture'})).toThrow();
  });
});

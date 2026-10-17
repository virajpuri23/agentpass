import { describe,expect,it } from 'vitest';
import { onboardAgent,runOnboarding } from '../src/onboard.js';

describe('agent onboarding CLI input boundary',()=>{
  it('provides machine-readable usage without credentials or a browser',async()=>{
    const help=await runOnboarding(['--help'],{});expect(help).toMatchObject({status:'OK',code:'HELP'});expect(help.reason).toContain('read-only');
  });
  it('rejects absent/invalid credentials and credential arguments without echoing them',async()=>{
    expect(await onboardAgent('https://example.invalid/mcp',undefined)).toMatchObject({code:'MISSING_CREDENTIAL'});
    expect(await onboardAgent('https://example.invalid/mcp','bad key')).toMatchObject({code:'INVALID_CREDENTIAL'});
    const secret='never-print-this';const result=await runOnboarding(['--credential',secret],{});expect(result.code).toBe('INVALID_ARGUMENTS');expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('rejects insecure endpoints and embedded secrets before connecting',async()=>{
    for(const endpoint of ['http://remote.invalid/mcp','https://user:secret@example.invalid/mcp','https://example.invalid/mcp?key=secret']){
      const result=await onboardAgent(endpoint,'test-key');expect(result.code).toBe('INVALID_ENDPOINT');expect(JSON.stringify(result)).not.toContain('secret');
    }
  });
  it('fails closed when the MCP endpoint is unavailable',async()=>{
    expect(await onboardAgent('http://127.0.0.1:1/mcp','test-key')).toMatchObject({status:'ERROR',code:'SERVICE_UNAVAILABLE'});
  });
});

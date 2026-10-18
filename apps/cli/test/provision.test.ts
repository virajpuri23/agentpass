import { mkdtempSync,readFileSync,statSync,chmodSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,it,expect } from 'vitest';
import { prepareChildCredential,readChildCredential,childCredentialHash } from '../src/child-credential.js';
import { runProvisioning } from '../src/provision.js';
import { runOnboarding } from '../src/onboard.js';
let dirs:string[]=[];afterEach(()=>{for(const path of dirs)rmSync(path,{recursive:true,force:true});dirs=[];});
function directory(){const dir=mkdtempSync(join(tmpdir(),'agentpass-child-test-'));dirs.push(dir);return dir;}
const input={endpoint:'https://example.invalid/mcp',parent_grant_id:'parent-grant',scope:{actions:['supplier.quote.request' as const],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:0,total_budget_cents:0,expires_at:'2099-01-01T00:00:00Z',max_delegation_depth:0}};
describe('child runtime credential boundary',()=>{
  it('generates a private distinct secret once, persists before provisioning, and reuses it for retries',()=>{
    const path=join(directory(),'child.json');const a=prepareChildCredential(path,input);const b=prepareChildCredential(path,input);expect(a).toEqual(b);expect(statSync(path).mode&0o777).toBe(0o600);expect(a.credential).toHaveLength(43);expect(childCredentialHash(a)).toHaveLength(64);expect(childCredentialHash(a)).not.toBe(a.credential);expect(readFileSync(path,'utf8')).toContain(a.credential);
    expect(()=>prepareChildCredential(path,{...input,parent_grant_id:'other'})).toThrow();expect(readChildCredential(path)).toEqual(a);
  });
  it('refuses public files, symlinks and repository destinations',()=>{
    const dir=directory(),path=join(dir,'child.json');prepareChildCredential(path,input);const link=join(dir,'link.json');symlinkSync(path,link);expect(()=>readChildCredential(link)).toThrow();chmodSync(path,0o644);expect(()=>readChildCredential(path)).toThrow();expect(()=>prepareChildCredential(join(process.cwd(),'child-secret.json'),input)).toThrow();
    const repositoryLink=join(dir,'checkout');symlinkSync(process.cwd(),repositoryLink);expect(()=>prepareChildCredential(join(repositoryLink,'child-secret.json'),input)).toThrow();
  });
  it('never sends a saved child credential to a substituted endpoint or falls back on an invalid file',async()=>{
    const path=join(directory(),'child.json'),state=prepareChildCredential(path,input);
    const result=await runOnboarding(['--credential-file',path,'--url','https://other.invalid/mcp'],{AGENT_API_KEY:'parent-key'});expect(result.code).toBe('INVALID_ENDPOINT');expect(JSON.stringify(result)).not.toContain(state.credential);
    expect(await runOnboarding(['--credential-file',path+'missing'],{AGENT_API_KEY:'parent-key'})).toMatchObject({code:'INVALID_CREDENTIAL_FILE'});
  });
  it('offers machine-readable help and refuses credential arguments',async()=>{
    expect(await runProvisioning(['--help'],{})).toMatchObject({status:'OK',code:'HELP'});expect(await runProvisioning([],{})).toMatchObject({code:'MISSING_CREDENTIAL'});
    const result=await runProvisioning(['--credential','do-not-print'],{});expect(result.code).toBe('INVALID_ARGUMENTS');expect(JSON.stringify(result)).not.toContain('do-not-print');
  });
});

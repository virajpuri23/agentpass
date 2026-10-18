import { constants,openSync,closeSync,readFileSync,writeFileSync,fstatSync,fsyncSync,realpathSync } from 'node:fs';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { basename,dirname,resolve,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { scopeSchema } from '../../mcp/agentpass-manufact/src/authority-client.js';

const stateSchema=z.object({version:z.literal(1),endpoint:z.string().url(),parent_grant_id:z.string().min(1),scope:scopeSchema,idempotency_key:z.string().uuid(),credential:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
export type ChildCredential=z.infer<typeof stateSchema>;
const repository=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'../../..'));
function privateFile(path:string,flags:number) {
  const target=resolve(realpathSync(dirname(resolve(path))),basename(path));
  if(target===repository||target.startsWith(repository+sep))throw new Error('Keep child credentials outside the repository.');
  const fd=openSync(target,flags|constants.O_NOFOLLOW,0o600);
  const info=fstatSync(fd);
  if(!info.isFile()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid())){closeSync(fd);throw new Error('Credential file must be a private regular file owned by this runtime.');}
  return fd;
}
export function readChildCredential(path:string):ChildCredential {
  const fd=privateFile(path,constants.O_RDONLY);
  try {if(fstatSync(fd).size>32768)throw new Error('Credential file too large.');return stateSchema.parse(JSON.parse(readFileSync(fd,'utf8')));}
  finally {closeSync(fd);}
}
export function prepareChildCredential(path:string,input:Pick<ChildCredential,'endpoint'|'parent_grant_id'|'scope'>):ChildCredential {
  const state=stateSchema.parse({version:1,...input,idempotency_key:randomUUID(),credential:randomBytes(32).toString('base64url')});
  let fd:number;
  try {fd=privateFile(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL);}
  catch(error){
    if(!(error instanceof Error)||!('code' in error)||error.code!=='EEXIST')throw error;
    const previous=readChildCredential(path);
    if(JSON.stringify([previous.endpoint,previous.parent_grant_id,previous.scope])!==JSON.stringify([state.endpoint,state.parent_grant_id,state.scope]))throw new Error('Credential file belongs to another provisioning request.');
    return previous;
  }
  try {writeFileSync(fd,JSON.stringify(state)+'\n');fsyncSync(fd);} finally {closeSync(fd);}
  return state;
}
export const childCredentialHash=(state:ChildCredential)=>createHash('sha256').update(state.credential).digest('hex');

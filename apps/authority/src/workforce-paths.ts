import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function validScopePath(path:string):boolean {
  const plain = path.endsWith('/') ? path.slice(0,-1) : path;
  return plain.length > 0 && !/[\\%\x00-\x1f:]/.test(plain) && plain.split('/').every(part =>
    part.length > 0 && !part.startsWith('.') && !/^(secrets?|credentials?)(\.|$)/i.test(part) && !/^(id_rsa|id_ed25519)$/i.test(part));
}
export function pathWithin(path:string,allowed:string):boolean {
  return path === allowed || (allowed.endsWith('/') && path.startsWith(allowed));
}

/** Reject symlinks in every component, including writes to a not-yet-existing leaf. */
export async function resolveWorkforcePath(root:string,path:string,write=false):Promise<string> {
  if (!validScopePath(path) || path.endsWith('/')) throw new Error('Invalid repository path');
  const base = resolve(root);
  if (await realpath(base) !== base) throw new Error('Invalid repository root');
  const parts = path.split('/');
  for (let index=0;index<parts.length;index++) {
    const target = join(base,...parts.slice(0,index+1));
    let entry;
    try {entry = await lstat(target);}
    catch(error) {
      if (write && index === parts.length-1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return target;
      throw error;
    }
    if (entry.isSymbolicLink() || (index < parts.length-1 ? !entry.isDirectory() : !entry.isFile())) throw new Error('Unsafe repository path');
  }
  return join(base,path);
}

// shortcut: ancestor directories require a trusted sandbox; use directory-handle isolation before allowing hostile local filesystem writers.
export async function openWorkforceFile(root:string,path:string,write=false) {
  const target = await resolveWorkforcePath(root,path,write);
  return open(target,(write ? constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC : constants.O_RDONLY)|constants.O_NOFOLLOW,0o600);
}

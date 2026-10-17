import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';

it('seed CLI uses the configured database, protects generated keys, and preserves reruns',() => {
  const directory=mkdtempSync(join(tmpdir(),'agentpass-seed-cli-'));
  const envPath=join(directory,'.env'); const dbPath=join(directory,'configured.sqlite');
  try {
    writeFileSync(envPath,`AUTHORITY_DB_PATH=${dbPath}\n`,{mode:0o644});
    const args=['--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('db/seed.ts')];
    const env={...process.env};
    for(const key of ['AUTHORITY_DB_PATH','OWNER_API_KEY','BUYER_API_KEY','SOURCING_API_KEY','SUPPLIER_API_KEY']) delete env[key];
    expect(execFileSync(process.execPath,args,{cwd:directory,env,encoding:'utf8'})).toBe('');
    const contents=readFileSync(envPath,'utf8');
    const keys=[...contents.matchAll(/^(?:OWNER|BUYER|SOURCING|SUPPLIER)_API_KEY=(.+)$/gm)].map(m => m[1]);
    expect(keys.length).toBe(4);expect(new Set(keys).size).toBe(4);expect(keys.every(k => k.length>=40)).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const db=openDatabase(dbPath);
    try { expect(db.prepare('SELECT COUNT(*) count FROM principal_keys').get()).toEqual({count:4}); }
    finally { db.close(); }
    execFileSync(process.execPath,args,{cwd:directory,env,encoding:'utf8'});
    expect(readFileSync(envPath,'utf8')===contents).toBe(true);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

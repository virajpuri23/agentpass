import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { workforceScopeSchema } from '../packages/contracts/src/workforce.js';
import { recordAudit } from '../apps/authority/src/audit.js';
import { validScopePath } from '../apps/authority/src/workforce-paths.js';
import type { AuthorityStore } from './store.js';
import { sqliteStore } from './store.js';
import { openDatabase } from './database.js';
import { postgresStore } from './postgres.js';
import { assertMigrationsCurrent } from './migrations.js';

const inputSchema=z.object({grant_id:z.string().min(1).max(200),owner_principal_id:z.string().min(1),subject_principal_id:z.string().min(1),scope:workforceScopeSchema}).strict();

/** Trusted administrator bootstrap only; retries never renew or replenish an existing root. */
export async function seedWorkforceRoot(db:AuthorityStore,value:z.input<typeof inputSchema>,now=new Date()) {
  const input=inputSchema.parse(value);
  return db.transaction(async()=>{
    const owner=await db.prepare('SELECT * FROM principals WHERE id=? AND active=1').get(input.owner_principal_id);
    const subject=await db.prepare('SELECT * FROM principals WHERE id=? AND active=1').get(input.subject_principal_id);
    if (!owner || owner.role!=='OWNER' || !subject || subject.organization_id!==owner.organization_id || Date.parse(input.scope.expires_at)<=now.getTime() || input.scope.resources.some(r=>r.owner_principal_id!==owner.id || r.organization_id!==owner.organization_id || !r.paths.every(validScopePath))) throw new Error('Invalid workforce root authority');
    const previous=await db.prepare('SELECT * FROM grants WHERE id=?').get(input.grant_id);
    if (previous) {
      if (previous.parent_grant_id || previous.issuer_principal_id!==owner.id || previous.subject_principal_id!==subject.id || previous.organization_id!==owner.organization_id || previous.scope_json!==JSON.stringify(input.scope)) throw new Error('Existing root authority differs; refusing to overwrite');
      return {grant_id:previous.id,created:false};
    }
    await db.prepare('INSERT INTO grants(id,organization_id,parent_grant_id,issuer_principal_id,subject_principal_id,scope_json,created_at) VALUES(?,?,NULL,?,?,?,?)').run(input.grant_id,owner.organization_id,owner.id,subject.id,JSON.stringify(input.scope),now.toISOString());
    await recordAudit(db,now.toISOString(),owner,'grant.root.bootstrap','ALLOW',input.grant_id);
    return {grant_id:input.grant_id,created:true};
  }).immediate();
}

async function main() {
  if (!process.env.WORKFORCE_ROOT_JSON) throw new Error('WORKFORCE_ROOT_JSON is required');
  const value=JSON.parse(process.env.WORKFORCE_ROOT_JSON);
  const pg=process.env.DATABASE_URL?postgresStore(process.env.DATABASE_URL):undefined;
  const sqlite=pg?undefined:openDatabase(process.env.AUTHORITY_DB_PATH??'./authority.sqlite');
  try {
    const db=pg?.store??sqliteStore(sqlite!);
    await assertMigrationsCurrent(db,pg?'postgres':'sqlite');
    console.log(JSON.stringify({status:'OK',data:await seedWorkforceRoot(db,value)}));
  } finally {if(pg)await pg.close();else sqlite!.close();}
}
if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{
  console.error(JSON.stringify({status:'ERROR',code:'INVALID_REQUEST',reason:'Workforce root bootstrap failed; existing authority was preserved'}));process.exitCode=1;
});

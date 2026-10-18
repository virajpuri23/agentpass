import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { postgresStore } from '../../../db/postgres.js';
import { migrateStore } from '../../../db/migrations.js';

it.skipIf(!process.env.AGENTPASS_TEST_DATABASE_URL)('binds only approved OAuth clients to the MCP audience and ten-minute lifetime',async()=>{
  const db=postgresStore(process.env.AGENTPASS_TEST_DATABASE_URL!),client=`fixture-${randomUUID()}`,resource='https://agentpass.example/mcp';
  try{
    await db.migrate();await migrateStore(db.store,'postgres');
    await db.store.prepare('INSERT INTO oauth_resource_clients(client_id,resource) VALUES(?,?)').run(client,resource);
    const original={aud:'authenticated',role:'authenticated',is_anonymous:false,iat:1000,exp:4600,client_id:client,user_metadata:{aud:'https://attacker.example/mcp'}};
    const hook=async(claims:unknown)=>(await db.store.prepare('SELECT agentpass.oauth_access_token_hook(?::jsonb) AS result').get(JSON.stringify({claims}))).result.claims;
    expect(await hook(original)).toMatchObject({aud:resource,exp:1600});
    expect(await hook({...original,exp:1300})).toMatchObject({aud:resource,exp:1300});
    expect(await hook({...original,client_id:'unknown'})).toMatchObject({aud:'authenticated',exp:4600});
    expect(await hook({...original,client_id:undefined,user_metadata:{client_id:client}})).toMatchObject({aud:'authenticated'});
    expect(await hook({...original,is_anonymous:true})).toMatchObject({aud:'authenticated'});
    expect(await hook({...original,role:'service_role'})).toMatchObject({aud:'authenticated'});
    await expect(hook(null)).rejects.toThrow();
    const privileges=await db.store.prepare("SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='agentpass.oauth_access_token_hook(jsonb)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute").get();
    expect(privileges.public_execute).toBe(false);
  }finally{await db.store.prepare('DELETE FROM oauth_resource_clients WHERE client_id=?').run(client);await db.close();}
});

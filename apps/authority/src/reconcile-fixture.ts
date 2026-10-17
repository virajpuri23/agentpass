import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import type { Principal } from '../../../packages/contracts/src/index.js';
import { sqliteStore } from '../../../db/store.js';
import { openDatabase } from '../../../db/database.js';
import { id, quoteSchema } from './validation.js';
import { auditContext } from './audit.js';
import { completePurchase } from './purchases.js';

// Fixture-only: the frozen supplier API has no read-only fulfillment-outcome lookup.
async function main() {
  const {values} = parseArgs({options:{'fixture-supplier-db':{type:'string'},'purchase-id':{type:'string'}}});
  const authorityPath = process.env.AUTHORITY_DB_PATH;
  if (process.env.AGENTPASS_FIXTURE_RECONCILIATION !== '1' || !authorityPath || !existsSync(authorityPath) || !process.env.OWNER_API_KEY || !values['fixture-supplier-db']) throw new Error('Explicit fixture configuration required');
  const purchaseId = id.parse(values['purchase-id']);
  const db = openDatabase(authorityPath);
  try {
    const owner = db.prepare(`SELECT p.id,p.organization_id,p.kind,p.role FROM principal_keys k JOIN principals p ON p.id=k.principal_id
      WHERE k.key_hash=? AND k.revoked_at IS NULL AND p.active=1 AND p.role='OWNER' AND p.kind='HUMAN'`).get(createHash('sha256').update(process.env.OWNER_API_KEY).digest('hex')) as Principal | undefined;
    if (!owner) throw new Error('Active owner credentials required');
    const purchase = db.prepare('SELECT p.*,g.organization_id FROM purchases p JOIN grants g ON g.id=p.grant_id WHERE p.id=? AND g.organization_id=?').get(purchaseId,owner.organization_id) as any;
    if (!purchase) throw new Error('Purchase unavailable');
    const seller = new Database(values['fixture-supplier-db'],{readonly:true,fileMustExist:true});
    try {
      seller.pragma('query_only = ON');
      const evidence = seller.prepare(`SELECT o.id AS order_id,o.quote_id,o.buyer_principal_id,o.status,
        q.buyer_principal_id AS quote_buyer,q.supplier_id,q.sku_id,q.quantity,q.total_cents,q.currency,q.expires_at
        FROM orders o JOIN quotes q ON q.id=o.quote_id WHERE o.request_id=?`).get(purchaseId) as any;
      if (!evidence || evidence.status !== 'COMPLETED' || evidence.buyer_principal_id !== purchase.caller_principal_id || evidence.quote_buyer !== purchase.caller_principal_id || evidence.quote_id !== purchase.quote_id) throw new Error('No matching completed fixture order');
      const quote = quoteSchema.parse({...evidence,unit_price_cents:evidence.total_cents/evidence.quantity});
      const receipt = await auditContext.run({traceId:randomUUID(),action:'purchase.reconcile',grantId:purchase.grant_id,requestId:purchaseId},() => completePurchase(sqliteStore(db),purchaseId,quote,evidence.order_id,owner,new Date().toISOString()));
      console.log(JSON.stringify({status:'OK',data:receipt,fixture:true}));
    } finally { seller.close(); }
  } finally { db.close(); }
}
try { await main(); }
catch { console.error(JSON.stringify({status:'ERROR',code:'INVALID_REQUEST',reason:'Fixture reconciliation refused; verify owner, original binding and completed seller evidence',next_action:'contact_owner'}));process.exitCode=1; }

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Principal, PurchaseReceipt, SupplierQuote } from '../../../packages/contracts/src/index.js';
import { id } from './validation.js';
import { auditContext, recordAudit, setAuditContext } from './audit.js';

export const purchaseBindingSchema = z.tuple([id,z.literal('supplier.purchase.execute'),id,id,z.number().int().positive().nullable(),id]);
export function completePurchase(db: Database.Database, purchaseId: string, quote: SupplierQuote, orderId: string, actor: Principal, timestamp: string): PurchaseReceipt {
  return db.transaction(() => {
    const purchase = db.prepare('SELECT p.*,g.organization_id FROM purchases p JOIN grants g ON g.id=p.grant_id WHERE p.id=?').get(purchaseId) as any;
    if (!purchase || purchase.organization_id !== actor.organization_id) throw new Error('Purchase unavailable');
    const [grantId,,supplierId,skuId,quantity,quoteId] = purchaseBindingSchema.parse(JSON.parse(purchase.request_json));
    if (grantId !== purchase.grant_id || quoteId !== purchase.quote_id || quote.quote_id !== quoteId || quote.supplier_id !== supplierId || quote.sku_id !== skuId || quote.total_cents !== purchase.amount_cents || (quantity !== null && quote.quantity !== quantity)) throw new Error('Purchase binding mismatch');
    id.parse(orderId);
    if (purchase.status === 'COMPLETED') {
      if (purchase.supplier_order_id !== orderId) throw new Error('Completed order mismatch');
      return JSON.parse(purchase.receipt_json);
    }
    const ledger = db.prepare('SELECT grant_id,amount_cents,state FROM ledger_entries WHERE purchase_id=?').all(purchaseId) as {grant_id:string;amount_cents:number;state:string}[];
    const chain = db.prepare(`WITH RECURSIVE chain(id,parent_grant_id) AS (
      SELECT id,parent_grant_id FROM grants WHERE id=? UNION
      SELECT g.id,g.parent_grant_id FROM grants g JOIN chain c ON g.id=c.parent_grant_id
    ) SELECT id FROM chain`).all(grantId) as {id:string}[];
    if (purchase.status !== 'PENDING' || !ledger.length || ledger.length !== chain.length || ledger.some(l => l.state !== 'RESERVED' || l.amount_cents !== purchase.amount_cents || !chain.some(g => g.id === l.grant_id))) throw new Error('Reservation is incomplete');
    const receipt: PurchaseReceipt = {receipt_id:randomUUID(),request_id:purchase.id,order_id:orderId,supplier_id:supplierId,sku_id:skuId,quantity:quote.quantity,amount_cents:purchase.amount_cents,currency:'USD',grant_id:grantId,outcome:'COMPLETED',simulated:true};
    db.prepare("UPDATE purchases SET status='COMPLETED',supplier_order_id=?,receipt_json=?,updated_at=? WHERE id=?").run(orderId,JSON.stringify(receipt),timestamp,purchaseId);
    db.prepare("UPDATE ledger_entries SET state='COMMITTED' WHERE purchase_id=? AND state='RESERVED'").run(purchaseId);
    setAuditContext({grantId,requestId:purchaseId});
    recordAudit(db,timestamp,actor,auditContext.getStore()?.action ?? 'supplier.purchase.execute','COMPLETED',grantId,undefined,purchaseId);
    return receipt;
  }).immediate();
}

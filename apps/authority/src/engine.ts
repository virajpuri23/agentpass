import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Principal, Grant, AuthorityScope, AuthorityRequest, ExecuteActionInput, ApiError, ErrorCode, PurchaseReceipt } from '../../../packages/contracts/src/index.js';
import type { SupplierService } from './supplier.js';
import { quoteSchema } from './validation.js';

export class Denial extends Error {
  constructor(public result: ApiError, public http = 403) { super(result.reason); }
}
export function deny(code: ErrorCode, reason: string, http = 403): never {
  throw new Denial({ status: 'DENIED', code, reason, next_action: 'contact_owner' }, http);
}
export class AuthorityEngine {
  constructor(public db: Database.Database, public supplier: SupplierService, public now = () => new Date()) {}
  time() { return this.now().toISOString(); }
  principal(id: string): Principal {
    const p = this.db.prepare('SELECT id, organization_id, kind, role FROM principals WHERE id = ? AND active = 1').get(id) as Principal | undefined;
    if (!p) deny('INVALID_CALLER', 'Unknown or inactive principal', 401);
    return p;
  }
  authenticate(token: string): Principal {
    const row = this.db.prepare('SELECT principal_id FROM principal_keys WHERE key_hash = ? AND revoked_at IS NULL').get(createHash('sha256').update(token).digest('hex')) as any;
    if (!row) deny('INVALID_CALLER', 'Valid bearer credentials required', 401);
    return this.principal(row.principal_id);
  }
  grant(id: string): Grant {
    const row = this.db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as any;
    if (!row) deny('INSUFFICIENT_SCOPE', 'Grant unavailable');
    return { id: row.id, organization_id: row.organization_id, parent_grant_id: row.parent_grant_id, issuer_principal_id: row.issuer_principal_id, subject_principal_id: row.subject_principal_id, scope: JSON.parse(row.scope_json), revoked_at: row.revoked_at };
  }
  grants(p: Principal) {
    return (this.db.prepare('SELECT id FROM grants WHERE subject_principal_id = ? AND organization_id = ?').all(p.id, p.organization_id) as any[]).map(g => this.grant(g.id));
  }
  subset(child: AuthorityScope, parent: AuthorityScope, delegation = true) {
    if (!child.actions.every(a => parent.actions.includes(a)) || !child.supplier_ids.every(x => parent.supplier_ids.includes(x)) || !child.sku_ids.every(x => parent.sku_ids.includes(x)) || child.max_per_action_cents > parent.max_per_action_cents || child.total_budget_cents > parent.total_budget_cents || Date.parse(child.expires_at) > Date.parse(parent.expires_at) || child.max_delegation_depth > parent.max_delegation_depth - (delegation ? 1 : 0)) deny('OUTSIDE_PARENT_SCOPE', 'Delegation must narrow every parent scope dimension');
  }
  chain(id: string, p: Principal): Grant[] {
    const chain: Grant[] = [];
    let g = this.grant(id);
    if (g.subject_principal_id !== p.id || g.organization_id !== p.organization_id) deny('INVALID_CALLER', 'Grant does not belong to caller');
    for (;;) {
      if (chain.some(x => x.id === g.id) || chain.length > 20) deny('INSUFFICIENT_SCOPE', 'Invalid authority chain');
      if (g.organization_id !== p.organization_id || this.principal(g.subject_principal_id).organization_id !== p.organization_id || this.principal(g.issuer_principal_id).organization_id !== p.organization_id) deny('INVALID_CALLER', 'Cross-organization authority is prohibited');
      if (g.revoked_at) deny('GRANT_REVOKED', 'Grant or ancestor was revoked');
      if (!Number.isFinite(Date.parse(g.scope.expires_at)) || Date.parse(g.scope.expires_at) <= this.now().getTime()) deny('GRANT_EXPIRED', 'Grant or ancestor expired');
      chain.push(g);
      if (!g.parent_grant_id) break;
      const parent = this.grant(g.parent_grant_id);
      if (parent.subject_principal_id !== g.issuer_principal_id) deny('INVALID_CALLER', 'Invalid delegation issuer');
      this.subset(g.scope, parent.scope);
      g = parent;
    }
    return chain;
  }
  audit(p: Principal, action: string, decision: string, grantId?: string, code?: ErrorCode, requestId?: string) {
    this.db.prepare('INSERT INTO audit_events(event_id,timestamp,principal_id,grant_id,action,decision,reason_code,request_id,trace_id) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), this.time(), p.id, grantId ?? null, action, decision, code ?? null, requestId ?? null, randomUUID());
  }
  issue(p: Principal, parentId: string, recipient: string, scope: AuthorityScope): Grant {
    const parent = this.chain(parentId, p)[0];
    this.subset(scope, parent.scope);
    if (Date.parse(scope.expires_at) <= this.now().getTime()) deny('GRANT_EXPIRED', 'New grant is already expired');
    if (this.principal(recipient).organization_id !== p.organization_id) deny('OUTSIDE_PARENT_SCOPE', 'Recipient must belong to issuer organization');
    const g: Grant = { id: randomUUID(), organization_id: p.organization_id, issuer_principal_id: p.id, subject_principal_id: recipient, parent_grant_id: parentId, scope, revoked_at: null };
    this.db.prepare('INSERT INTO grants(id,organization_id,parent_grant_id,issuer_principal_id,subject_principal_id,scope_json,created_at) VALUES(?,?,?,?,?,?,?)').run(g.id, g.organization_id, parentId, p.id, recipient, JSON.stringify(scope), this.time());
    this.audit(p, 'grant.issue', 'ALLOW', g.id);
    return g;
  }
  delegate(p: Principal, parent: string, recipient: string, scope: AuthorityScope) { return this.db.transaction(() => this.issue(p, parent, recipient, scope)).immediate(); }
  request(p: Principal, parentId: string, scope: AuthorityScope, reason: string) {
    const parent = this.grant(parentId);
    const parentPrincipal = this.principal(parent.subject_principal_id);
    this.chain(parentId, parentPrincipal);
    if (p.organization_id !== parent.organization_id || p.id === parent.subject_principal_id || !this.grants(p).some(g => g.parent_grant_id === parentId && (() => { try { this.chain(g.id, p); return true; } catch { return false; } })())) deny('INVALID_CALLER', 'Only an existing delegated child may request authority');
    const requestId = randomUUID();
    this.db.prepare('INSERT INTO authority_requests(id,requester_principal_id,parent_grant_id,requested_scope_json,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(requestId,p.id,parentId,JSON.stringify(scope),reason,'PENDING',this.time(),this.time());
    this.audit(p,'authority.request','PENDING',parentId,undefined,requestId);
    return { request_id: requestId, status: 'PENDING' };
  }
  getRequest(p: Principal, id: string): AuthorityRequest {
    const row = this.db.prepare('SELECT * FROM authority_requests WHERE id = ?').get(id) as any;
    if (!row) deny('INVALID_REQUEST', 'Request unavailable', 404);
    const parent = this.grant(row.parent_grant_id);
    if (parent.organization_id !== p.organization_id || ![row.requester_principal_id, parent.subject_principal_id].includes(p.id)) deny('INVALID_CALLER', 'Request is private to its parties');
    return { id: row.id, requester_principal_id: row.requester_principal_id, parent_grant_id: row.parent_grant_id, requested_scope: JSON.parse(row.requested_scope_json), offered_scope: row.offered_scope_json ? JSON.parse(row.offered_scope_json) : undefined, reason: row.reason, status: row.status, issued_grant_id: row.issued_grant_id ?? undefined };
  }
  respond(p: Principal, id: string, decision: 'COUNTEROFFER' | 'REJECT', offered?: AuthorityScope) {
    return this.db.transaction(() => {
      const r = this.getRequest(p,id);
      const parent = this.chain(r.parent_grant_id,p)[0];
      if (r.requester_principal_id === p.id) deny('INVALID_CALLER','Requester cannot approve its own request');
      if (r.status !== 'PENDING') deny('INVALID_REQUEST','Request is no longer pending',409);
      if (decision === 'COUNTEROFFER') {
        if (!offered) deny('INVALID_REQUEST','Counteroffer requires scope',400);
        this.subset(offered,parent.scope);
        // The offer is also bounded by what the child actually requested.
        this.subset(offered, r.requested_scope, false);
        if (offered.max_delegation_depth > r.requested_scope.max_delegation_depth || Date.parse(offered.expires_at) <= this.now().getTime()) deny('OUTSIDE_PARENT_SCOPE','Invalid offer depth or expiration');
      }
      this.db.prepare('UPDATE authority_requests SET status = ?, offered_scope_json = ?, updated_at = ? WHERE id = ?').run(decision === 'REJECT' ? 'REJECTED' : 'COUNTEROFFERED',offered ? JSON.stringify(offered) : null,this.time(),id);
      this.audit(p,'authority.respond',decision,r.parent_grant_id,undefined,id);
      return this.getRequest(p,id);
    }).immediate();
  }
  accept(p: Principal, id: string) {
    return this.db.transaction(() => {
      const r = this.getRequest(p,id);
      if (r.requester_principal_id !== p.id) deny('INVALID_CALLER','Only requester can accept');
      if (r.status === 'ACCEPTED' && r.issued_grant_id) { this.chain(r.issued_grant_id,p); return this.grant(r.issued_grant_id); }
      if (r.status !== 'COUNTEROFFERED' || !r.offered_scope) deny('INVALID_REQUEST','No counteroffer to accept',409);
      const parent = this.grant(r.parent_grant_id);
      const g = this.issue(this.principal(parent.subject_principal_id), parent.id, p.id, r.offered_scope);
      this.db.prepare("UPDATE authority_requests SET status = 'ACCEPTED', issued_grant_id = ?, updated_at = ? WHERE id = ?").run(g.id,this.time(),id);
      this.audit(p,'authority.accept','ALLOW',g.id,undefined,id);
      return g;
    }).immediate();
  }
  revoke(p: Principal, id: string) {
    return this.db.transaction(() => {
      const g = this.grant(id);
      if (g.organization_id !== p.organization_id || (g.issuer_principal_id !== p.id && p.role !== 'OWNER')) deny('INVALID_CALLER','Only issuer or organization owner can revoke');
      this.db.prepare('UPDATE grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(this.time(),id);
      this.audit(p,'grant.revoke','REVOKED',id);
      return { grant_id: id, revoked_at: this.grant(id).revoked_at };
    }).immediate();
  }
  authorize(p: Principal, input: ExecuteActionInput, amount: number): Grant[] {
    const chain = this.chain(input.grant_id,p);
    if (chain.some(g => !g.scope.supplier_ids.includes(input.supplier_id) || !g.scope.sku_ids.includes(input.sku_id))) deny('INSUFFICIENT_SCOPE','Resource outside granted scope');
    if (chain.some(g => !g.scope.actions.includes(input.action))) {
      throw new Denial({ status: 'AUTHORITY_REQUIRED', code: 'INSUFFICIENT_SCOPE', reason: 'Action requires additional authority', next_action: 'request_authority', required_scope: { actions: [input.action], supplier_ids: [input.supplier_id], sku_ids: [input.sku_id], max_per_action_cents: amount, total_budget_cents: amount, expires_at: chain[0].scope.expires_at, max_delegation_depth: 0 } });
    }
    if (chain.some(g => amount > g.scope.max_per_action_cents)) deny('BUDGET_EXCEEDED','Per-action limit exceeded');
    return chain;
  }
  async execute(p: Principal, input: ExecuteActionInput) {
    this.chain(input.grant_id,p);
    if (input.action === 'supplier.margin.read') {
      await this.supplier.policy(p,input.action,{supplier_id:input.supplier_id,sku_id:input.sku_id});
      deny('SELLER_POLICY_DENIED','Supplier private data is unavailable');
    }
    const fingerprint = JSON.stringify([input.grant_id,input.action,input.supplier_id,input.sku_id,input.quantity ?? null,input.quote_id ?? null]);
    const previous = this.db.prepare('SELECT * FROM purchases WHERE caller_principal_id = ? AND idempotency_key = ?').get(p.id,input.idempotency_key) as any;
    if (previous && previous.request_json !== fingerprint) deny('ALREADY_EXECUTED','Idempotency key is bound to another action',409);
    if (previous?.status === 'COMPLETED') return JSON.parse(previous.receipt_json) as PurchaseReceipt;
    const resource = {supplier_id:input.supplier_id,sku_id:input.sku_id};
    if (input.action === 'supplier.quote.request') {
      this.authorize(p,input,0);
      if (!await this.supplier.policy(p,input.action,resource)) deny('SELLER_POLICY_DENIED','Supplier policy denied quote');
      this.authorize(p,input,0);
      const q = quoteSchema.parse(await this.supplier.quote({buyer_principal_id:p.id,...resource,quantity:input.quantity!,request_id:randomUUID()}));
      this.authorize(p,input,0);
      if (q.supplier_id !== input.supplier_id || q.sku_id !== input.sku_id || q.quantity !== input.quantity) deny('INVALID_REQUEST','Supplier quote does not match request');
      this.audit(p,input.action,'ALLOW',input.grant_id);
      return q;
    }
    const quote = quoteSchema.parse(await this.supplier.getQuote(input.quote_id!));
    if (quote.quote_id !== input.quote_id || quote.supplier_id !== input.supplier_id || quote.sku_id !== input.sku_id || (input.quantity !== undefined && input.quantity !== quote.quantity)) deny('INVALID_REQUEST','Quote does not match action');
    if (Date.parse(quote.expires_at) <= this.now().getTime()) deny('QUOTE_EXPIRED','Supplier quote expired');
    this.authorize(p,input,quote.total_cents);
    if (!await this.supplier.policy(p,input.action,resource)) deny('SELLER_POLICY_DENIED','Supplier policy denied purchase');
    const purchase = this.db.transaction(() => {
      const chain = this.authorize(p,input,quote.total_cents);
      if (Date.parse(quote.expires_at) <= this.now().getTime()) deny('QUOTE_EXPIRED','Supplier quote expired before reservation');
      const existing = this.db.prepare('SELECT * FROM purchases WHERE caller_principal_id = ? AND idempotency_key = ?').get(p.id,input.idempotency_key) as any;
      if (existing) {
        if (existing.request_json !== fingerprint || existing.amount_cents !== quote.total_cents) deny('ALREADY_EXECUTED','Purchase binding differs',409);
        return existing;
      }
      for (const g of chain) {
        const used = (this.db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS amount FROM ledger_entries WHERE grant_id = ? AND state IN ('RESERVED','COMMITTED')").get(g.id) as any).amount;
        if (quote.total_cents > g.scope.total_budget_cents - used) deny('BUDGET_EXCEEDED','Shared grant budget exhausted');
      }
      const purchaseId = randomUUID();
      this.db.prepare("INSERT INTO purchases(id,caller_principal_id,grant_id,quote_id,idempotency_key,amount_cents,status,created_at,updated_at,request_json) VALUES(?,?,?,?,?,?,'PENDING',?,?,?)").run(purchaseId,p.id,input.grant_id,quote.quote_id,input.idempotency_key,quote.total_cents,this.time(),this.time(),fingerprint);
      for (const g of chain) this.db.prepare("INSERT INTO ledger_entries(id,purchase_id,grant_id,amount_cents,state,created_at) VALUES(?,?,?,?,'RESERVED',?)").run(randomUUID(),purchaseId,g.id,quote.total_cents,this.time());
      this.audit(p,input.action,'RESERVED',input.grant_id,undefined,purchaseId);
      return {id:purchaseId,status:'PENDING'};
    }).immediate();
    if (purchase.status === 'COMPLETED') return JSON.parse(purchase.receipt_json) as PurchaseReceipt;
    // Uncertain supplier outcomes retain reservations; retry reconciles the same request ID.
    const order = await this.supplier.fulfill({quote_id:quote.quote_id,buyer_principal_id:p.id,request_id:purchase.id});
    if (!order.order_id || typeof order.order_id !== 'string') throw new Error('Invalid supplier fulfillment');
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT receipt_json FROM purchases WHERE id = ?').get(purchase.id) as any;
      if (existing.receipt_json) return JSON.parse(existing.receipt_json) as PurchaseReceipt;
      const receipt: PurchaseReceipt = {receipt_id:randomUUID(),request_id:purchase.id,order_id:order.order_id,...resource,quantity:quote.quantity,amount_cents:quote.total_cents,currency:'USD',grant_id:input.grant_id,outcome:'COMPLETED',simulated:true};
      this.db.prepare("UPDATE purchases SET status = 'COMPLETED',supplier_order_id = ?,receipt_json = ?,updated_at = ? WHERE id = ?").run(order.order_id,JSON.stringify(receipt),this.time(),purchase.id);
      this.db.prepare("UPDATE ledger_entries SET state = 'COMMITTED' WHERE purchase_id = ? AND state = 'RESERVED'").run(purchase.id);
      this.audit(p,input.action,'COMPLETED',input.grant_id,undefined,purchase.id);
      return receipt;
    }).immediate();
  }
}

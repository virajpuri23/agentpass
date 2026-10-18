import { createHash, randomUUID } from 'node:crypto';
import type { AuthorityStore } from '../../../db/store.js';
import type { Principal, Grant, AuthorityScope, AuthorityRequest, ExecuteActionInput, ApiError, ErrorCode, PurchaseReceipt } from '../../../packages/contracts/src/index.js';
import type { SupplierService } from './supplier.js';
import { quoteSchema } from './validation.js';
import { recordAudit, setAuditContext } from './audit.js';
import { completePurchase } from './purchases.js';
import { workforceScopeSchema } from '../../../packages/contracts/src/workforce.js';
import { validScopePath, pathWithin } from './workforce-paths.js';

export class Denial extends Error {
  constructor(public result: ApiError, public http = 403) { super(result.reason); }
}
export function deny(code: ErrorCode, reason: string, http = 403): never {
  throw new Denial({ status: 'DENIED', code, reason, next_action: 'contact_owner' }, http);
}
export class AuthorityEngine {
  constructor(public db: AuthorityStore, public supplier: SupplierService, public now = () => new Date(),private validatePrincipal?:(principal:Principal,requireAuthority:boolean)=>Promise<void>) {}
  time() { return this.now().toISOString(); }
  async principal(id: string,requireAuthority=false): Promise<Principal> {
    const p = await this.db.prepare('SELECT id, organization_id, kind, role FROM principals WHERE id = ? AND active = 1').get(id) as Principal | undefined;
    if (!p) deny('INVALID_CALLER', 'Unknown or inactive principal', 401);
    await this.validatePrincipal?.(p,requireAuthority);
    return p;
  }
  async authenticate(token: string): Promise<Principal> {
    const row = await this.db.prepare('SELECT principal_id,key_id FROM principal_keys WHERE key_hash = ? AND revoked_at IS NULL').get(createHash('sha256').update(token).digest('hex')) as any;
    if (!row) deny('INVALID_CALLER', 'Valid bearer credentials required', 401);
    const principal = await this.principal(row.principal_id);
    const binding = await this.db.prepare('SELECT child_grant_id FROM child_provisionings WHERE credential_key_id=?').get(row.key_id);
    if (binding) {
      try { await this.chain(binding.child_grant_id,principal); }
      catch (error) { if (!(error instanceof Denial)) throw error;deny('INVALID_CALLER','Child credential authority is no longer live',401); }
    }
    return principal;
  }
  async grant(id: string): Promise<Grant> {
    const row = await this.db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as any;
    if (!row) deny('INSUFFICIENT_SCOPE', 'Grant unavailable');
    return { id: row.id, organization_id: row.organization_id, parent_grant_id: row.parent_grant_id, issuer_principal_id: row.issuer_principal_id, subject_principal_id: row.subject_principal_id, scope: JSON.parse(row.scope_json), revoked_at: row.revoked_at };
  }
  async grants(p: Principal) {
    const rows = await this.db.prepare('SELECT id FROM grants WHERE subject_principal_id = ?').all(p.id);
    return (await Promise.all(rows.map(g => this.grant(g.id)))).filter(g => g.organization_id === p.organization_id || g.scope.resources);
  }
  async inspect(p: Principal) {
    const budgets = await Promise.all((await this.grants(p)).map(g => this.grantBudget(g)));
    const latest_result = await this.db.prepare("SELECT timestamp,action,decision,reason_code,grant_id FROM audit_events WHERE principal_id=? AND action LIKE 'supplier.%' ORDER BY rowid DESC LIMIT 1").get(p.id) ?? null;
    return {budgets,latest_result};
  }
  async grantBudget(g: Grant) {
    try {
      const subject = await this.principal(g.subject_principal_id);
      const remaining: number[] = [];
      for (const ancestor of await this.chain(g.id,subject)) {
        const {amount} = await this.db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS amount FROM ledger_entries WHERE grant_id=? AND state IN ('RESERVED','COMMITTED')").get(ancestor.id) as {amount:number};
        remaining.push(Math.max(0,ancestor.scope.total_budget_cents-amount));
      }
      return {grant_id:g.id,remaining_budget_cents:Math.min(...remaining),authority_code:'ACTIVE'};
    } catch (error) {
      if (!(error instanceof Denial)) throw error;
      return {grant_id:g.id,remaining_budget_cents:null,authority_code:error.result.code};
    }
  }
  subset(child: AuthorityScope, parent: AuthorityScope, delegation = true) {
    if (Boolean(child.resources) !== Boolean(parent.resources)) deny('OUTSIDE_PARENT_SCOPE','Scope families must match');
    if (child.resources) {
      if (!workforceScopeSchema.safeParse(child).success || !workforceScopeSchema.safeParse(parent).success || child.max_executions! > parent.max_executions!) deny('OUTSIDE_PARENT_SCOPE','Invalid workforce limits');
      for (const resource of child.resources) {
        const source = parent.resources!.find(r => r.resource === resource.resource && r.organization_id === resource.organization_id && r.owner_principal_id === resource.owner_principal_id);
        if (!source || !resource.paths.every(path => validScopePath(path) && source.paths.some(allowed => validScopePath(allowed) && pathWithin(path,allowed)))) deny('OUTSIDE_PARENT_SCOPE','Resource scope must narrow parent authority');
      }
    }
    if (!child.actions.every(a => parent.actions.includes(a)) || !child.supplier_ids.every(x => parent.supplier_ids.includes(x)) || !child.sku_ids.every(x => parent.sku_ids.includes(x)) || child.max_per_action_cents > parent.max_per_action_cents || child.total_budget_cents > parent.total_budget_cents || Date.parse(child.expires_at) > Date.parse(parent.expires_at) || child.max_delegation_depth > parent.max_delegation_depth - (delegation ? 1 : 0)) deny('OUTSIDE_PARENT_SCOPE', 'Delegation must narrow every parent scope dimension');
  }
  async chain(id: string, p: Principal): Promise<Grant[]> {
    const chain: Grant[] = [];
    let g = await this.grant(id);
    if (g.subject_principal_id !== p.id || (!g.scope.resources && g.organization_id !== p.organization_id)) deny('INVALID_CALLER', 'Grant does not belong to caller');
    for (;;) {
      if (chain.some(x => x.id === g.id) || chain.length > 20) deny('INSUFFICIENT_SCOPE', 'Invalid authority chain');
      const subject = await this.principal(g.subject_principal_id,true);
      const issuer = await this.principal(g.issuer_principal_id,true);
      if (g.scope.resources) {
        if (!workforceScopeSchema.safeParse(g.scope).success || g.scope.resources.some(r => r.organization_id !== g.organization_id || !r.paths.every(validScopePath))) deny('OUTSIDE_PARENT_SCOPE','Invalid workforce scope');
        if (!g.parent_grant_id && (issuer.role !== 'OWNER' || issuer.organization_id !== g.organization_id || g.scope.resources.some(r => r.owner_principal_id !== issuer.id))) deny('INVALID_CALLER','Invalid resource owner authority');
      } else if (g.organization_id !== p.organization_id || subject.organization_id !== p.organization_id || issuer.organization_id !== p.organization_id) deny('INVALID_CALLER', 'Cross-organization authority is prohibited');
      if (g.revoked_at) deny('GRANT_REVOKED', 'Grant or ancestor was revoked');
      if (!Number.isFinite(Date.parse(g.scope.expires_at)) || Date.parse(g.scope.expires_at) <= this.now().getTime()) deny('GRANT_EXPIRED', 'Grant or ancestor expired');
      chain.push(g);
      if (!g.parent_grant_id) break;
      const parent = await this.grant(g.parent_grant_id);
      if (parent.subject_principal_id !== g.issuer_principal_id || parent.organization_id !== g.organization_id) deny('INVALID_CALLER', 'Invalid delegation issuer');
      this.subset(g.scope, parent.scope);
      g = parent;
    }
    return chain;
  }
  async audit(p: Principal, action: string, decision: string, grantId?: string, code?: ErrorCode, requestId?: string) {
    await recordAudit(this.db,this.time(),p,action,decision,grantId,code,requestId);
  }
  async issue(p: Principal, parentId: string, recipient: string, scope: AuthorityScope): Promise<Grant> {
    const chain = await this.chain(parentId,p);
    const parent = chain[0];
    this.subset(scope, parent.scope);
    if (scope.resources) {
      for (const ancestor of chain) {
        const used = await this.db.prepare('SELECT COUNT(*) AS n FROM workforce_usage WHERE grant_id=?').get(ancestor.id);
        if (scope.max_executions! > ancestor.scope.max_executions! - Number(used.n)) deny('BUDGET_EXCEEDED','Child limit exceeds remaining ancestor execution quota');
      }
    }
    if (Date.parse(scope.expires_at) <= this.now().getTime()) deny('GRANT_EXPIRED', 'New grant is already expired');
    if ((await this.principal(recipient)).organization_id !== p.organization_id && !scope.resources) deny('OUTSIDE_PARENT_SCOPE', 'Recipient must belong to issuer organization');
    const g: Grant = { id: randomUUID(), organization_id: parent.organization_id, issuer_principal_id: p.id, subject_principal_id: recipient, parent_grant_id: parentId, scope, revoked_at: null };
    await this.db.prepare('INSERT INTO grants(id,organization_id,parent_grant_id,issuer_principal_id,subject_principal_id,scope_json,created_at) VALUES(?,?,?,?,?,?,?)').run(g.id, g.organization_id, parentId, p.id, recipient, JSON.stringify(scope), this.time());
    await this.audit(p, 'grant.issue', 'ALLOW', g.id);
    return g;
  }
  async delegate(p: Principal, parent: string, recipient: string, scope: AuthorityScope) { return await this.db.transaction(async () => await this.issue(p, parent, recipient, scope)).immediate(); }
  async provisionChild(p: Principal, parentId: string, scope: AuthorityScope, credentialHash: string, idempotencyKey: string) {
    return this.db.transaction(() => this.provisionChildInTransaction(p,parentId,scope,credentialHash,idempotencyKey)).immediate();
  }
  // Caller must already hold the authority write transaction.
  async provisionChildInTransaction(p: Principal, parentId: string, scope: AuthorityScope, credentialHash: string, idempotencyKey: string) {
      const parent = (await this.chain(parentId,p))[0];
      const fingerprint = JSON.stringify([parentId,scope,credentialHash]);
      const previous = await this.db.prepare('SELECT * FROM child_provisionings WHERE parent_principal_id=? AND idempotency_key=?').get(p.id,idempotencyKey);
      if (previous) {
        if (previous.request_json !== fingerprint) deny('ALREADY_EXECUTED','Provisioning key is bound to another request',409);
        const child = await this.principal(previous.child_principal_id);
        await this.chain(previous.child_grant_id,child);
        const key = await this.db.prepare('SELECT revoked_at FROM principal_keys WHERE key_id=?').get(previous.credential_key_id);
        if (!key || key.revoked_at) deny('INVALID_CALLER','Child credential is no longer active');
        return {principal:child,grant:await this.grant(previous.child_grant_id)};
      }
      this.subset(scope,parent.scope);
      const budget = await this.grantBudget(parent);
      if (budget.remaining_budget_cents === null) deny('INSUFFICIENT_SCOPE','Parent authority unavailable');
      if (scope.total_budget_cents > budget.remaining_budget_cents || scope.max_per_action_cents > budget.remaining_budget_cents) deny('BUDGET_EXCEEDED','Child limits exceed effective remaining ancestor budget');
      if (await this.db.prepare('SELECT key_id FROM principal_keys WHERE key_hash=?').get(credentialHash)) deny('INVALID_REQUEST','Credential verifier is already registered',409);
      const child: Principal = {id:`agent-${randomUUID()}`,organization_id:p.organization_id,kind:'AGENT',role:'SERVICE'};
      const keyId = randomUUID();
      await this.db.prepare('INSERT INTO principals(id,organization_id,kind,role) VALUES(?,?,?,?)').run(child.id,child.organization_id,child.kind,child.role);
      await this.db.prepare('INSERT INTO principal_keys(key_id,principal_id,key_hash) VALUES(?,?,?)').run(keyId,child.id,credentialHash);
      const grant = await this.issue(p,parentId,child.id,scope);
      await this.db.prepare('INSERT INTO child_provisionings(parent_principal_id,idempotency_key,request_json,child_principal_id,child_grant_id,credential_key_id,created_at) VALUES(?,?,?,?,?,?,?)').run(p.id,idempotencyKey,fingerprint,child.id,grant.id,keyId,this.time());
      await this.audit(p,'principal.provision','ALLOW',grant.id);
      return {principal:child,grant};
  }
  async request(p: Principal, parentId: string, scope: AuthorityScope, reason: string) {
    const parent = await this.grant(parentId);
    const parentPrincipal = await this.principal(parent.subject_principal_id);
    await this.chain(parentId, parentPrincipal);
    let delegatedChild = false;
    for (const g of await this.grants(p)) {
      if (g.parent_grant_id !== parentId) continue;
      try { await this.chain(g.id,p); delegatedChild = true; break; }
      catch (error) { if (!(error instanceof Denial)) throw error; }
    }
    if ((!parent.scope.resources && p.organization_id !== parent.organization_id) || p.id === parent.subject_principal_id || !delegatedChild) deny('INVALID_CALLER', 'Only an existing delegated child may request authority');
    const requestId = randomUUID();
    await this.db.prepare('INSERT INTO authority_requests(id,requester_principal_id,parent_grant_id,requested_scope_json,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(requestId,p.id,parentId,JSON.stringify(scope),reason,'PENDING',this.time(),this.time());
    await this.audit(p,'authority.request','PENDING',parentId,undefined,requestId);
    return { request_id: requestId, status: 'PENDING' };
  }
  async getRequest(p: Principal, id: string): Promise<AuthorityRequest> {
    const row = await this.db.prepare('SELECT * FROM authority_requests WHERE id = ?').get(id) as any;
    if (!row) deny('INVALID_REQUEST', 'Request unavailable', 404);
    setAuditContext({requestId:id});
    const parent = await this.grant(row.parent_grant_id);
    if ((!parent.scope.resources && parent.organization_id !== p.organization_id) || ![row.requester_principal_id, parent.subject_principal_id].includes(p.id)) deny('INVALID_CALLER', 'Request is private to its parties');
    setAuditContext({grantId:parent.id});
    return { id: row.id, requester_principal_id: row.requester_principal_id, parent_grant_id: row.parent_grant_id, requested_scope: JSON.parse(row.requested_scope_json), offered_scope: row.offered_scope_json ? JSON.parse(row.offered_scope_json) : undefined, reason: row.reason, status: row.status, issued_grant_id: row.issued_grant_id ?? undefined };
  }
  async respond(p: Principal, id: string, decision: 'COUNTEROFFER' | 'REJECT', offered?: AuthorityScope) {
    return await this.db.transaction(async () => {
      const r = await this.getRequest(p,id);
      const parent = (await this.chain(r.parent_grant_id,p))[0];
      if (r.requester_principal_id === p.id) deny('INVALID_CALLER','Requester cannot approve its own request');
      if (r.status !== 'PENDING') deny('INVALID_REQUEST','Request is no longer pending',409);
      if (decision === 'COUNTEROFFER') {
        if (!offered) deny('INVALID_REQUEST','Counteroffer requires scope',400);
        this.subset(offered,parent.scope);
        // The offer is also bounded by what the child actually requested.
        this.subset(offered, r.requested_scope, false);
        if (offered.max_delegation_depth > r.requested_scope.max_delegation_depth || Date.parse(offered.expires_at) <= this.now().getTime()) deny('OUTSIDE_PARENT_SCOPE','Invalid offer depth or expiration');
      }
      await this.db.prepare('UPDATE authority_requests SET status = ?, offered_scope_json = ?, updated_at = ? WHERE id = ?').run(decision === 'REJECT' ? 'REJECTED' : 'COUNTEROFFERED',offered ? JSON.stringify(offered) : null,this.time(),id);
      await this.audit(p,'authority.respond',decision,r.parent_grant_id,undefined,id);
      return await this.getRequest(p,id);
    }).immediate();
  }
  async accept(p: Principal, id: string) {
    return await this.db.transaction(async () => {
      const r = await this.getRequest(p,id);
      if (r.requester_principal_id !== p.id) deny('INVALID_CALLER','Only requester can accept');
      if (r.status === 'ACCEPTED' && r.issued_grant_id) { await this.chain(r.issued_grant_id,p); return await this.grant(r.issued_grant_id); }
      if (r.status !== 'COUNTEROFFERED' || !r.offered_scope) deny('INVALID_REQUEST','No counteroffer to accept',409);
      const parent = await this.grant(r.parent_grant_id);
      const g = await this.issue(await this.principal(parent.subject_principal_id), parent.id, p.id, r.offered_scope);
      await this.db.prepare("UPDATE authority_requests SET status = 'ACCEPTED', issued_grant_id = ?, updated_at = ? WHERE id = ?").run(g.id,this.time(),id);
      await this.audit(p,'authority.accept','ALLOW',g.id,undefined,id);
      return g;
    }).immediate();
  }
  async revoke(p: Principal, id: string) {
    return await this.db.transaction(async () => {
      const g = await this.grant(id);
      if (g.issuer_principal_id !== p.id && !(g.organization_id === p.organization_id && p.role === 'OWNER')) deny('INVALID_CALLER','Only issuer or organization owner can revoke');
      await this.db.prepare('UPDATE grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(this.time(),id);
      await this.audit(p,'grant.revoke','REVOKED',id);
      return { grant_id: id, revoked_at: (await this.grant(id)).revoked_at };
    }).immediate();
  }
  async authorize(p: Principal, input: ExecuteActionInput, amount: number): Promise<Grant[]> {
    const chain = await this.chain(input.grant_id,p);
    if (chain.some(g => !g.scope.supplier_ids.includes(input.supplier_id) || !g.scope.sku_ids.includes(input.sku_id))) deny('INSUFFICIENT_SCOPE','Resource outside granted scope');
    if (chain.some(g => !g.scope.actions.includes(input.action))) {
      throw new Denial({ status: 'AUTHORITY_REQUIRED', code: 'INSUFFICIENT_SCOPE', reason: 'Action requires additional authority', next_action: 'request_authority', required_scope: { actions: [input.action], supplier_ids: [input.supplier_id], sku_ids: [input.sku_id], max_per_action_cents: amount, total_budget_cents: amount, expires_at: chain[0].scope.expires_at, max_delegation_depth: 0 } });
    }
    if (chain.some(g => amount > g.scope.max_per_action_cents)) deny('BUDGET_EXCEEDED','Per-action limit exceeded');
    return chain;
  }
  async execute(p: Principal, input: ExecuteActionInput) {
    if (input.action === 'supplier.margin.read') {
      await this.chain(input.grant_id,p);
      await this.supplier.policy(p,input.action,{supplier_id:input.supplier_id,sku_id:input.sku_id});
      deny('SELLER_POLICY_DENIED','Supplier private data is unavailable');
    }
    const fingerprint = JSON.stringify([input.grant_id,input.action,input.supplier_id,input.sku_id,input.quantity ?? null,input.quote_id ?? null]);
    const previous = await this.db.prepare('SELECT * FROM purchases WHERE caller_principal_id = ? AND idempotency_key = ?').get(p.id,input.idempotency_key) as any;
    if (previous?.request_json === fingerprint) setAuditContext({requestId:previous.id});
    await this.chain(input.grant_id,p);
    if (previous && previous.request_json !== fingerprint) deny('ALREADY_EXECUTED','Idempotency key is bound to another action',409);
    if (previous?.status === 'COMPLETED') return JSON.parse(previous.receipt_json) as PurchaseReceipt;
    const resource = {supplier_id:input.supplier_id,sku_id:input.sku_id};
    if (input.action === 'supplier.quote.request') {
      await this.authorize(p,input,0);
      if (!await this.supplier.policy(p,input.action,resource)) deny('SELLER_POLICY_DENIED','Supplier policy denied quote');
      await this.authorize(p,input,0);
      const quoteRequestId = randomUUID();
      setAuditContext({requestId:quoteRequestId});
      const q = quoteSchema.parse(await this.supplier.quote({buyer_principal_id:p.id,...resource,quantity:input.quantity!,request_id:quoteRequestId}));
      await this.authorize(p,input,0);
      if (q.supplier_id !== input.supplier_id || q.sku_id !== input.sku_id || q.quantity !== input.quantity) deny('INVALID_REQUEST','Supplier quote does not match request');
      await this.audit(p,input.action,'ALLOW',input.grant_id);
      return q;
    }
    const quote = quoteSchema.parse(await this.supplier.getQuote(input.quote_id!));
    if (quote.quote_id !== input.quote_id || quote.supplier_id !== input.supplier_id || quote.sku_id !== input.sku_id || (input.quantity !== undefined && input.quantity !== quote.quantity)) deny('INVALID_REQUEST','Quote does not match action');
    if (Date.parse(quote.expires_at) <= this.now().getTime()) deny('QUOTE_EXPIRED','Supplier quote expired');
    await this.authorize(p,input,quote.total_cents);
    if (!await this.supplier.policy(p,input.action,resource)) deny('SELLER_POLICY_DENIED','Supplier policy denied purchase');
    const purchase = await this.db.transaction(async () => {
      const chain = await this.authorize(p,input,quote.total_cents);
      if (Date.parse(quote.expires_at) <= this.now().getTime()) deny('QUOTE_EXPIRED','Supplier quote expired before reservation');
      const existing = await this.db.prepare('SELECT * FROM purchases WHERE caller_principal_id = ? AND idempotency_key = ?').get(p.id,input.idempotency_key) as any;
      if (existing) {
        if (existing.request_json !== fingerprint || existing.amount_cents !== quote.total_cents) deny('ALREADY_EXECUTED','Purchase binding differs',409);
        return existing;
      }
      for (const g of chain) {
        const used = (await this.db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS amount FROM ledger_entries WHERE grant_id = ? AND state IN ('RESERVED','COMMITTED')").get(g.id) as any).amount;
        if (quote.total_cents > g.scope.total_budget_cents - used) deny('BUDGET_EXCEEDED','Shared grant budget exhausted');
      }
      const purchaseId = randomUUID();
      await this.db.prepare("INSERT INTO purchases(id,caller_principal_id,grant_id,quote_id,idempotency_key,amount_cents,status,created_at,updated_at,request_json) VALUES(?,?,?,?,?,?,'PENDING',?,?,?)").run(purchaseId,p.id,input.grant_id,quote.quote_id,input.idempotency_key,quote.total_cents,this.time(),this.time(),fingerprint);
      for (const g of chain) await this.db.prepare("INSERT INTO ledger_entries(id,purchase_id,grant_id,amount_cents,state,created_at) VALUES(?,?,?,?,'RESERVED',?)").run(randomUUID(),purchaseId,g.id,quote.total_cents,this.time());
      setAuditContext({requestId:purchaseId});
      await this.audit(p,input.action,'RESERVED',input.grant_id,undefined,purchaseId);
      return {id:purchaseId,status:'PENDING'};
    }).immediate();
    setAuditContext({requestId:purchase.id});
    if (purchase.status === 'COMPLETED') return JSON.parse(purchase.receipt_json) as PurchaseReceipt;
    // Uncertain supplier outcomes retain reservations; retry reconciles the same request ID.
    const order = await this.supplier.fulfill({quote_id:quote.quote_id,buyer_principal_id:p.id,request_id:purchase.id});
    if (!order.order_id || typeof order.order_id !== 'string') throw new Error('Invalid supplier fulfillment');
    return completePurchase(this.db,purchase.id,quote,order.order_id,p,this.time());
  }
}

/**
 * Agent toolkit against the real stack: A's authority (SQLite) + this repo's
 * supplier, with each agent connected through its own stdio MCP process.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorityScope, Grant, SupplierQuote } from '../../../packages/contracts/src/index.js';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { HttpSupplierService } from '../../authority/src/supplier.js';
import { SERVICE_KEY, startSupplier } from '../../supplier/test/harness.js';
import { sqliteStore } from '../../supplier/src/store.js';
import { connectAuthority, isError, type AuthorityClient, type CallRecord } from '../src/authority-client.js';
import { deterministicChild, deterministicParent } from '../src/decider.js';
import { InMemoryHub } from '../src/transport.js';

const keys = { 'owner-1': 'kit-owner', 'buyer-agent': 'kit-buyer', 'sourcing-agent': 'kit-child', 'supplier-agent': 'kit-supplier' };

let supplier: Awaited<ReturnType<typeof startSupplier>>;
let authority: Server;
let db: ReturnType<typeof openDatabase>;
let buyer: AuthorityClient;
let child: AuthorityClient;
const calls: CallRecord[] = [];

beforeAll(async () => {
  supplier = await startSupplier(sqliteStore(':memory:'));
  db = openDatabase(':memory:');
  seedDatabase(db, keys);
  const app = createAuthorityApp({ db, supplier: new HttpSupplierService(supplier.base, SERVICE_KEY) });
  authority = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const authorityUrl = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`;
  const onCall = (r: CallRecord) => calls.push(r);
  [buyer, child] = await Promise.all([
    connectAuthority({ kind: 'stdio', authorityUrl, agentApiKey: keys['buyer-agent'] }, { label: 'buyer-agent', onCall }),
    connectAuthority({ kind: 'stdio', authorityUrl, agentApiKey: keys['sourcing-agent'] }, { label: 'sourcing-agent', onCall }),
  ]);
}, 30_000);

afterAll(async () => {
  await Promise.all([buyer?.close(), child?.close()]);
  await new Promise((r) => authority?.close(r));
  db?.close();
  await supplier?.stop();
});

function ok<T>(result: { status: string; data?: T } | any): T {
  expect(result.status, JSON.stringify(result)).toBe('OK');
  return result.data as T;
}

describe('agent toolkit over real MCP', () => {
  it('runs quote -> AUTHORITY_REQUIRED -> request $1200 -> counteroffer $900 -> accept -> buy $850', async () => {
    const root = ok<{ grants: Grant[] }>(await buyer.getMyGrants()).grants.find((g) => g.id === 'grant-root-buyer')!;
    expect(root.scope.total_budget_cents).toBe(100000);

    const quoteOnly: AuthorityScope = {
      actions: ['supplier.quote.request'], supplier_ids: ['supplier-co'], sku_ids: ['PACK-500'],
      max_per_action_cents: 0, total_budget_cents: 0,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), max_delegation_depth: 0,
    };
    const childGrant = ok<Grant>(await buyer.delegateAuthority({ parent_grant_id: root.id, recipient_principal_id: 'sourcing-agent', scope: quoteOnly }));

    const quote = ok<SupplierQuote>(await child.executeAction({
      grant_id: childGrant.id, action: 'supplier.quote.request', supplier_id: 'supplier-co', sku_id: 'PACK-500', quantity: 500, idempotency_key: 'kit-quote',
    }));
    expect(quote.total_cents).toBe(85000);

    const blocked = await child.executeAction({
      grant_id: childGrant.id, action: 'supplier.purchase.execute', supplier_id: 'supplier-co', sku_id: 'PACK-500', quote_id: quote.quote_id, idempotency_key: 'kit-buy-1',
    });
    expect(blocked).toMatchObject({ status: 'AUTHORITY_REQUIRED', next_action: 'request_authority' });
    if (!isError(blocked) || !blocked.required_scope) throw new Error('expected required_scope');

    // Parent listens for requests over the agent transport; authority is checked via its own MCP key.
    const hub = new InMemoryHub();
    const parentLink = hub.endpoint('buyer-agent');
    const childLink = hub.endpoint('sourcing-agent');
    const parentDecider = deterministicParent({ capCents: 90000, offerMinutes: 10 });
    parentLink.onMessage(async (env) => {
      if (env.message.type !== 'AUTHORITY_REQUESTED') return;
      const request = ok<any>(await buyer.getAuthorityRequest(env.message.request_id));
      const decision = parentDecider.respond({ request, parentGrant: root, now: new Date() });
      await buyer.respondAuthorityRequest({ request_id: request.id, ...decision });
      await parentLink.reply(env, { type: 'AUTHORITY_RESPONDED', request_id: request.id, decision: decision.decision });
    });

    const ask = deterministicChild.requestScope({ required: blocked.required_scope, desiredBudgetCents: 120000, now: new Date() });
    expect(ask.scope.total_budget_cents).toBe(120000);
    const requested = ok<{ request_id: string }>(await child.requestAuthority({ parent_grant_id: root.id, requested_scope: ask.scope, reason: ask.reason }));

    // A child cannot approve its own request.
    expect(await child.respondAuthorityRequest({ request_id: requested.request_id, decision: 'COUNTEROFFER', offered_scope: ask.scope }))
      .toMatchObject({ status: 'DENIED', code: 'INVALID_CALLER' });

    await childLink.send('buyer-agent', { type: 'AUTHORITY_REQUESTED', request_id: requested.request_id, parent_grant_id: root.id, requested_scope: ask.scope }, 'corr-1');
    expect(await childLink.waitForReply('corr-1', 10_000)).toMatchObject({ type: 'AUTHORITY_RESPONDED', decision: 'COUNTEROFFER' });

    const offer = ok<any>(await child.getAuthorityRequest(requested.request_id));
    expect(offer.status).toBe('COUNTEROFFERED');
    expect(offer.offered_scope.total_budget_cents).toBe(90000);
    expect(deterministicChild.acceptOffer({ offered: offer.offered_scope, neededCents: quote.total_cents })).toBe(true);

    const purchaseGrant = ok<Grant>(await child.acceptAuthorityOffer({ request_id: requested.request_id, idempotency_key: 'kit-accept' }));
    expect(purchaseGrant.subject_principal_id).toBe('sourcing-agent');
    const receipt = ok<any>(await child.executeAction({
      grant_id: purchaseGrant.id, action: 'supplier.purchase.execute', supplier_id: 'supplier-co', sku_id: 'PACK-500', quote_id: quote.quote_id, idempotency_key: 'kit-buy-2',
    }));
    expect(receipt).toMatchObject({ amount_cents: 85000, outcome: 'COMPLETED', simulated: true });
  }, 30_000);

  it('records every call with the caller label and never the key', () => {
    expect(calls.map((c) => c.principal)).toEqual(expect.arrayContaining(['buyer-agent', 'sourcing-agent']));
    expect(calls.map((c) => c.tool)).toEqual(expect.arrayContaining(['execute_action', 'request_authority', 'respond_authority_request', 'accept_authority_offer']));
    expect(JSON.stringify(calls)).not.toMatch(/kit-(buyer|child|owner)/);
  });
});

describe('deterministic parent decider', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const parentGrant: Grant = {
    id: 'grant-root-buyer', organization_id: 'buyer-co', issuer_principal_id: 'owner-1', subject_principal_id: 'buyer-agent', parent_grant_id: null, revoked_at: null,
    scope: { actions: ['supplier.quote.request', 'supplier.purchase.execute'], supplier_ids: ['supplier-co'], sku_ids: ['PACK-500'], max_per_action_cents: 100000, total_budget_cents: 100000, expires_at: '2026-10-19T12:00:00Z', max_delegation_depth: 2 },
  };
  const request = (scope: Partial<AuthorityScope>) => ({
    id: 'r1', requester_principal_id: 'sourcing-agent', parent_grant_id: parentGrant.id, reason: 'x', status: 'PENDING' as const,
    requested_scope: { actions: ['supplier.purchase.execute'], supplier_ids: ['supplier-co'], sku_ids: ['PACK-500'], max_per_action_cents: 120000, total_budget_cents: 120000, expires_at: '2026-10-18T13:00:00Z', max_delegation_depth: 0, ...scope } as AuthorityScope,
  });
  const decider = deterministicParent({ capCents: 90000, offerMinutes: 10 });

  it('caps at $900, keeps resources, and shortens expiry', () => {
    const out = decider.respond({ request: request({}), parentGrant, now });
    expect(out).toMatchObject({ decision: 'COUNTEROFFER', offered_scope: { max_per_action_cents: 90000, total_budget_cents: 90000, actions: ['supplier.purchase.execute'], max_delegation_depth: 0, expires_at: '2026-10-18T12:10:00.000Z' } });
  });

  it('never offers more than the child asked for', () => {
    const out = decider.respond({ request: request({ max_per_action_cents: 50000, total_budget_cents: 50000 }), parentGrant, now });
    expect(out).toMatchObject({ offered_scope: { total_budget_cents: 50000 } });
  });

  it('rejects resources outside its own grant', () => {
    expect(decider.respond({ request: request({ supplier_ids: ['other-co'] }), parentGrant, now }).decision).toBe('REJECT');
  });
});

import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { migrateStore } from '../../../db/migrations.js';
import { sqliteStore } from '../../../db/store.js';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import { AccountService } from '../src/accounts.js';
import { ConsentService } from '../src/consent.js';
import { ConsentSessions } from '../src/consent-sessions.js';
import { AuthorityEngine } from '../src/engine.js';

describe('explicit connection consent', () => {
  let db: ReturnType<typeof openDatabase>;
  let engine: AuthorityEngine;
  let accounts: AccountService;
  let now: number;
  let policy: AuthorityScope;
  let consent: ConsentService;

  const identity = (subject: string) => ({ issuer: 'https://identity.example/', subject, client_id: 'fixture-host' });
  const scope = (expiresAt: string): AuthorityScope => ({
    actions: ['supplier.quote.request'],
    supplier_ids: ['supplier-co'],
    sku_ids: ['PACK-500'],
    max_per_action_cents: 0,
    total_budget_cents: 0,
    expires_at: expiresAt,
    max_delegation_depth: 0,
  });

  beforeEach(async () => {
    now = Date.parse('2026-10-17T23:00:00.000Z');
    db = openDatabase(':memory:');
    const store = sqliteStore(db);
    await migrateStore(store, 'sqlite');
    engine = new AuthorityEngine(store, {} as any, () => new Date(now));
    accounts = new AccountService(store, () => new Date(now));
    policy = scope(new Date(now + 60 * 60 * 1000).toISOString());
    consent = new ConsentService(engine, () => policy, () => new Date(now));
  });

  afterEach(() => db.close());

  it('creates no grant until the owner explicitly approves, then activates one bounded connection', async () => {
    const account = await accounts.bootstrap(identity('consent-owner'));
    expect(account.connection.state).toBe('CONSENT_REQUIRED');
    expect((db.prepare('SELECT COUNT(*) AS count FROM grants').get() as { count: number }).count).toBe(0);

    const requested = scope(new Date(now + 30 * 60 * 1000).toISOString());
    const request = await consent.request(account.account_id, account.connection.id, requested);
    expect(request.scope).toEqual(requested);
    expect((db.prepare('SELECT COUNT(*) AS count FROM grants').get() as { count: number }).count).toBe(0);
    expect(await accounts.connectionForPrincipal(account.connection.principal_id)).toMatchObject({
      state: 'CONSENT_REQUIRED', grant_id: null, scope: null,
    });

    const grant = await consent.approve(account.account_id, request.id);
    expect(grant).toMatchObject({
      organization_id: account.organization.id,
      issuer_principal_id: account.human_principal_id,
      subject_principal_id: account.connection.principal_id,
      scope: requested,
      revoked_at: null,
    });
    expect(await accounts.connectionForPrincipal(account.connection.principal_id)).toMatchObject({
      state: 'ACTIVE', grant_id: grant.id, scope: requested,
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM grants').get() as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM consent_approvals WHERE connection_id=?').get(account.connection.id) as { count: number }).count).toBe(1);
  });

  it('rejects malformed, widened, and cross-account consent requests without issuing authority', async () => {
    const owner = await accounts.bootstrap(identity('request-owner'));
    const other = await accounts.bootstrap(identity('other-owner'));
    const valid = scope(new Date(now + 30 * 60 * 1000).toISOString());

    await expect(consent.request(owner.account_id, owner.connection.id, { ...valid, unexpected: true } as any)).rejects.toThrow();
    await expect(consent.request(owner.account_id, owner.connection.id, { ...valid, supplier_ids: ['supplier-co', 'other-supplier'] })).rejects.toMatchObject({
      result: { code: 'OUTSIDE_PARENT_SCOPE' },
    });
    await expect(consent.request(owner.account_id, other.connection.id, valid)).rejects.toMatchObject({
      result: { code: 'INVALID_CALLER' },
    });

    const request = await consent.request(owner.account_id, owner.connection.id, valid);
    await expect(consent.approve(other.account_id, request.id)).rejects.toMatchObject({
      result: { code: 'INVALID_CALLER' },
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM grants').get() as { count: number }).count).toBe(0);
  });

  it('rejects expired requests and makes an approval replay idempotent', async () => {
    const account = await accounts.bootstrap(identity('replay-owner'));
    const request = await consent.request(account.account_id, account.connection.id, scope(new Date(now + 30 * 60 * 1000).toISOString()));

    now += 5 * 60 * 1000 + 1;
    await expect(consent.approve(account.account_id, request.id)).rejects.toMatchObject({
      result: { code: 'GRANT_EXPIRED' },
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM grants').get() as { count: number }).count).toBe(0);

    now = Date.parse('2026-10-17T23:00:00.000Z');
    const fresh = await consent.request(account.account_id, account.connection.id, scope(new Date(now + 30 * 60 * 1000).toISOString()));
    const first = await consent.approve(account.account_id, fresh.id);
    const replay = await consent.approve(account.account_id, fresh.id);
    expect(replay.id).toBe(first.id);
    expect((db.prepare('SELECT COUNT(*) AS count FROM grants').get() as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM consent_approvals WHERE connection_id=?').get(account.connection.id) as { count: number }).count).toBe(1);
  });

  it('revokes an approved connection permanently and refuses consent when account bindings are inactive', async () => {
    const revoked = await accounts.bootstrap(identity('revoked-owner'));
    const request = await consent.request(revoked.account_id, revoked.connection.id, scope(new Date(now + 30 * 60 * 1000).toISOString()));
    const grant = await consent.approve(revoked.account_id, request.id);
    expect(await consent.revoke(revoked.account_id, revoked.connection.id)).toEqual({ connection_id: revoked.connection.id, state: 'REVOKED' });
    expect(await consent.revoke(revoked.account_id, revoked.connection.id)).toEqual({ connection_id: revoked.connection.id, state: 'REVOKED' });
    expect(await accounts.connectionForPrincipal(revoked.connection.principal_id)).toMatchObject({ state: 'REVOKED', principal_active: false });
    expect((await engine.grant(grant.id)).revoked_at).not.toBeNull();
    await expect(accounts.bootstrap(identity('revoked-owner'))).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });

    const inactive = await accounts.bootstrap(identity('inactive-owner'));
    db.prepare("UPDATE accounts SET state='INACTIVE' WHERE id=?").run(inactive.account_id);
    await expect(consent.request(inactive.account_id, inactive.connection.id, scope(new Date(now + 30 * 60 * 1000).toISOString()))).rejects.toMatchObject({
      result: { code: 'INVALID_CALLER' },
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM grants').get() as { count: number }).count).toBe(1);
  });

  it('does not approve requests after the owner membership is disabled', async () => {
    const account = await accounts.bootstrap(identity('inactive-membership-owner'));
    const request = await consent.request(account.account_id, account.connection.id, scope(new Date(now + 30 * 60 * 1000).toISOString()));
    db.prepare("UPDATE memberships SET state='INACTIVE' WHERE id=?").run(account.membership_id);

    await expect(consent.approve(account.account_id, request.id)).rejects.toMatchObject({
      result: { code: 'INVALID_CALLER' },
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM grants').get() as { count: number }).count).toBe(0);
  });
});

describe('encrypted consent sessions', () => {
  let db: ReturnType<typeof openDatabase>;
  let now: number;
  const key = randomBytes(32);

  beforeEach(async () => {
    now = Date.parse('2026-10-17T23:00:00.000Z');
    db = openDatabase(':memory:');
    await migrateStore(sqliteStore(db), 'sqlite');
  });

  afterEach(() => db.close());

  it('stores only a hash and authenticated ciphertext and rejects tampering', async () => {
    const sessions = new ConsentSessions(sqliteStore(db), key, () => new Date(now));
    const secret = 'pkce-verifier-do-not-store-in-plaintext-83d7432e';
    const data = { account_id: 'account-sensitive', state: secret, nonce: 'nonce-sensitive-7e2a' };
    const id = await sessions.create(data);
    const idHash = createHash('sha256').update(id).digest('hex');
    const row = db.prepare('SELECT id_hash,payload_ciphertext,expires_at FROM consent_sessions WHERE id_hash=?').get(idHash) as {
      id_hash: string; payload_ciphertext: string; expires_at: string;
    };

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.id_hash).toBe(idHash);
    expect(row.payload_ciphertext).not.toContain(secret);
    expect(row.payload_ciphertext).not.toContain('account-sensitive');
    expect(Date.parse(row.expires_at)).toBe(now + 5 * 60 * 1000);
    expect(await sessions.read(id)).toEqual(data);

    const bytes = Buffer.from(row.payload_ciphertext, 'base64url');
    bytes[bytes.length - 1] ^= 1;
    db.prepare('UPDATE consent_sessions SET payload_ciphertext=? WHERE id_hash=?').run(bytes.toString('base64url'), idHash);
    await expect(sessions.read(id)).rejects.toThrow();
  });

  it('expires and removes sessions instead of returning stale data', async () => {
    const sessions = new ConsentSessions(sqliteStore(db), key, () => new Date(now));
    const id = await sessions.create({ account_id: 'account-expiring' });
    now += 5 * 60 * 1000 + 1;
    expect(await sessions.read(id)).toBeNull();

    await sessions.create({ account_id: 'account-current' });
    expect((db.prepare('SELECT COUNT(*) AS count FROM consent_sessions').get() as { count: number }).count).toBe(1);
    await sessions.remove(id);
    expect((db.prepare('SELECT COUNT(*) AS count FROM consent_sessions').get() as { count: number }).count).toBe(1);
  });

  it('allows exactly one concurrent consumer to retrieve a session', async () => {
    const sessions = new ConsentSessions(sqliteStore(db), key, () => new Date(now));
    const payload = { account_id: 'single-use-account', state: 'single-use-state' };
    const id = await sessions.create(payload);
    const results = await Promise.all([sessions.consume(id), sessions.consume(id)]);

    expect(results.filter(Boolean)).toEqual([payload]);
    expect(results.filter(result => result === null)).toHaveLength(1);
    expect(await sessions.read(id)).toBeNull();
  });
});

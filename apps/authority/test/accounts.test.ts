import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { migrateStore } from '../../../db/migrations.js';
import { postgresStore } from '../../../db/postgres.js';
import { sqliteStore } from '../../../db/store.js';
import { AccountBootstrapError, AccountService } from '../src/accounts.js';
import { AuthorityEngine } from '../src/engine.js';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';

describe('self-service account persistence', () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountService;
  let now: number;

  beforeEach(async () => {
    now = Date.parse('2026-10-17T23:00:00.000Z');
    db = openDatabase(':memory:');
    await migrateStore(sqliteStore(db), 'sqlite');
    accounts = new AccountService(sqliteStore(db), () => new Date(now));
  });

  afterEach(() => db.close());

  it('creates one personal owner and an unconsented assistant connection without grants', async () => {
    const created = await accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'subject-1', client_id: 'chatgpt-client' });
    expect(created.connection.state).toBe('CONSENT_REQUIRED');
    expect(created.connection.grant_id).toBeNull();
    expect(created.connection.scope).toBeNull();
    expect(created.organization.name).toBe('Personal workspace');
    expect(db.prepare('SELECT kind,role,active FROM principals WHERE id=?').get(created.human_principal_id)).toMatchObject({ kind: 'HUMAN', role: 'OWNER', active: 1 });
    expect(db.prepare('SELECT kind,role,active FROM principals WHERE id=?').get(created.connection.principal_id)).toMatchObject({ kind: 'AGENT', role: 'SERVICE', active: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM grants').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM consent_requests').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM consent_approvals').get() as { n: number }).n).toBe(0);
    expect(await accounts.accountForIdentity({ issuer: 'https://identity.example/', subject: 'subject-1' })).toMatchObject({
      account_id: created.account_id,
      organization: created.organization,
      membership_id: created.membership_id,
      human_principal_id: created.human_principal_id,
    });
  });

  it('deduplicates concurrent first sign-ins and gives different clients distinct principals in one workspace', async () => {
    const identity = { issuer: 'https://identity.example/', subject: 'same-person' };
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => accounts.bootstrap({ ...identity, client_id: 'claude-client' })));
    expect(new Set(concurrent.map(x => x.account_id)).size).toBe(1);
    expect(new Set(concurrent.map(x => x.organization.id)).size).toBe(1);
    expect(new Set(concurrent.map(x => x.connection.id)).size).toBe(1);

    const secondClient = await accounts.bootstrap({ ...identity, client_id: 'chatgpt-client' });
    expect(secondClient.account_id).toBe(concurrent[0].account_id);
    expect(secondClient.membership_id).toBe(concurrent[0].membership_id);
    expect(secondClient.human_principal_id).toBe(concurrent[0].human_principal_id);
    expect(secondClient.connection.principal_id).not.toBe(concurrent[0].connection.principal_id);
    expect(await accounts.bootstrap({ issuer: identity.issuer, subject: 'other-person', client_id: 'claude-client' })).not.toMatchObject({ account_id: concurrent[0].account_id, organization: concurrent[0].organization });
  });

  it('fails closed for revoked connections and inactive accounts or memberships', async () => {
    const revoked = await accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'revoked-person', client_id: 'client' });
    db.prepare("UPDATE assistant_connections SET state='REVOKED',revoked_at=? WHERE id=?").run('2026-10-17T23:01:00.000Z', revoked.connection.id);
    await expect(accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'revoked-person', client_id: 'client' })).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
    expect((await accounts.connectionForPrincipal(revoked.connection.principal_id))?.state).toBe('REVOKED');

    const inactive = await accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'inactive-person', client_id: 'client' });
    db.prepare("UPDATE memberships SET state='INACTIVE' WHERE id=?").run(inactive.membership_id);
    await expect(accounts.accountForIdentity({ issuer: 'https://identity.example/', subject: 'inactive-person' })).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
    expect(await accounts.connectionForPrincipal(inactive.connection.principal_id)).toMatchObject({ state: 'CONSENT_REQUIRED', membership_state: 'INACTIVE' });
    await expect(accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'inactive-person', client_id: 'client' })).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });

    expect(await accounts.accountForIdentity({ issuer: 'https://identity.example/', subject: 'unknown' })).toBeNull();
    await expect(accounts.bootstrap({ issuer: '', subject: 'forged', client_id: 'client' })).rejects.toBeInstanceOf(AccountBootstrapError);
  });

  it('returns a persisted approved scope and identifies legacy principals as non-connections', async () => {
    const pending = await accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'approved-person', client_id: 'client' });
    const scope = { actions: ['supplier.quote.request'], supplier_ids: ['supplier-co'], sku_ids: ['PACK-500'], max_per_action_cents: 0, total_budget_cents: 0, expires_at: '2026-10-18T00:00:00.000Z', max_delegation_depth: 0 };
    const grantId = `grant-${randomUUID()}`;
    db.prepare('INSERT INTO grants(id,organization_id,parent_grant_id,issuer_principal_id,subject_principal_id,scope_json,created_at) VALUES(?,?,NULL,?,?,?,?)').run(grantId, pending.organization.id, pending.human_principal_id, pending.connection.principal_id, JSON.stringify(scope), '2026-10-17T23:00:00.000Z');
    db.prepare("UPDATE assistant_connections SET state='ACTIVE',grant_id=? WHERE id=?").run(grantId, pending.connection.id);
    const reconnected = await accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'approved-person', client_id: 'client' });
    expect(reconnected.connection).toMatchObject({ state: 'ACTIVE', grant_id: grantId, scope });
    expect(await accounts.connectionForPrincipal('legacy-principal')).toBeNull();
    expect(await accounts.connectionForPrincipal(pending.connection.principal_id)).toMatchObject({
      id: pending.connection.id, state: 'ACTIVE', grant_id: grantId, scope, account_state: 'ACTIVE', membership_state: 'ACTIVE', principal_active: true,
    });
  });

  it('deactivates all membership connections and bound grants while preserving descendant history', async () => {
    const owner = await accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'deactivated-person', client_id: 'first-client' });
    const second = await accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'deactivated-person', client_id: 'second-client' });
    const authority = new AuthorityEngine(sqliteStore(db), {} as any, () => new Date(now));
    const rootScope: AuthorityScope = {
      actions: ['supplier.quote.request'], supplier_ids: ['supplier-co'], sku_ids: ['PACK-500'],
      max_per_action_cents: 100, total_budget_cents: 200, expires_at: '2026-10-18T00:00:00.000Z', max_delegation_depth: 2,
    };
    const rootGrantId = `grant-${randomUUID()}`;
    db.prepare(`INSERT INTO grants(id,organization_id,parent_grant_id,issuer_principal_id,subject_principal_id,scope_json,created_at)
      VALUES(?,?,NULL,?,?,?,?)`).run(rootGrantId, owner.organization.id, owner.human_principal_id, owner.connection.principal_id, JSON.stringify(rootScope), '2026-10-17T23:00:00.000Z');
    db.prepare("UPDATE assistant_connections SET state='ACTIVE',grant_id=? WHERE id=?").run(rootGrantId, owner.connection.id);
    const childPrincipalId = `principal-${randomUUID()}`;
    db.prepare("INSERT INTO principals(id,organization_id,kind,role,active) VALUES(?,?,'AGENT','SERVICE',1)").run(childPrincipalId, owner.organization.id);
    const childScope: AuthorityScope = { ...rootScope, total_budget_cents: 100, max_delegation_depth: 1 };
    const childGrant = await authority.issue(
      { id: owner.connection.principal_id, organization_id: owner.organization.id, kind: 'AGENT', role: 'SERVICE' },
      rootGrantId,
      childPrincipalId,
      childScope,
    );
    const child = { id: childPrincipalId, organization_id: owner.organization.id, kind: 'AGENT' as const, role: 'SERVICE' as const };
    await expect(authority.chain(childGrant.id, child)).resolves.toHaveLength(2);

    expect(await accounts.deactivateMembership(owner.membership_id)).toEqual({ membership_id: owner.membership_id, state: 'INACTIVE' });
    const revokedAt = (db.prepare('SELECT revoked_at FROM grants WHERE id=?').get(rootGrantId) as { revoked_at: string }).revoked_at;
    now = Date.parse('2026-10-17T23:00:05.000Z');
    expect(await accounts.deactivateMembership(owner.membership_id)).toEqual({ membership_id: owner.membership_id, state: 'INACTIVE' });
    expect((db.prepare('SELECT revoked_at FROM grants WHERE id=?').get(rootGrantId) as { revoked_at: string }).revoked_at).toBe(revokedAt);
    expect(db.prepare('SELECT id,state FROM assistant_connections WHERE membership_id=? ORDER BY id').all(owner.membership_id)).toEqual([
      { id: owner.connection.id, state: 'REVOKED' }, { id: second.connection.id, state: 'REVOKED' },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect((db.prepare('SELECT active FROM principals WHERE id=?').get(owner.human_principal_id) as { active: number }).active).toBe(0);
    expect((db.prepare('SELECT active FROM principals WHERE id=?').get(owner.connection.principal_id) as { active: number }).active).toBe(0);
    expect((db.prepare('SELECT active FROM principals WHERE id=?').get(second.connection.principal_id) as { active: number }).active).toBe(0);
    expect((db.prepare('SELECT revoked_at FROM grants WHERE id=?').get(rootGrantId) as { revoked_at: string | null }).revoked_at).not.toBeNull();
    expect((db.prepare('SELECT revoked_at FROM grants WHERE id=?').get(childGrant.id) as { revoked_at: string | null }).revoked_at).toBeNull();
    await expect(authority.chain(childGrant.id, child)).rejects.toMatchObject({ result: { code: 'INVALID_CALLER' } });
    await expect(accounts.accountForIdentity({ issuer: 'https://identity.example/', subject: 'deactivated-person' })).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
  });

  it('fails closed for an unknown membership without mutating a valid workspace', async () => {
    const owner = await accounts.bootstrap({ issuer: 'https://identity.example/', subject: 'unknown-membership-person', client_id: 'client' });
    await expect(accounts.deactivateMembership('membership-missing')).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_FOUND' });
    expect((db.prepare('SELECT state FROM memberships WHERE id=?').get(owner.membership_id) as { state: string }).state).toBe('ACTIVE');
    expect((db.prepare('SELECT state FROM assistant_connections WHERE id=?').get(owner.connection.id) as { state: string }).state).toBe('CONSENT_REQUIRED');
  });
});

describe.skipIf(!process.env.AGENTPASS_TEST_DATABASE_URL)('self-service account persistence on disposable PostgreSQL', () => {
  it('migrates without seeds and preserves one connection across reconnects', async () => {
    const db = postgresStore(process.env.AGENTPASS_TEST_DATABASE_URL!);
    const identity = { issuer: 'https://identity.example/', subject: `pg-${randomUUID()}` };
    let accountId: string | undefined;
    let connectionId: string | undefined;
    try {
      await db.migrate();
      await migrateStore(db.store, 'postgres');
      const accounts = new AccountService(db.store);
      const first = await accounts.bootstrap({ ...identity, client_id: 'chatgpt-client' });
      accountId = first.account_id;
      connectionId = first.connection.id;
      const retry = await accounts.bootstrap({ ...identity, client_id: 'chatgpt-client' });
      expect(retry).toMatchObject({ account_id: accountId, connection: { id: connectionId, principal_id: first.connection.principal_id, state: 'CONSENT_REQUIRED', grant_id: null } });
      await expect(accounts.deactivateMembership('membership-does-not-exist')).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_FOUND' });
      expect(await accounts.deactivateMembership(first.membership_id)).toEqual({ membership_id: first.membership_id, state: 'INACTIVE' });
      expect(await accounts.connectionForPrincipal(first.connection.principal_id)).toMatchObject({ state: 'REVOKED', membership_state: 'INACTIVE', principal_active: false });
      const security = await db.store.prepare("SELECT relname,relrowsecurity FROM pg_class WHERE relname=ANY(?) AND relnamespace='agentpass'::regnamespace").all([
        ['accounts','external_identities','memberships','assistant_connections','consent_requests','consent_approvals','consent_sessions','schema_migrations'],
      ]) as Array<{ relname: string; relrowsecurity: boolean }>;
      expect(security).toHaveLength(8);
      expect(security.every(row => row.relrowsecurity)).toBe(true);
    } finally {
      if (connectionId) await db.store.prepare('DELETE FROM consent_requests WHERE connection_id=?').run(connectionId);
      if (connectionId) await db.store.prepare('DELETE FROM consent_approvals WHERE connection_id=?').run(connectionId);
      if (connectionId) await db.store.prepare('DELETE FROM assistant_connections WHERE id=?').run(connectionId);
      if (accountId) {
        await db.store.prepare('DELETE FROM external_identities WHERE account_id=?').run(accountId);
        await db.store.prepare('DELETE FROM memberships WHERE account_id=?').run(accountId);
        const principals = await db.store.prepare('SELECT id,organization_id FROM principals WHERE organization_id=(SELECT personal_organization_id FROM accounts WHERE id=?)').all(accountId) as Array<{ id: string; organization_id: string }>;
        await db.store.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
        for (const principal of principals) await db.store.prepare('DELETE FROM principals WHERE id=?').run(principal.id);
        for (const principal of principals) await db.store.prepare('DELETE FROM organizations WHERE id=?').run(principal.organization_id);
      }
      await db.close();
    }
  });
});

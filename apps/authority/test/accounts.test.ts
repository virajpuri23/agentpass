import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { migrateStore } from '../../../db/migrations.js';
import { postgresStore } from '../../../db/postgres.js';
import { sqliteStore } from '../../../db/store.js';
import { AccountBootstrapError, AccountService } from '../src/accounts.js';

describe('self-service account persistence', () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountService;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    await migrateStore(sqliteStore(db), 'sqlite');
    accounts = new AccountService(sqliteStore(db), () => new Date('2026-10-17T23:00:00.000Z'));
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

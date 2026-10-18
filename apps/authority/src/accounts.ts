import { randomUUID } from 'node:crypto';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import type { AuthorityStore } from '../../../db/store.js';

export interface VerifiedAccountIdentity { issuer: string; subject: string }
export interface VerifiedConnectionIdentity extends VerifiedAccountIdentity { client_id: string }

export interface AccountContext {
  account_id: string;
  organization: { id: string; name: string };
  membership_id: string;
  human_principal_id: string;
}

export interface AccountConnection extends AccountContext {
  id: string;
  membership_id: string;
  organization_id: string;
  principal_id: string;
  client_id: string;
  state: 'CONSENT_REQUIRED' | 'ACTIVE' | 'REVOKED';
  grant_id: string | null;
  scope: AuthorityScope | null;
  revoked_at: string | null;
  account_state: 'ACTIVE' | 'INACTIVE';
  membership_state: 'ACTIVE' | 'INACTIVE';
  principal_active: boolean;
}

export type AccountErrorCode =
  | 'INVALID_IDENTITY'
  | 'IDENTITY_REVOKED'
  | 'ACCOUNT_INACTIVE'
  | 'MEMBERSHIP_INACTIVE'
  | 'PRINCIPAL_INACTIVE'
  | 'CONNECTION_REVOKED'
  | 'ACCOUNT_BINDING_INVALID'
  | 'AMBIGUOUS_ACCOUNT_BINDING'
  | 'MEMBERSHIP_NOT_FOUND';

export class AccountBootstrapError extends Error {
  constructor(public code: AccountErrorCode, message: string) {
    super(message);
    this.name = 'AccountBootstrapError';
  }
}

type MembershipRow = AccountContext & {
  organization_id: string;
  organization_name: string;
  account_state: string;
  identity_state: string;
  membership_state: string;
  membership_role: string;
  human_kind: string;
  human_role: string;
  human_active: number;
};

function inputPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateIdentity(identity: VerifiedAccountIdentity): void {
  if (!identity || typeof identity !== 'object' || !inputPart(identity.issuer) || !inputPart(identity.subject)) {
    throw new AccountBootstrapError('INVALID_IDENTITY', 'Verified issuer and subject are required');
  }
}

export class AccountService {
  constructor(private readonly db: AuthorityStore, private readonly now = () => new Date()) {}

  private async account(identity: VerifiedAccountIdentity): Promise<AccountContext | null> {
    validateIdentity(identity);
    const row = await this.db.prepare(`
      SELECT e.state AS identity_state, a.id AS account_id, a.state AS account_state,
        o.id AS organization_id, o.name AS organization_name, m.id AS membership_id,
        m.state AS membership_state, m.role AS membership_role,
        p.id AS human_principal_id, p.kind AS human_kind, p.role AS human_role, p.active AS human_active
      FROM external_identities e
      JOIN accounts a ON a.id=e.account_id
      JOIN organizations o ON o.id=a.personal_organization_id
      JOIN memberships m ON m.account_id=a.id AND m.organization_id=o.id
      JOIN principals p ON p.id=m.human_principal_id AND p.organization_id=o.id
      WHERE e.issuer=? AND e.subject=?
    `).all(identity.issuer, identity.subject) as MembershipRow[];
    if (row.length === 0) {
      const identityRow = await this.db.prepare('SELECT state FROM external_identities WHERE issuer=? AND subject=?').get(identity.issuer, identity.subject) as { state: string } | undefined;
      if (identityRow) throw new AccountBootstrapError('ACCOUNT_BINDING_INVALID', 'Verified identity has an incomplete account binding');
      return null;
    }
    if (row.length !== 1) throw new AccountBootstrapError('AMBIGUOUS_ACCOUNT_BINDING', 'Verified identity resolves to multiple workspaces');
    const account = row[0];
    if (account.identity_state !== 'ACTIVE') throw new AccountBootstrapError('IDENTITY_REVOKED', 'Verified identity is inactive');
    if (account.account_state !== 'ACTIVE') throw new AccountBootstrapError('ACCOUNT_INACTIVE', 'Account is inactive');
    if (account.membership_state !== 'ACTIVE' || account.membership_role !== 'OWNER') throw new AccountBootstrapError('MEMBERSHIP_INACTIVE', 'Personal workspace membership is inactive');
    if (account.human_active !== 1 || account.human_kind !== 'HUMAN' || account.human_role !== 'OWNER') throw new AccountBootstrapError('PRINCIPAL_INACTIVE', 'Personal workspace owner principal is inactive');
    return {
      account_id: account.account_id,
      organization: { id: account.organization_id, name: account.organization_name },
      membership_id: account.membership_id,
      human_principal_id: account.human_principal_id,
    };
  }

  async accountForIdentity(identity: VerifiedAccountIdentity): Promise<AccountContext | null> {
    return this.account(identity);
  }

  async bootstrap(identity: VerifiedConnectionIdentity): Promise<AccountContext & {
    connection: { id: string; principal_id: string; state: 'CONSENT_REQUIRED' | 'ACTIVE'; grant_id: string | null; scope: AuthorityScope | null };
  }> {
    validateIdentity(identity);
    if (!inputPart(identity.client_id)) throw new AccountBootstrapError('INVALID_IDENTITY', 'Verified client ID is required');
    return this.db.transaction(async () => {
      let account = await this.account(identity);
      if (!account) {
        const organizationId = `org-${randomUUID()}`;
        const accountId = `account-${randomUUID()}`;
        const humanPrincipalId = `principal-${randomUUID()}`;
        const membershipId = `membership-${randomUUID()}`;
        await this.db.prepare('INSERT INTO organizations(id,name) VALUES(?,?)').run(organizationId, 'Personal workspace');
        await this.db.prepare('INSERT INTO principals(id,organization_id,kind,role,active) VALUES(?,?,\'HUMAN\',\'OWNER\',1)').run(humanPrincipalId, organizationId);
        await this.db.prepare('INSERT INTO accounts(id,personal_organization_id,state,created_at) VALUES(?,?,\'ACTIVE\',?)').run(accountId, organizationId, this.now().toISOString());
        await this.db.prepare('INSERT INTO external_identities(issuer,subject,account_id,state,created_at) VALUES(?,?,?,\'ACTIVE\',?)').run(identity.issuer, identity.subject, accountId, this.now().toISOString());
        await this.db.prepare('INSERT INTO memberships(id,account_id,organization_id,human_principal_id,role,state,created_at) VALUES(?,?,?, ?,\'OWNER\',\'ACTIVE\',?)').run(membershipId, accountId, organizationId, humanPrincipalId, this.now().toISOString());
        account = { account_id: accountId, organization: { id: organizationId, name: 'Personal workspace' }, membership_id: membershipId, human_principal_id: humanPrincipalId };
      }

      const rows = await this.db.prepare(`
        SELECT c.id,c.principal_id,c.state,c.grant_id,c.revoked_at,p.active AS principal_active,
          g.scope_json,g.subject_principal_id AS grant_subject,g.organization_id AS grant_organization
        FROM assistant_connections c
        LEFT JOIN principals p ON p.id=c.principal_id
        LEFT JOIN grants g ON g.id=c.grant_id
        WHERE c.membership_id=? AND c.client_id=?
      `).all(account.membership_id, identity.client_id) as Array<Record<string, any>>;
      if (rows.length > 1) throw new AccountBootstrapError('AMBIGUOUS_ACCOUNT_BINDING', 'Verified client resolves to multiple connections');
      let connection = rows[0];
      if (connection) {
        if (connection.state === 'REVOKED' || connection.revoked_at) throw new AccountBootstrapError('CONNECTION_REVOKED', 'Assistant connection was revoked and requires trusted reauthorization');
        if (connection.principal_active !== 1) throw new AccountBootstrapError('PRINCIPAL_INACTIVE', 'Assistant connection principal is inactive');
        if (connection.state !== 'CONSENT_REQUIRED' && connection.state !== 'ACTIVE') throw new AccountBootstrapError('ACCOUNT_BINDING_INVALID', 'Assistant connection state is invalid');
        if ((connection.state === 'CONSENT_REQUIRED' && connection.grant_id !== null) || (connection.state === 'ACTIVE' && (!connection.grant_id || !connection.scope_json || connection.grant_subject !== connection.principal_id || connection.grant_organization !== account.organization.id))) {
          throw new AccountBootstrapError('ACCOUNT_BINDING_INVALID', 'Assistant connection authority binding is invalid');
        }
      } else {
        const connectionId = `connection-${randomUUID()}`;
        const principalId = `principal-${randomUUID()}`;
        await this.db.prepare('INSERT INTO principals(id,organization_id,kind,role,active) VALUES(?,?,\'AGENT\',\'SERVICE\',1)').run(principalId, account.organization.id);
        await this.db.prepare(`INSERT INTO assistant_connections(id,account_id,membership_id,organization_id,principal_id,client_id,state,created_at)
          VALUES(?,?,?,?,?,?,'CONSENT_REQUIRED',?)`).run(connectionId, account.account_id, account.membership_id, account.organization.id, principalId, identity.client_id, this.now().toISOString());
        connection = { id: connectionId, principal_id: principalId, state: 'CONSENT_REQUIRED', grant_id: null, revoked_at: null, principal_active: 1, scope_json: null };
      }
      return {
        ...account,
        connection: {
          id: connection.id,
          principal_id: connection.principal_id,
          state: connection.state,
          grant_id: connection.grant_id,
          scope: connection.scope_json === null ? null : JSON.parse(connection.scope_json),
        },
      };
    }).immediate();
  }

  async connectionForPrincipal(principalId: string): Promise<AccountConnection | null> {
    const rows = await this.db.prepare(`
      SELECT c.id,c.account_id,c.membership_id,c.organization_id,c.principal_id,c.client_id,c.state,c.grant_id,c.revoked_at,
        a.state AS account_state,m.state AS membership_state,p.active AS principal_active,
        o.id AS organization_id,o.name AS organization_name,m.human_principal_id,g.scope_json
      FROM assistant_connections c
      JOIN accounts a ON a.id=c.account_id
      JOIN memberships m ON m.id=c.membership_id AND m.account_id=c.account_id AND m.organization_id=c.organization_id
      JOIN principals p ON p.id=c.principal_id AND p.organization_id=c.organization_id
      JOIN organizations o ON o.id=c.organization_id
      LEFT JOIN grants g ON g.id=c.grant_id
      WHERE c.principal_id=?
    `).all(principalId) as Array<Record<string, any>>;
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new AccountBootstrapError('AMBIGUOUS_ACCOUNT_BINDING', 'Connection principal resolves to multiple bindings');
    const row = rows[0];
    let scope: AuthorityScope | null = null;
    if (row.scope_json !== null && row.scope_json !== undefined) {
      try { scope = JSON.parse(row.scope_json) as AuthorityScope; }
      catch { throw new AccountBootstrapError('ACCOUNT_BINDING_INVALID', 'Assistant connection scope is invalid'); }
    }
    if (row.state === 'ACTIVE' && (!row.grant_id || !scope)) throw new AccountBootstrapError('ACCOUNT_BINDING_INVALID', 'Active connection has no authority scope');
    if (row.state === 'CONSENT_REQUIRED' && (row.grant_id !== null || scope !== null)) throw new AccountBootstrapError('ACCOUNT_BINDING_INVALID', 'Unconsented connection has authority');
    return {
      id: row.id,
      account_id: row.account_id,
      membership_id: row.membership_id,
      organization_id: row.organization_id,
      principal_id: row.principal_id,
      client_id: row.client_id,
      state: row.state,
      grant_id: row.grant_id,
      scope,
      revoked_at: row.revoked_at,
      account_state: row.account_state,
      membership_state: row.membership_state,
      principal_active: row.principal_active === 1,
      organization: { id: row.organization_id, name: row.organization_name },
      human_principal_id: row.human_principal_id,
    };
  }

  async deactivateMembership(membershipId: string): Promise<{ membership_id: string; state: 'INACTIVE' }> {
    if (!inputPart(membershipId)) throw new AccountBootstrapError('MEMBERSHIP_NOT_FOUND', 'Membership is unavailable');
    return this.db.transaction(async () => {
      const membership = await this.db.prepare('SELECT id,human_principal_id FROM memberships WHERE id=?').get(membershipId) as {
        id: string; human_principal_id: string;
      } | undefined;
      if (!membership) throw new AccountBootstrapError('MEMBERSHIP_NOT_FOUND', 'Membership is unavailable');

      const revokedAt = this.now().toISOString();
      await this.db.prepare(`UPDATE grants SET revoked_at=COALESCE(revoked_at,?)
        WHERE id IN (SELECT grant_id FROM assistant_connections WHERE membership_id=? AND grant_id IS NOT NULL)`).run(revokedAt, membershipId);
      await this.db.prepare(`UPDATE assistant_connections SET state='REVOKED',revoked_at=COALESCE(revoked_at,?)
        WHERE membership_id=?`).run(revokedAt, membershipId);
      await this.db.prepare(`UPDATE principals SET active=0
        WHERE id IN (SELECT principal_id FROM assistant_connections WHERE membership_id=?) OR id=?`).run(membershipId, membership.human_principal_id);
      await this.db.prepare("UPDATE memberships SET state='INACTIVE' WHERE id=?").run(membershipId);

      return { membership_id: membershipId, state: 'INACTIVE' as const };
    }).immediate();
  }
}

/**
 * Lead coding agent. Holds the owner's $1,000 tool budget. It creates each
 * specialist with Developer A's provision_child (a fresh identity whose secret
 * stays in a private file; only its SHA-256 reaches AgentPass), gives each a
 * slice limited to its own tool, runs them in parallel, and routes top-up
 * requests (with the specialist's justification) to a decision maker.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthorityRequest, AuthorityScope, Grant } from '../../../packages/contracts/src/index.js';
import { isError } from '../../agent-kit/src/authority-client.js';
import type { AgentContext } from '../../agent-kit/src/runtime.js';
import type { CrewRole, Envelope } from '../../agent-kit/src/transport.js';

const SUPPLIER = 'supplier-co';

interface Child { role: CrewRole; principal_id: string; grant_id: string }

export function serveLead(ctx: AgentContext) {
  const secrets = mkdtempSync(join(tmpdir(), 'agentpass-crew-')); // 0700 by default
  let root: Grant | undefined;
  const children = new Map<string, Child>();
  let spent = 0;

  function sliceScope(role: CrewRole): AuthorityScope {
    return {
      actions: ['supplier.quote.request', 'supplier.purchase.execute'],
      supplier_ids: [SUPPLIER], sku_ids: [role.sku_id],
      max_per_action_cents: role.slice_cents, total_budget_cents: role.slice_cents,
      expires_at: new Date(Math.min(Date.now() + 60 * 60_000, Date.parse(root!.scope.expires_at))).toISOString(),
      max_delegation_depth: 0,
    };
  }

  /** Runtime-generated secret, saved privately before the request; only its hash is sent. */
  function newCredential(agent: string) {
    const secret = randomBytes(32).toString('base64url');
    const file = join(secrets, `${agent}-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify({ secret }), { mode: 0o600, flag: 'wx' });
    return { file, hash: createHash('sha256').update(secret).digest('hex') };
  }

  async function start(env: Envelope, rootGrantId: string, roles: CrewRole[]) {
    const mine = await ctx.authority.getMyGrants();
    root = isError(mine) ? undefined : (mine.data as { grants: Grant[] }).grants.find((g) => g.id === rootGrantId);
    if (!root) return ctx.link.reply(env, { type: 'TASK_RESULT', ok: false, summary: { stage: 'ROOT', root_grant_id: rootGrantId } });
    ctx.note(`Holding the release tool budget: $${root.scope.total_budget_cents / 100}`);

    for (const role of roles) {
      const cred = newCredential(role.agent);
      const made = await ctx.authority.provisionChild({
        parent_grant_id: root.id, scope: sliceScope(role), credential_hash: cred.hash, idempotency_key: `crew-${role.agent}-${randomUUID()}`,
      });
      if (isError(made)) return ctx.link.reply(env, { type: 'TASK_RESULT', ok: false, summary: { stage: 'PROVISION', agent: role.agent, failure: made } });
      const { principal, grant } = made.data as { principal: { id: string }; grant: Grant };
      children.set(role.agent, { role, principal_id: principal.id, grant_id: grant.id });
      ctx.note(`Created ${role.label} (${principal.id}) with $${role.slice_cents / 100} for ${role.sku_id} only`);
      const corr = `spawn-${role.agent}`;
      await ctx.link.send('launcher', { type: 'CREW_SPAWN_REQUESTED', agent: role.agent, credential_file: cred.file }, corr);
      await ctx.link.waitForReply(corr, 30_000);
    }

    const results = await Promise.all(roles.map(async (role) => {
      const corr = `task-${role.agent}-${randomUUID()}`;
      await ctx.link.send(role.agent, { type: 'CREW_TASK', sku_id: role.sku_id, quantity: role.quantity }, corr);
      const reply = await ctx.link.waitForReply(corr, 15 * 60_000);
      const summary = reply.type === 'TASK_RESULT' ? reply.summary : { ok: false };
      spent += Number(summary.amount_cents ?? 0);
      return [role.agent, { ...summary, principal_id: children.get(role.agent)!.principal_id, grant_id: children.get(role.agent)!.grant_id }] as const;
    }));
    await ctx.link.reply(env, {
      type: 'TASK_RESULT', ok: results.every(([, r]) => (r as { ok?: boolean }).ok),
      summary: { root_grant_id: root.id, root_budget_cents: root.scope.total_budget_cents, spent_cents: spent, children: Object.fromEntries(results) },
    });
  }

  async function answer(env: Envelope, requestId: string) {
    const read = await ctx.authority.getAuthorityRequest(requestId);
    if (isError(read)) return ctx.link.reply(env, { type: 'AUTHORITY_RESPONDED', request_id: requestId, decision: 'REJECT' });
    const req = read.data as AuthorityRequest;
    const child = [...children.values()].find((c) => c.principal_id === req.requester_principal_id);
    const asked = req.requested_scope.total_budget_cents;
    const available = root!.scope.total_budget_cents - spent;
    ctx.note(`${child?.role.label ?? 'A specialist'} asks for $${asked / 100}: “${req.reason}”`);

    const corr = `decide-${requestId}`;
    await ctx.link.send('launcher', {
      type: 'DECISION_REQUESTED', request_id: requestId, agent: child?.role.agent ?? req.requester_principal_id,
      sku_id: req.requested_scope.sku_ids[0] ?? '', asked_cents: asked, slice_cents: child?.role.slice_cents ?? 0,
      available_cents: available, reason: req.reason,
    }, corr);
    const d = await ctx.link.waitForReply(corr, 10 * 60_000);
    const decision = d.type === 'DECISION' ? d : { decision: 'DENY' as const };
    const amount = decision.decision === 'APPROVE' ? asked
      : decision.decision === 'PARTIAL' ? Math.min(asked, Math.max(1, Math.round(decision.amount_cents ?? 0))) : 0;

    const responded = amount > 0
      ? await ctx.authority.respondAuthorityRequest({
        request_id: requestId, decision: 'COUNTEROFFER',
        offered_scope: { ...req.requested_scope, max_per_action_cents: amount, total_budget_cents: amount },
      })
      : await ctx.authority.respondAuthorityRequest({ request_id: requestId, decision: 'REJECT' });
    ctx.note(amount === asked ? `Approved $${amount / 100}` : amount > 0 ? `Approved a smaller top-up: $${amount / 100}` : 'Denied the top-up');
    await ctx.link.reply(env, { type: 'AUTHORITY_RESPONDED', request_id: requestId, decision: amount > 0 && !isError(responded) ? 'COUNTEROFFER' : 'REJECT' });
  }

  ctx.link.onMessage(async (env) => {
    const m = env.message;
    try {
      if (m.type === 'CREW_START') return await start(env, m.root_grant_id, m.roles);
      if (m.type === 'AUTHORITY_REQUESTED') return await answer(env, m.request_id);
      if (m.type === 'REVOKE_REQUESTED') {
        const r = await ctx.authority.revokeAuthority({ grant_id: m.grant_id, reason: m.reason });
        if (!isError(r)) ctx.note(`Revoked ${m.grant_id}: ${m.reason}`);
        return await ctx.link.reply(env, { type: 'GRANT_REVOKED', grant_id: m.grant_id, ok: !isError(r), ...(isError(r) ? { code: r.code } : {}) });
      }
      if (m.type === 'PROBE_REQUESTED' && m.probe === 'over_provision') {
        // Try to hand a new helper more than the budget has left.
        const cred = newCredential('extra');
        const result = await ctx.authority.provisionChild({
          parent_grant_id: root!.id,
          scope: { ...sliceScope({ agent: 'extra', label: 'Extra', sku_id: 'SEC-SCAN', slice_cents: Number(m.params.cents), quantity: 1 }) },
          credential_hash: cred.hash, idempotency_key: `over-${randomUUID()}`,
        });
        return await ctx.link.reply(env, { type: 'PROBE_RESULT', probe: m.probe, result });
      }
      if (m.type === 'SHUTDOWN') {
        for (const c of children.keys()) await ctx.link.send(c, { type: 'SHUTDOWN' }, 'shutdown');
        await ctx.authority.close();
        ctx.link.close();
      }
    } catch (error) {
      ctx.note(`Error handling ${m.type}: ${(error as Error).message}`);
      if (m.type === 'CREW_START') await ctx.link.reply(env, { type: 'TASK_RESULT', ok: false, summary: { stage: 'START', error: (error as Error).message } });
    }
  });
}

export const childrenOf = (summary: Record<string, unknown>) => summary.children as Record<string, { grant_id: string; principal_id: string }>;

---
name: scoped-authority
description: Use AgentPass to inspect agent grants, negotiate missing authority, delegate bounded permissions, execute simulated supplier actions, or revoke authority.
---

# AgentPass scoped authority

Use the connected AgentPass MCP service. Discover its tools before choosing a
workflow; the deployed server may expose fewer tools than the repository.

## Start with authenticated inspection

1. Call `describe_authority` and `get_my_grants` without arguments.
2. Explain the caller's available actions, suppliers, SKUs, expiration and remaining
   budgets. Prefer the inspector's current remaining budget over a grant's original
   total. Treat revoked, expired or unavailable authority as unusable.
3. A grant ID is a reference, never proof of identity or permission. Use only the
   connection's authenticated identity; never claim another caller through input.

If authentication fails, ask the user to connect using their own provisioned
credential in the host's secure connection settings. Never ask them to paste a
credential into chat or place one in tool arguments, files or model context. Never
reuse a parent's credential for a child. Human OAuth onboarding is currently
disabled; do not promise a login or start human provisioning with a service key.

## Recover missing authority

When an action returns `AUTHORITY_REQUIRED`, use its `required_scope` and
`next_action` to propose the smallest scope needed for the user's task.

1. Call `request_authority` with an existing parent grant, the bounded requested
   scope and a concrete reason.
2. Call `get_authority_request` to inspect the request. Report a pending request
   without repeatedly polling unchanged state.
3. Only the separately authenticated, authorized parent may call
   `respond_authority_request` to counteroffer or reject. Do not impersonate it.
4. As the requesting child, inspect the offer, accept a suitable narrower scope
   with `accept_authority_offer`, then use the returned grant.

Delegation must stay within the live parent's actions, resources, remaining
budget, expiration and delegation depth. Empty resource lists grant no access.
Do not invent root authority or treat a model's decision as approval.

## Execute and revoke

- Use `execute_action` only for the user's requested action and the discovered
  input schema. For purchases, use the supplier's authoritative `quote_id`; never
  supply or override its price. All supplier purchases are simulated.
- Use a stable idempotency key for the same operation and its retries. Do not
  change inputs or rotate keys to work around a denial or uncertain result.
- A successful inspection is only a snapshot. Execution rechecks live authority
  and supplier policy. Buyer authority never permits private supplier margins.
- Use `delegate_authority` only for an existing intended recipient. `provision_child`
  requires a trusted runtime to generate and retain the child secret privately;
  send only its SHA-256 verifier. Never generate or deliver bearer secrets in chat.
- On a requested revocation, call `revoke_authority` and report the actual receipt.

Preserve machine-readable `status`, `code`, `reason`, `next_action` and
`required_scope` in explanations of failures. Report success only from a successful
tool result, including the grant, request, quote or receipt reference returned.

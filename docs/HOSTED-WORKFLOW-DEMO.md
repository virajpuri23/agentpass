# Demo a hosted AgentPass delegation workflow

The browser dashboard and Codex MCP App read the same canonical authority records.
No recording import, new root grant, budget reset, or purchase is needed to inspect a run.

1. In Codex call `get_my_grants`, then choose **Inspect workflow** on the delegation grant.
   Alternatively call `get_workflow` with `root_grant_id` set to a grant you hold or issued.
2. Inspect the grant tree, per-action/aggregate caps, committed spend and current available authority.
   Revoked/expired grants have no available authority; their historical spend remains visible.
3. Review denied actions, switch to all activity, and inspect the simulated receipt and counteroffer.
4. Choose **Open read-only web dashboard**. The UI receives a one-use link in MCP `_meta`;
   it expires in one minute. Refresh the workflow to get a replacement. The bearer token is never
   included in model-visible content, the URL, browser JavaScript, or the cookie.

The browser handoff creates a fifteen-minute, HttpOnly, SameSite=Strict session restricted
to that exact workflow. It permits no approvals, acceptance, delegation, revocation or purchase.
Every snapshot reauthenticates the original caller; the session never extends credential lifetime.
A restart clears these process-local sessions and links. Reopen from Codex after a restart.

For the October 17 Codex demo, the root grant is
`6aa4f0c1-6279-49f2-b706-a3baa9c7d61a`. Its two child identities are
`agent-b14b4c3d-e6ad-4188-99d1-cde58a046531` (buyer) and
`agent-d509d732-cb09-42ff-bd13-8523ebfaf0ef` (quotes).
The completed purchase is $3.40 and simulated. Both workers were revoked after testing.
The $10 lead grant expires at 2026-10-18T03:22:00Z; the provisioned Codex credential's
initial grant expires at 2026-10-18T03:32:18.553Z. A later live demo needs fresh,
explicitly bounded provisioning; inspection cannot renew authority.

Workflow reads include only the selected same-organization branch. Knowing a grant ID grants
no access. Requests remain private to their requester and parent, even for ancestor observers.
The read model caps activity at 500 and receipts at 100 and reports truncation. Parent and child
committed spending must not be summed: one simulated purchase debits each ancestor ledger.

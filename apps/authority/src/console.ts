import type { Principal } from '../../../packages/contracts/src/index.js';
import type { AuthorityEngine } from './engine.js';

// Read policy: owners see organization grants; other callers see grants they issue or hold.
// Negotiations stay private to their two parties, including for organization owners.
export async function consoleSnapshot(engine: AuthorityEngine, p: Principal) {
  return engine.db.transaction(async () => {
    const owner = p.role === 'OWNER';
    const rows = await engine.db.prepare(`SELECT id FROM grants WHERE organization_id = ?${owner ? '' : ' AND (issuer_principal_id = ? OR subject_principal_id = ?)'} ORDER BY created_at,id`).all(...(owner ? [p.organization_id] : [p.organization_id,p.id,p.id]));
    const grants = [];const budgets = [];
    for (const row of rows) {const grant=await engine.grant(row.id);grants.push(grant);budgets.push(await engine.grantBudget(grant));}
    const requestRows = await engine.db.prepare('SELECT r.id,r.created_at,r.updated_at FROM authority_requests r JOIN grants g ON g.id = r.parent_grant_id WHERE g.organization_id = ? AND (r.requester_principal_id = ? OR g.subject_principal_id = ?) ORDER BY r.created_at DESC,r.id').all(p.organization_id,p.id,p.id);
    const requests = [];
    for (const r of requestRows) requests.push({...await engine.getRequest(p,r.id),created_at:r.created_at,updated_at:r.updated_at});
    const activity = await engine.db.prepare(`SELECT e.event_id,e.timestamp,e.principal_id,e.grant_id,e.action,e.decision,e.reason_code,e.request_id,e.trace_id FROM audit_events e JOIN principals p ON p.id=e.principal_id WHERE p.organization_id=?${owner ? '' : ' AND e.principal_id=?'} ORDER BY e.timestamp DESC,e.rowid DESC LIMIT 201`).all(...(owner ? [p.organization_id] : [p.organization_id,p.id]));
    const receipts = await engine.db.prepare(`SELECT x.receipt_json FROM purchases x JOIN principals p ON p.id=x.caller_principal_id WHERE p.organization_id=? AND x.status='COMPLETED'${owner ? '' : ' AND x.caller_principal_id=?'} ORDER BY x.created_at DESC LIMIT 101`).all(...(owner ? [p.organization_id] : [p.organization_id,p.id]));
    return {principal:p,grants,budgets,requests,activity:activity.slice(0,200),receipts:receipts.slice(0,100).map(r => JSON.parse(r.receipt_json)),
      visibility:{grants:owner ? 'organization' : 'held_or_issued',descendants_complete:owner,requests:'parties_only',activity:owner ? 'organization' : 'caller_only',activity_truncated:activity.length>200,receipts_truncated:receipts.length>100},snapshot_at:engine.time()};
  }).immediate();
}

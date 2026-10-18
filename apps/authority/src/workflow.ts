import type { Principal } from '../../../packages/contracts/src/index.js';
import { deny, type AuthorityEngine } from './engine.js';

// Workflow observers can inspect only the branch they hold or issued. Negotiations remain parties-only.
export async function workflowSnapshot(engine: AuthorityEngine, principal: Principal, rootId: string) {
  return engine.db.transaction(async () => {
    const root = await engine.db.prepare(`SELECT id FROM grants WHERE id=? AND organization_id=?${principal.role==='OWNER'?'':' AND (subject_principal_id=? OR issuer_principal_id=?)'}`).get(rootId,principal.organization_id,...(principal.role==='OWNER'?[]:[principal.id,principal.id]));
    if (!root) deny('INVALID_REQUEST','Workflow unavailable',404);
    const rows = await engine.db.prepare(`WITH RECURSIVE branch(id) AS (
      SELECT id FROM grants WHERE id=? AND organization_id=?
      UNION SELECT g.id FROM grants g JOIN branch b ON g.parent_grant_id=b.id WHERE g.organization_id=?
    ) SELECT g.id FROM grants g JOIN branch b ON g.id=b.id ORDER BY g.created_at,g.id LIMIT 1001`).all(rootId,principal.organization_id,principal.organization_id);
    if (rows.length>1000) deny('INVALID_REQUEST','Workflow exceeds inspection limit',413);
    const ids=rows.map(row=>String(row.id));
    const placeholders=ids.map(()=>'?').join(',');
    const grants=[]; const budgets=[];
    for (const row of rows) {
      const grant=await engine.grant(String(row.id));grants.push(grant);
      const spending=await engine.db.prepare("SELECT COALESCE(SUM(CASE WHEN state='COMMITTED' THEN amount_cents ELSE 0 END),0) AS committed_cents,COALESCE(SUM(CASE WHEN state='RESERVED' THEN amount_cents ELSE 0 END),0) AS reserved_cents FROM ledger_entries WHERE grant_id=?").get(grant.id);
      budgets.push({...await engine.grantBudget(grant),committed_cents:Number(spending.committed_cents),reserved_cents:Number(spending.reserved_cents)});
    }
    const activity=await engine.db.prepare(`SELECT e.event_id,e.timestamp,e.principal_id,e.grant_id,e.action,e.decision,e.reason_code,e.request_id,e.trace_id FROM audit_events e JOIN principals p ON p.id=e.principal_id WHERE p.organization_id=? AND e.grant_id IN (${placeholders}) ORDER BY e.timestamp DESC,e.rowid DESC LIMIT 501`).all(principal.organization_id,...ids);
    const requestRows=await engine.db.prepare(`SELECT r.id,r.created_at,r.updated_at FROM authority_requests r JOIN grants g ON g.id=r.parent_grant_id WHERE g.organization_id=? AND r.parent_grant_id IN (${placeholders}) AND (r.requester_principal_id=? OR g.subject_principal_id=?) ORDER BY r.created_at,r.id`).all(principal.organization_id,...ids,principal.id,principal.id);
    const requests=[];
    for(const row of requestRows)requests.push({...await engine.getRequest(principal,String(row.id)),created_at:row.created_at,updated_at:row.updated_at});
    const receipts=await engine.db.prepare(`SELECT x.receipt_json FROM purchases x JOIN principals p ON p.id=x.caller_principal_id WHERE p.organization_id=? AND x.grant_id IN (${placeholders}) AND x.status='COMPLETED' ORDER BY x.created_at DESC LIMIT 101`).all(principal.organization_id,...ids);
    return {root_grant_id:rootId,principal,grants,budgets,requests,activity:activity.slice(0,500),receipts:receipts.slice(0,100).map(row=>JSON.parse(String(row.receipt_json))),
      visibility:{grants:'delegated_workflow',descendants_complete:true,requests:'parties_only',activity:'delegated_workflow',activity_truncated:activity.length>500,receipts_truncated:receipts.length>100},snapshot_at:engine.time()};
  }).immediate();
}

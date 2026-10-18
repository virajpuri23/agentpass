import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AuthorityStore } from '../../../db/store.js';
import type { Principal, ErrorCode } from '../../../packages/contracts/src/index.js';

interface AuditContext { runId?: string; traceId: string; action: string; grantId?: string; requestId?: string }
export const auditContext = new AsyncLocalStorage<AuditContext>();
export function setAuditContext(values: Partial<AuditContext>) {
  const context = auditContext.getStore();
  if (context) Object.assign(context, values);
}
export async function recordAudit(db: AuthorityStore, timestamp: string, p: Principal, action: string, decision: string, grantId?: string, code?: ErrorCode, requestId?: string) {
  const context = auditContext.getStore();
  grantId ??= context?.grantId;
  requestId ??= context?.requestId;
  const prior = await db.prepare(`SELECT e.trace_id FROM audit_events e JOIN principals p ON p.id=e.principal_id
    WHERE p.organization_id=? AND (e.request_id=? OR (e.grant_id=? AND e.trace_id NOT LIKE 'run-%'))
    ORDER BY CASE WHEN e.request_id=? THEN 0 ELSE 1 END,e.rowid LIMIT 1`).get(p.organization_id,requestId ?? null,grantId ?? null,requestId ?? null) as {trace_id:string} | undefined;
  const traceId = context?.runId ?? prior?.trace_id ?? context?.traceId ?? randomUUID();
  setAuditContext({traceId});
  await db.prepare('INSERT INTO audit_events(event_id,timestamp,principal_id,grant_id,action,decision,reason_code,request_id,trace_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(),timestamp,p.id,grantId ?? null,action,decision,code ?? null,requestId ?? null,traceId);
}

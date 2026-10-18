import { z } from 'zod';

export const WORKFORCE_ACTIONS = ['repo.read','repo.write','security.audit.run','deploy.preview','deploy.production','analytics.aggregate.read','analytics.raw.read'] as const;
export type WorkforceAction = typeof WORKFORCE_ACTIONS[number];
const id = z.string().min(1).max(200);
export const resourceScopeSchema = z.object({
  resource: id, organization_id: id, owner_principal_id: id,
  /** Exact relative file names or directory prefixes ending in /. Empty means no file access. */
  paths: z.array(z.string().min(1).max(1000)).max(100),
}).strict();
export type ResourceScope = z.infer<typeof resourceScopeSchema>;
export const workforceScopeSchema = z.object({
  actions: z.array(z.enum(WORKFORCE_ACTIONS)).max(7).refine(v => new Set(v).size === v.length),
  supplier_ids: z.array(id).max(0), sku_ids: z.array(id).max(0),
  max_per_action_cents: z.literal(0), total_budget_cents: z.literal(0),
  expires_at: z.iso.datetime({offset:true}), max_delegation_depth: z.number().int().min(0).max(20),
  resources: z.array(resourceScopeSchema).min(1).max(100).refine(v => new Set(v.map(r => r.resource)).size === v.length),
  max_executions: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type WorkforceScope = z.infer<typeof workforceScopeSchema>;
const base = {grant_id:id,resource:id,idempotency_key:id};
const path = z.string().min(1).max(1000);
export const workforceActionSchema = z.discriminatedUnion('action',[
  z.object({...base,action:z.literal('repo.read'),parameters:z.object({path}).strict()}).strict(),
  z.object({...base,action:z.literal('repo.write'),parameters:z.object({path,content:z.string().max(24000)}).strict()}).strict(),
  z.object({...base,action:z.literal('security.audit.run'),parameters:z.object({paths:z.array(path).min(1).max(100)}).strict()}).strict(),
  z.object({...base,action:z.literal('deploy.preview'),parameters:z.object({environment:z.literal('preview'),artifact_digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).strict(),
  z.object({...base,action:z.literal('deploy.production'),parameters:z.object({environment:z.literal('production'),artifact_digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).strict(),
  z.object({...base,action:z.literal('analytics.aggregate.read'),parameters:z.object({metric:id}).strict()}).strict(),
  z.object({...base,action:z.literal('analytics.raw.read'),parameters:z.object({}).strict()}).strict(),
]);
export type WorkforceActionInput = z.infer<typeof workforceActionSchema>;
export interface WorkforceDecision {
  status:'ALLOW'|'DENY'|'AUTHORITY_REQUIRED'|'REQUEST_PENDING';
  code:string; reason:string;
  next_action?:'request_authority'|'get_authority_request'|'retry'|'contact_owner';
  required_scope?:WorkforceScope;
  suggested_action?:WorkforceAction;
  execution_id?:string;
  request_id?:string;
  result?:Record<string,unknown>;
}

export const workforceDecisionSchema = z.object({
  status:z.enum(['ALLOW','DENY','AUTHORITY_REQUIRED','REQUEST_PENDING']),
  code:z.string().min(1),reason:z.string().min(1),
  next_action:z.enum(['request_authority','get_authority_request','retry','contact_owner']).optional(),
  required_scope:workforceScopeSchema.optional(),suggested_action:z.enum(WORKFORCE_ACTIONS).optional(),
  execution_id:id.optional(),request_id:id.optional(),result:z.record(z.string(),z.unknown()).optional(),
}).strict();

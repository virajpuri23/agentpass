// A9 review artifact only; no production code imports these proposed contracts.
import { z } from 'zod';
import { scopeSchema } from '../../../mcp/agentpass-manufact/src/authority-client.js';

const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/);
const timestamp=z.iso.datetime({offset:true});
const retry=z.object({idempotency_key:id}).strict();
const claim=z.object({claim_id:id}).strict();
const revoke=retry.extend({reason:z.string().min(1).max(500)}).strict();
const agentBase=z.object({
  agent_id:id,organization_id:id,connection_id:id,requester_account_id:id,
  display_name:z.string().min(1).max(80),template_id:z.literal('sourcing-v1'),
  execution_state:z.enum(['NOT_STARTED','RUNNING','COMPLETED','FAILED','STOPPED']),simulated:z.literal(true),
}).strict();
const authority=z.object({principal_id:id,grant_id:id,scope:scopeSchema}).strict();
const agent=z.discriminatedUnion('state',[
  agentBase.extend({state:z.literal('PENDING'),authority:z.null(),execution_state:z.literal('NOT_STARTED')}).strict(),
  agentBase.extend({state:z.enum(['PROVISIONING','READY']),authority}).strict(),
  agentBase.extend({state:z.enum(['FAILED','REVOKED']),authority:authority.nullable()}).strict(),
]);
export const proposalSchemas={
  context_request:z.object({}).strict(),
  context_data:z.object({
    account_id:id,organization:z.object({id,name:z.string().min(1).max(120)}).strict(),
    connection:z.discriminatedUnion('state',[
      z.object({id,principal_id:id,state:z.literal('CONSENT_REQUIRED'),grant_id:z.null(),scope:z.null()}).strict(),
      z.object({id,principal_id:id,state:z.literal('ACTIVE'),grant_id:id,scope:scopeSchema}).strict(),
    ]),simulated:z.literal(true),
  }).strict(),
  provision_request:retry.extend({display_name:z.string().min(1).max(80),task:z.string().min(1).max(4000),requested_scope:scopeSchema,template_id:z.literal('sourcing-v1')}).strict(),
  agent_data:agent,
  list_request:z.object({cursor:id.optional(),limit:z.number().int().min(1).max(50).optional()}).strict(),
  list_data:z.object({agents:z.array(agent).max(50),next_cursor:id.nullable()}).strict(),
  get_request:z.object({agent_id:id}).strict(),
  revoke_agent_request:revoke.extend({agent_id:id}).strict(),
  revoke_connection_request:revoke,
  revoke_connection_data:z.object({connection_id:id,state:z.literal('REVOKED')}).strict(),
  runner_claim_request:retry,
  runner_claim_data:z.object({job:z.object({job_id:id,agent_id:id,claim_id:id,launch_id:id,template_id:z.literal('sourcing-v1'),task:z.string().min(1).max(4000),grant_id:id,lease_expires_at:timestamp}).strict().nullable()}).strict(),
  runner_credential_request:claim,
  runner_credential_data:z.object({credential:z.string().regex(/^[A-Za-z0-9_-]{43}$/),mcp_url:z.url(),expires_at:timestamp}).strict(),
  runner_heartbeat_request:claim,
  runner_heartbeat_data:z.object({stop:z.boolean(),lease_expires_at:timestamp}).strict(),
  child_ready_request:claim,
  runner_result_request:claim.extend({outcome:z.enum(['COMPLETED','FAILED']),summary:z.string().max(2000)}).strict(),
};

export function proposalBundle(){return {
  $schema:'https://json-schema.org/draft/2020-12/schema',
  $id:'urn:agentpass:proposal:onboarding-v1',
  description:'PROPOSED A9 review bundle; not implemented or agreed by Developer B.',
  $defs:Object.fromEntries(Object.entries(proposalSchemas).map(([name,schema])=>[name,z.toJSONSchema(schema)])),
};}

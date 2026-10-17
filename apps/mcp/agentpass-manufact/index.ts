import { createConsoleHandler } from '../../dashboard/src/handler.js';
import { MCPServer, type RequestContext } from 'mcp-use';
import { z } from 'zod';
import { authorityEndpoint } from './src/backend.js';
import { ACTIONS, scopeSchema, envelopeSchema, createAuthorityClient, toolResult } from './src/authority-client.js';
import { createAgentPassOAuthProvider, humanOAuthConfigFromEnv, type AgentPassOAuthUser } from './src/oauth.js';

const oauthConfig = humanOAuthConfigFromEnv();
const authorityUrl = await authorityEndpoint();
const target = new URL(authorityUrl);
if (target.protocol !== 'https:' && !((process.env.NODE_ENV !== 'production' || process.env.DATABASE_URL) && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) {
  throw new Error('A hosted authority service must use HTTPS.');
}

const serverConfig = {
  name: 'agentpass',
  title: 'AgentPass Authority Inspector',
  version: '2.0.0',
  description: 'Scoped authority negotiation and simulated supplier purchases.',
  instructions: 'Agent onboarding requires no browser. Authenticate using your own credential provisioned by a trusted owner or orchestrator; never borrow a parent credential or self-assign identity. Call describe_authority, then get_my_grants. A parent may use provision_child with a runtime-generated credential verifier and bounded scope. With no grants, obtain initial delegation from a trusted parent. The UI is optional inspection. On AUTHORITY_REQUIRED, use request_authority, poll get_authority_request, then accept_authority_offer. All purchases are simulated.',
};
const oauth = oauthConfig ? createAgentPassOAuthProvider(oauthConfig, authorityUrl) : undefined;
const server = oauth
  ? new MCPServer({ ...serverConfig, oauth })
  : new MCPServer(serverConfig);

server.get('/health', (c) => c.json({ status: 'OK' }));

// Explicit public origin prevents accepting arbitrary Host/proxy headers as a trusted origin.
if (process.env.CONSOLE_ORIGIN && process.env.MCP_PUBLIC_URL) {
  const consoleHandler = createConsoleHandler({authorityUrl,mcpUrl:process.env.MCP_PUBLIC_URL,origin:process.env.CONSOLE_ORIGIN});
  for (const path of ['/connect','/console','/console.js','/console.css','/console-api/*']) server.all(path,c => consoleHandler(c.req.raw));
}

function caller(request: Request) {
  const header = request.headers.get('authorization');
  return header?.match(/^Bearer ([^\s]+)$/)?.[1];
}
function authority(ctx: RequestContext<AgentPassOAuthUser, 'optional'>) {
  const token = ctx.request && caller(ctx.request.raw);
  if (!token) throw new Error('Authenticated request required.');
  return createAuthorityClient({ authorityUrl: authorityUrl!, agentApiKey: token });
}

// Validate every HTTP MCP request; no principal or credential survives between callers.
server.use('/mcp', async (c, next) => {
  const token = caller(c.req.raw);
  if (!token) return c.json({ status: 'DENIED', code: 'INVALID_CALLER', reason: 'An agent bearer credential is required.', next_action: 'contact_owner' }, 401);
  const me = await createAuthorityClient({ authorityUrl, agentApiKey: token })('GET', 'v1/me');
  if (me.status !== 'OK') return c.json(me, me.code === 'INVALID_CALLER' ? 401 : 503);
  await next();
});

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const id = z.string().min(1);

export const describeAuthority = server.tool({
  name: 'describe_authority', description: 'Describe supported actions, scope limits and repair tools.',
  inputSchema: z.object({}).strict(), outputSchema: envelopeSchema, annotations: readOnly,
}, async () => toolResult({ status: 'OK', data: {
  actions: ACTIONS,
  scope_limits: Object.keys(scopeSchema.shape),
  recovery_tools: ['request_authority', 'get_authority_request', 'accept_authority_offer'],
} }));

export const getMyGrants = server.tool({
  name: 'get_my_grants', description: 'Inspect only the authenticated caller’s delegated authority.',
  inputSchema: z.object({}).strict(), outputSchema: envelopeSchema, annotations: readOnly,
  view: { name: 'authority-inspector', description: 'Authenticated authority, budgets and latest decision.' },
}, async (_input, ctx) => {
  const result = await authority(ctx)('GET', 'v1/me');
  if (result.status !== 'OK') return toolResult(result);
  if (!Array.isArray(result.data.grants)) return toolResult({ status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'Authority grant list unavailable.', next_action: 'retry' });
  return { ...toolResult({ status: 'OK', data: { grants: result.data.grants } }),
    _meta: { principal_id: result.data.principal_id, organization_id: result.data.organization_id, inspector: result.data.inspector, ...(process.env.CONSOLE_ORIGIN && process.env.MCP_PUBLIC_URL ? {console_url:new URL('/connect',process.env.CONSOLE_ORIGIN).href} : {}) } };
});

export const requestAuthority = server.tool({
  name: 'request_authority', description: 'Request additional scoped authority from an existing parent.',
  inputSchema: z.object({ parent_grant_id: id, requested_scope: scopeSchema, reason: id }).strict(),
  outputSchema: envelopeSchema, annotations: write,
}, async (input, ctx) => toolResult(await authority(ctx)('POST', 'v1/authority/requests', input)));

export const getAuthorityRequest = server.tool({
  name: 'get_authority_request', description: 'Read a negotiation visible to the authenticated caller.',
  inputSchema: z.object({ request_id: id }).strict(), outputSchema: envelopeSchema, annotations: readOnly,
}, async ({ request_id }, ctx) => toolResult(await authority(ctx)('GET', `v1/authority/requests/${encodeURIComponent(request_id)}`)));

export const respondAuthorityRequest = server.tool({
  name: 'respond_authority_request', description: 'Counteroffer or reject as the authorized parent.',
  inputSchema: z.object({ request_id: id, decision: z.enum(['COUNTEROFFER', 'REJECT']), offered_scope: scopeSchema.optional() }).strict(),
  outputSchema: envelopeSchema, annotations: write,
}, async ({ request_id, ...body }, ctx) => toolResult(await authority(ctx)('POST', `v1/authority/requests/${encodeURIComponent(request_id)}/respond`, body)));

export const acceptAuthorityOffer = server.tool({
  name: 'accept_authority_offer', description: 'Accept the narrowed offer as its requesting child.',
  inputSchema: z.object({ request_id: id, idempotency_key: id }).strict(), outputSchema: envelopeSchema, annotations: write,
}, async ({ request_id, ...body }, ctx) => toolResult(await authority(ctx)('POST', `v1/authority/requests/${encodeURIComponent(request_id)}/accept`, body)));

export const provisionChild = server.tool({
  name:'provision_child',description:'Provision a new AGENT/SERVICE child in the authenticated parent organization and delegate a subset of its live grant. The trusted runtime must generate the child secret locally; submit only its SHA-256 verifier, never a bearer credential. Reuse the same idempotency key and input on retry.',
  inputSchema:z.object({parent_grant_id:id,scope:scopeSchema,credential_hash:z.string().regex(/^[a-f0-9]{64}$/),idempotency_key:id}).strict(),
  outputSchema:envelopeSchema,annotations:write,
},async ({parent_grant_id,...body},ctx) => toolResult(await authority(ctx)('POST',`v1/grants/${encodeURIComponent(parent_grant_id)}/provision-child`,body)));

export const delegateAuthority = server.tool({
  name: 'delegate_authority', description: 'Delegate a strict subset of a live parent grant.',
  inputSchema: z.object({ parent_grant_id: id, recipient_principal_id: id, scope: scopeSchema }).strict(),
  outputSchema: envelopeSchema, annotations: write,
}, async ({ parent_grant_id, ...body }, ctx) => toolResult(await authority(ctx)('POST', `v1/grants/${encodeURIComponent(parent_grant_id)}/delegate`, body)));

export const executeAction = server.tool({
  name: 'execute_action', description: 'Request a trusted supplier quote or execute an authorized simulated purchase. Purchase prices come from quote_id.',
  inputSchema: z.object({ grant_id: id, action: z.enum(ACTIONS), supplier_id: id, sku_id: id, quantity: z.number().int().positive().optional(), quote_id: id.optional(), idempotency_key: id }).strict(),
  outputSchema: envelopeSchema, annotations: write,
}, async (input, ctx) => toolResult(await authority(ctx)('POST', 'v1/actions/execute', input)));

export const revokeAuthority = server.tool({
  name: 'revoke_authority', description: 'Revoke authority as its issuer or organization owner.',
  inputSchema: z.object({ grant_id: id, reason: id }).strict(), outputSchema: envelopeSchema,
  annotations: { ...write, destructiveHint: true },
}, async ({ grant_id, ...body }, ctx) => toolResult(await authority(ctx)('POST', `v1/grants/${encodeURIComponent(grant_id)}/revoke`, body)));

export default server;

import { createConsoleHandler } from '../../dashboard/src/handler.js';
import { MCPServer, type RequestContext } from 'mcp-use';
import { z } from 'zod';
import { authorityEndpoint } from './src/backend.js';
import { ACTIONS, SUPPLIER_ACTIONS, scopeSchema, envelopeSchema, createAuthorityClient, toolResult } from './src/authority-client.js';
import { workforceActionSchema } from '../../../packages/contracts/src/workforce.js';
import { createAgentPassOAuthProvider, humanOAuthConfigFromEnv, type AgentPassOAuthUser } from './src/oauth.js';
import { createOnboardingProxy } from './src/onboarding-proxy.js';
import { onboardingSchemas } from '../../../packages/contracts/src/index.js';

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
  instructions: 'Authenticate with your own verified Supabase OAuth connection or provisioned agent credential; never borrow a parent credential or self-assign identity. Human connections begin without spending authority. Use get_onboarding_context and follow its trusted consent link when required; after consent, use provision_agent, list_agents, get_agent, and revoke_agent to manage narrowly scoped children. Service agents may use provision_child only within their live grant. Use describe_authority and get_my_grants to inspect direct authority. On AUTHORITY_REQUIRED, use request_authority, poll get_authority_request, then accept_authority_offer. All purchases are simulated.',
};
const oauth = oauthConfig ? createAgentPassOAuthProvider(oauthConfig, authorityUrl) : undefined;
const server = oauth
  ? new MCPServer({ ...serverConfig, oauth })
  : new MCPServer(serverConfig);

server.get('/health', (c) => c.json({ status: 'OK' }));

const onboardingProxy = createOnboardingProxy(authorityUrl);
for (const path of ['/onboarding', '/onboarding/*']) server.all(path, c => onboardingProxy(c.req.raw));

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
const onboardingErrorSchema = z.object({
  status: z.enum(['AUTHORITY_REQUIRED', 'DENIED', 'ERROR']),
  code: z.string().min(1),
  reason: z.string().min(1),
  next_action: z.enum(['request_authority', 'retry', 'contact_owner']).optional(),
  required_scope: scopeSchema.optional(),
}).passthrough();
const onboardingOutput = <T extends z.ZodType>(data: T) => z.union([
  z.object({ status: z.literal('OK'), data }).strict(),
  onboardingErrorSchema,
]);
function onboardingResult<T extends z.ZodType>(value: unknown, schema: T): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: z.output<T>;
} {
  const parsed = schema.safeParse(value);
  const fallback = {
    status: 'ERROR' as const,
    code: 'SERVICE_UNAVAILABLE',
    reason: 'Authority onboarding response did not match its contract.',
    next_action: 'retry' as const,
  };
  const result = (parsed.success ? parsed.data : schema.parse(fallback)) as z.output<T>;
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
}
function consentLink(connectionId: string) {
  if (!process.env.MCP_PUBLIC_URL) return undefined;
  try {
    const endpoint = new URL(process.env.MCP_PUBLIC_URL);
    const localHttp = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if ((endpoint.protocol !== 'https:' && !localHttp) || endpoint.pathname !== '/mcp' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined;
    const link = new URL('/onboarding', endpoint);
    link.searchParams.set('connection', connectionId);
    return link.href;
  } catch {
    return undefined;
  }
}

export const describeAuthority = server.tool({
  name: 'describe_authority', description: 'Describe supported actions, scope limits and repair tools.',
  inputSchema: z.object({}).strict(), outputSchema: envelopeSchema, annotations: readOnly,
}, async () => toolResult({ status: 'OK', data: {
  actions: ACTIONS,
  scope_limits: ['actions', 'supplier_ids', 'sku_ids', 'max_per_action_cents', 'total_budget_cents', 'expires_at', 'max_delegation_depth', 'resources', 'max_executions'],
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

const contextOutput = onboardingOutput(onboardingSchemas.context_data);
export const getOnboardingContext = server.tool({
  name: 'get_onboarding_context', description: 'Inspect the authenticated human connection, organization and consent state. It never creates authority.',
  inputSchema: onboardingSchemas.context_request, outputSchema: contextOutput, annotations: readOnly,
}, async (_input, ctx) => {
  const result = onboardingResult(await authority(ctx)('GET', 'v1/onboarding/context'), contextOutput);
  const data = result.structuredContent;
  if (data.status !== 'OK' || data.data.connection.state !== 'CONSENT_REQUIRED') return result;
  const link = consentLink(data.data.connection.id);
  if (!link) return result;
  return { ...result, content: [...result.content, { type: 'text' as const, text: `Trusted owner consent is required before this connection can create agents. Review the bounded simulated authority here: ${link}` }] };
});

const agentOutput = onboardingOutput(onboardingSchemas.agent_data);
export const provisionAgent = server.tool({
  name: 'provision_agent', description: 'Request a narrowly scoped child agent under the authenticated, consented connection. Provisioning uses the trusted runtime and never accepts credentials or organization identity from the model.',
  inputSchema: onboardingSchemas.provision_request, outputSchema: agentOutput, annotations: write,
}, async (input, ctx) => onboardingResult(await authority(ctx)('POST', 'v1/agents', input), agentOutput));

const agentListOutput = onboardingOutput(onboardingSchemas.list_data);
export const listAgents = server.tool({
  name: 'list_agents', description: 'List agents belonging only to the authenticated connection.',
  inputSchema: onboardingSchemas.list_request, outputSchema: agentListOutput, annotations: readOnly,
}, async (input, ctx) => {
  const query = new URLSearchParams();
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  const suffix = query.toString();
  return onboardingResult(await authority(ctx)('GET', `v1/agents${suffix ? `?${suffix}` : ''}`), agentListOutput);
});

const getAgentInput = onboardingSchemas.get_request;
export const getAgent = server.tool({
  name: 'get_agent', description: 'Inspect one agent owned by the authenticated connection.',
  inputSchema: getAgentInput, outputSchema: agentOutput, annotations: readOnly,
}, async ({ agent_id }, ctx) => onboardingResult(await authority(ctx)('GET', `v1/agents/${encodeURIComponent(agent_id)}`), agentOutput));

const revokeAgentInput = onboardingSchemas.revoke_agent_request;
export const revokeAgent = server.tool({
  name: 'revoke_agent', description: 'Stop one agent and revoke its delegated authority.',
  inputSchema: revokeAgentInput, outputSchema: agentOutput, annotations: { ...write, destructiveHint: true },
}, async ({ agent_id, ...body }, ctx) => onboardingResult(await authority(ctx)('POST', `v1/agents/${encodeURIComponent(agent_id)}/revoke`, body), agentOutput));

const revokeConnectionOutput = onboardingOutput(onboardingSchemas.revoke_connection_data);
export const revokeConnection = server.tool({
  name: 'revoke_connection', description: 'Revoke this authenticated assistant connection and its authority.',
  inputSchema: onboardingSchemas.revoke_connection_request, outputSchema: revokeConnectionOutput, annotations: { ...write, destructiveHint: true },
}, async (input, ctx) => onboardingResult(await authority(ctx)('POST', 'v1/onboarding/connection/revoke', input), revokeConnectionOutput));

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
  name: 'execute_action', description: 'Request a trusted supplier quote, execute a simulated purchase, or run an authorized workforce action.',
  inputSchema: z.union([z.object({ grant_id: id, action: z.enum(SUPPLIER_ACTIONS), supplier_id: id, sku_id: id, quantity: z.number().int().positive().optional(), quote_id: id.optional(), idempotency_key: id }).strict(), workforceActionSchema]),
  outputSchema: envelopeSchema, annotations: write,
}, async (input, ctx) => toolResult(await authority(ctx)('POST', 'v1/actions/execute', input)));

export const verifyAuthority = server.tool({
  name: 'verify_authority', description: 'Check whether the authenticated caller may perform a workforce action. The decision cannot authorize later execution.',
  inputSchema: workforceActionSchema, outputSchema: envelopeSchema, annotations: readOnly,
}, async (input, ctx) => toolResult(await authority(ctx)('POST', 'v1/actions/verify', input)));

export const revokeAuthority = server.tool({
  name: 'revoke_authority', description: 'Revoke authority as its issuer or organization owner.',
  inputSchema: z.object({ grant_id: id, reason: id }).strict(), outputSchema: envelopeSchema,
  annotations: { ...write, destructiveHint: true },
}, async ({ grant_id, ...body }, ctx) => toolResult(await authority(ctx)('POST', `v1/grants/${encodeURIComponent(grant_id)}/revoke`, body)));

export default server;

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import type { AgentAction, AuthorityScope } from '../../../packages/contracts/src/index.js';

const ACTIONS = [
  'supplier.quote.request',
  'supplier.purchase.execute',
  'supplier.margin.read',
] as const satisfies readonly AgentAction[];

const scopeSchema = z.object({
  actions: z.array(z.enum(ACTIONS)),
  supplier_ids: z.array(z.string().min(1)),
  sku_ids: z.array(z.string().min(1)),
  max_per_action_cents: z.number().int().nonnegative(),
  total_budget_cents: z.number().int().nonnegative(),
  expires_at: z.iso.datetime({ offset: true }),
  max_delegation_depth: z.number().int().nonnegative(),
}).strict();

const errorSchema = z.object({
  status: z.enum(['AUTHORITY_REQUIRED', 'DENIED', 'ERROR']),
  code: z.string().min(1),
  reason: z.string().min(1),
  next_action: z.enum(['request_authority', 'retry', 'contact_owner']).optional(),
  required_scope: scopeSchema.optional(),
}).passthrough();

const successSchema = z.object({
  status: z.literal('OK'),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

const envelopeSchema = z.union([successSchema, errorSchema]);
type Envelope = z.infer<typeof envelopeSchema>;
type Config = { authorityUrl: string; agentApiKey: string; runId?: string };

const invalidCaller = (reason: string): Envelope => ({
  status: 'DENIED',
  code: 'INVALID_CALLER',
  reason,
});

const serviceUnavailable = (reason: string): Envelope => ({
  status: 'ERROR',
  code: 'SERVICE_UNAVAILABLE',
  reason,
  next_action: 'retry',
});

function configuredBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('AUTHORITY_URL must be an HTTP(S) service URL without credentials, query, or fragment.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

function toolResult(value: Envelope) {
  const structuredContent = value as unknown as Record<string, unknown>;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

function createAuthorityClient(config: Config) {
  const baseUrl = configuredBaseUrl(config.authorityUrl);

  return async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Envelope> => {
    let response: Response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: `Bearer ${config.agentApiKey}`,
          ...(config.runId ? {'x-agentpass-run-id':config.runId} : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return serviceUnavailable('Could not reach the authority service.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const parsed = envelopeSchema.safeParse(payload);
    if (parsed.success) {
      if (!response.ok && parsed.data.status === 'OK') {
        return serviceUnavailable(`Authority service returned HTTP ${response.status}.`);
      }
      return parsed.data;
    }

    if (response.status === 401) return invalidCaller('Authority service rejected the configured agent credentials.');
    if (response.status === 403) return invalidCaller('Authority service rejected this principal for the requested operation.');
    if (response.status >= 400 && response.status < 500) {
      return { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Authority service rejected the request.' };
    }
    return serviceUnavailable('Authority service returned an invalid response.');
  };
}

export function createMcpServer(config: Config): McpServer {
  if (!config.agentApiKey.trim()) throw new Error('AGENT_API_KEY is required.');
  const callAuthority = createAuthorityClient(config);
  const server = new McpServer({ name: 'agentpass', version: '1.0.0' });

  server.registerTool('describe_authority', {
    description: 'Describe supported AgentPass actions, scope limits, and recovery tools.',
    inputSchema: z.object({}).strict(),
  }, async () => toolResult({
    status: 'OK',
    data: {
      actions: ACTIONS,
      scope_limits: ['actions', 'supplier_ids', 'sku_ids', 'max_per_action_cents', 'total_budget_cents', 'expires_at', 'max_delegation_depth'],
      recovery_tools: ['request_authority', 'get_authority_request', 'accept_authority_offer'],
    },
  }));

  server.registerTool('list_runs',{description:'List persisted runs visible to this authenticated caller.',inputSchema:z.object({}).strict()},async()=>toolResult(await callAuthority('GET','v1/runs')));
  server.registerTool('get_run',{description:'Read caller-visible run events, current grant/request snapshots and simulated receipts. A run ID never grants access.',inputSchema:z.object({run_id:z.string().regex(/^run-[a-zA-Z0-9_-]{1,80}$/)}).strict()},async({run_id})=>toolResult(await callAuthority('GET',`v1/runs/${encodeURIComponent(run_id)}`)));

  server.registerTool('get_my_grants', {
    description: 'Return grants belonging to the authenticated caller.',
    inputSchema: z.object({}).strict(),
  }, async () => {
    const result = await callAuthority('GET', 'v1/me');
    if (result.status !== 'OK') return toolResult(result);
    const grants = result.data.grants;
    if (!Array.isArray(grants)) return toolResult(serviceUnavailable('Authority service did not return the caller grant list.'));
    return toolResult({ status: 'OK', data: { grants } });
  });

  server.registerTool('request_authority', {
    description: 'Request a scoped authority grant from the authenticated caller’s parent grant.',
    inputSchema: z.object({
      parent_grant_id: z.string().min(1),
      requested_scope: scopeSchema,
      reason: z.string().min(1),
    }).strict(),
  }, async ({ parent_grant_id, requested_scope, reason }) => toolResult(await callAuthority(
    'POST', 'v1/authority/requests', { parent_grant_id, requested_scope, reason },
  )));

  server.registerTool('get_authority_request', {
    description: 'Read an authority request visible to the authenticated caller.',
    inputSchema: z.object({ request_id: z.string().min(1) }).strict(),
  }, async ({ request_id }) => toolResult(await callAuthority(
    'GET', `v1/authority/requests/${encodeURIComponent(request_id)}`,
  )));

  server.registerTool('respond_authority_request', {
    description: 'Counteroffer or reject a child authority request as its authorized parent.',
    inputSchema: z.object({
      request_id: z.string().min(1),
      decision: z.enum(['COUNTEROFFER', 'REJECT']),
      offered_scope: scopeSchema.optional(),
    }).strict(),
  }, async ({ request_id, decision, offered_scope }) => toolResult(await callAuthority(
    'POST', `v1/authority/requests/${encodeURIComponent(request_id)}/respond`, {
      decision,
      ...(offered_scope === undefined ? {} : { offered_scope }),
    },
  )));

  server.registerTool('accept_authority_offer', {
    description: 'Accept a counteroffer for the authenticated requesting child.',
    inputSchema: z.object({
      request_id: z.string().min(1),
      idempotency_key: z.string().min(1),
    }).strict(),
  }, async ({ request_id, idempotency_key }) => toolResult(await callAuthority(
    'POST', `v1/authority/requests/${encodeURIComponent(request_id)}/accept`, { idempotency_key },
  )));

  server.registerTool('provision_child', {
    description:'Create a distinct AGENT/SERVICE child and a subset grant as the authenticated parent. The runtime generates and keeps the secret; supply only its SHA-256 verifier. Reuse identical input and idempotency key on retry.',
    inputSchema:z.object({parent_grant_id:z.string().min(1),scope:scopeSchema,credential_hash:z.string().regex(/^[a-f0-9]{64}$/),idempotency_key:z.string().min(1)}).strict(),
  },async ({parent_grant_id,...body}) => toolResult(await callAuthority('POST',`v1/grants/${encodeURIComponent(parent_grant_id)}/provision-child`,body)));

  server.registerTool('delegate_authority', {
    description: 'Delegate a strict subset of an existing grant to a recipient principal.',
    inputSchema: z.object({
      parent_grant_id: z.string().min(1),
      recipient_principal_id: z.string().min(1),
      scope: scopeSchema,
    }).strict(),
  }, async ({ parent_grant_id, recipient_principal_id, scope }) => toolResult(await callAuthority(
    'POST', `v1/grants/${encodeURIComponent(parent_grant_id)}/delegate`, { recipient_principal_id, scope },
  )));

  server.registerTool('execute_action', {
    description: 'Request a supplier quote or execute a simulated purchase within the authenticated caller’s grant.',
    inputSchema: z.object({
      grant_id: z.string().min(1),
      action: z.enum(ACTIONS),
      supplier_id: z.string().min(1),
      sku_id: z.string().min(1),
      quantity: z.number().int().positive().optional(),
      quote_id: z.string().min(1).optional(),
      idempotency_key: z.string().min(1),
    }).strict(),
  }, async (input) => toolResult(await callAuthority('POST', 'v1/actions/execute', input)));

  server.registerTool('revoke_authority', {
    description: 'Revoke a grant as its authorized issuer or owner.',
    inputSchema: z.object({
      grant_id: z.string().min(1),
      reason: z.string().min(1),
    }).strict(),
  }, async ({ grant_id, reason }) => toolResult(await callAuthority(
    'POST', `v1/grants/${encodeURIComponent(grant_id)}/revoke`, { reason },
  )));

  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const authorityUrl = process.env.AUTHORITY_URL;
  const agentApiKey = process.env.AGENT_API_KEY;
  if (!authorityUrl || !agentApiKey) {
    console.error('AUTHORITY_URL and AGENT_API_KEY are required.');
    process.exitCode = 1;
  } else {
    try {
      serveStdio(() => createMcpServer({ authorityUrl, agentApiKey, runId:process.env.AGENTPASS_RUN_ID }), {
        onerror: () => console.error('AgentPass MCP transport error.'),
      });
    } catch {
      console.error('AgentPass MCP server configuration is invalid.');
      process.exitCode = 1;
    }
  }
}

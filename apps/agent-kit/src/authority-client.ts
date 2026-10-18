/**
 * How an agent reaches AgentPass: only through the MCP tools, authenticated
 * by the agent's own key (stdio env or HTTP bearer). The key is never a tool
 * argument and never leaves this module. Every call is reported to `onCall`
 * so runners can print a real trace.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type {
  AgentAction, ApiError, ApiResult, AuthorityRequest, AuthorityScope, Grant, PurchaseReceipt, SupplierQuote,
} from '../../../packages/contracts/src/index.js';

export type AuthorityConnection =
  | { kind: 'stdio'; authorityUrl: string; agentApiKey: string; cwd?: string }
  | { kind: 'http'; mcpUrl: string; agentApiKey: string };

export interface CallRecord {
  at: string;
  principal: string;
  tool: string;
  args: Record<string, unknown>;
  result: ApiResult<unknown>;
  ms: number;
}

export interface ExecuteInput {
  grant_id: string;
  action: AgentAction;
  supplier_id: string;
  sku_id: string;
  quantity?: number;
  quote_id?: string;
  idempotency_key: string;
}

export interface AuthorityClient {
  readonly label: string;
  describeAuthority(): Promise<ApiResult<Record<string, unknown>>>;
  getMyGrants(): Promise<ApiResult<{ grants: Grant[] }>>;
  requestAuthority(input: { parent_grant_id: string; requested_scope: AuthorityScope; reason: string }): Promise<ApiResult<{ request_id: string; status: string }>>;
  getAuthorityRequest(requestId: string): Promise<ApiResult<AuthorityRequest>>;
  respondAuthorityRequest(input: { request_id: string; decision: 'COUNTEROFFER' | 'REJECT'; offered_scope?: AuthorityScope }): Promise<ApiResult<AuthorityRequest>>;
  acceptAuthorityOffer(input: { request_id: string; idempotency_key: string }): Promise<ApiResult<Grant>>;
  delegateAuthority(input: { parent_grant_id: string; recipient_principal_id: string; scope: AuthorityScope }): Promise<ApiResult<Grant>>;
  executeAction(input: ExecuteInput): Promise<ApiResult<SupplierQuote | PurchaseReceipt>>;
  revokeAuthority(input: { grant_id: string; reason: string }): Promise<ApiResult<{ grant_id: string; revoked_at: string }>>;
  /** Developer A's provision_child: a new child identity + subset grant; only the secret's SHA-256 is sent. */
  provisionChild(input: { parent_grant_id: string; scope: AuthorityScope; credential_hash: string; idempotency_key: string }): Promise<ApiResult<{ principal: { id: string }; grant: Grant }>>;
  close(): Promise<void>;
}

export function isError(result: ApiResult<unknown>): result is ApiError {
  return result.status !== 'OK';
}

/** Connects to the AgentPass MCP server as one principal. `label` is for traces only, never identity. */
export async function connectAuthority(
  connection: AuthorityConnection,
  opts: { label: string; onCall?: (record: CallRecord) => void },
): Promise<AuthorityClient> {
  const client = new Client({ name: `agentpass-${opts.label}`, version: '1.0.0' });
  const transport = connection.kind === 'stdio'
    ? new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'apps/mcp/src/server.ts'],
      cwd: connection.cwd ?? process.cwd(),
      // Only this agent's own key is passed to its MCP process.
      env: { PATH: process.env.PATH ?? '', AUTHORITY_URL: connection.authorityUrl, AGENT_API_KEY: connection.agentApiKey },
      stderr: 'pipe',
    })
    : new StreamableHTTPClientTransport(new URL(connection.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${connection.agentApiKey}` } },
    });
  await client.connect(transport);

  async function call<T>(tool: string, args: Record<string, unknown>): Promise<ApiResult<T>> {
    const started = Date.now();
    let result: ApiResult<T>;
    try {
      const response = await client.callTool({ name: tool, arguments: args });
      result = (response.structuredContent ?? parseText(response.content)) as ApiResult<T>;
      if ((!result || typeof result !== 'object' || !('status' in result)) && response.isError) {
        // The MCP server rejected the arguments themselves (schema validation).
        result = { status: 'ERROR', code: 'INVALID_REQUEST', reason: rawText(response.content).slice(0, 300) || 'Tool rejected the arguments' };
      } else if (!result || typeof result !== 'object' || !('status' in result)) {
        result = { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'Malformed tool result', next_action: 'retry' };
      }
    } catch (error) {
      result = { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: `MCP call failed: ${(error as Error).message}`, next_action: 'retry' };
    }
    opts.onCall?.({ at: new Date(started).toISOString(), principal: opts.label, tool, args, result, ms: Date.now() - started });
    return result;
  }

  return {
    label: opts.label,
    describeAuthority: () => call('describe_authority', {}),
    getMyGrants: () => call('get_my_grants', {}),
    requestAuthority: (input) => call('request_authority', input),
    getAuthorityRequest: (request_id) => call('get_authority_request', { request_id }),
    respondAuthorityRequest: (input) => call('respond_authority_request', input),
    acceptAuthorityOffer: (input) => call('accept_authority_offer', input),
    delegateAuthority: (input) => call('delegate_authority', input),
    executeAction: (input) => call('execute_action', { ...input }),
    revokeAuthority: (input) => call('revoke_authority', input),
    provisionChild: (input) => call('provision_child', input),
    close: () => client.close(),
  };
}

function rawText(content: unknown): string {
  const first = Array.isArray(content) ? content[0] : undefined;
  return first && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string' ? (first as { text: string }).text : '';
}

function parseText(content: unknown): unknown {
  const first = Array.isArray(content) ? content[0] : undefined;
  if (first && typeof first === 'object' && (first as { type?: string }).type === 'text') {
    try { return JSON.parse((first as { text: string }).text); } catch { return undefined; }
  }
  return undefined;
}

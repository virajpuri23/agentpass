/**
 * Shared agent-process runtime: connect to AgentPass with this process's own
 * key from env, and stream trace events to the launcher.
 */
import { readFileSync, rmSync } from 'node:fs';
import { connectAuthority, type AuthorityClient, type CallRecord } from './authority-client.js';
import type { AgentMessageTransport, TraceEvent } from './transport.js';

export interface AgentContext {
  name: string;
  authority: AuthorityClient;
  link: AgentMessageTransport;
  note(text: string, decider?: 'deterministic' | 'llm'): void;
}

let traceSeq = 0;

export function traceSink(name: string, link: AgentMessageTransport) {
  const emit = (event: TraceEvent) => void link.send('launcher', { type: 'TRACE', event }, `trace-${name}-${++traceSeq}`);
  return {
    onCall(r: CallRecord) {
      emit({
        kind: 'call', at: r.at, agent: name, tool: r.tool, args: r.args, status: r.result.status, ms: r.ms,
        ...(r.result.status === 'OK' ? { data: r.result.data } : { code: r.result.code, data: r.result }),
      });
    },
    note(text: string, decider?: 'deterministic' | 'llm') {
      emit({ kind: 'note', at: new Date().toISOString(), agent: name, text, ...(decider ? { decider } : {}) });
    },
  };
}

/** Builds the agent context from env: AGENT_API_KEY plus AUTHORITY_URL (stdio MCP) or AGENTPASS_MCP_URL (HTTP MCP). */
export async function agentFromEnv(name: string, link: AgentMessageTransport): Promise<AgentContext> {
  // A provisioned child reads its own secret from a private file its parent runtime created.
  const credentialFile = process.env.AGENT_CREDENTIAL_FILE;
  let agentApiKey = process.env.AGENT_API_KEY;
  if (credentialFile) {
    agentApiKey = (JSON.parse(readFileSync(credentialFile, 'utf8')) as { secret: string }).secret;
    rmSync(credentialFile, { force: true });
    delete process.env.AGENT_CREDENTIAL_FILE;
  }
  if (!agentApiKey) throw new Error('AGENT_API_KEY or AGENT_CREDENTIAL_FILE is required');
  const sink = traceSink(name, link);
  const mcpUrl = process.env.AGENTPASS_MCP_URL;
  const authorityUrl = process.env.AUTHORITY_URL;
  if (!mcpUrl && !authorityUrl) throw new Error('AGENTPASS_MCP_URL or AUTHORITY_URL is required');
  const authority = await connectAuthority(
    mcpUrl ? { kind: 'http', mcpUrl, agentApiKey } : { kind: 'stdio', authorityUrl: authorityUrl!, agentApiKey },
    { label: name, onCall: sink.onCall },
  );
  delete process.env.AGENT_API_KEY; // nothing else in this process needs it
  return { name, authority, link, note: sink.note };
}

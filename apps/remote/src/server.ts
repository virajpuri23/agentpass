/**
 * Hosted entry point (Manufact): one public port serving
 *   GET  /health  - liveness for the platform health check
 *   ALL  /mcp     - AgentPass MCP tools over streamable HTTP
 *
 * The authority API runs in-process on loopback only. Each MCP request is
 * bound to the principal whose key arrives in `Authorization: Bearer <key>`;
 * the key is checked against the authority before any MCP server is built,
 * and tool arguments can never select an identity.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { HttpSupplierService } from '../../authority/src/supplier.js';
import { createMcpServer } from '../../mcp/src/server.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const authorityPort = Number(process.env.AUTHORITY_PORT ?? 4100);
const authorityUrl = `http://127.0.0.1:${authorityPort}`;

// Hosted storage is ephemeral; seeding is idempotent and runs on every start.
const db = openDatabase(process.env.AUTHORITY_DB_PATH ?? '/tmp/authority.sqlite');
seedDatabase(db, {
  'owner-1': required('OWNER_API_KEY'),
  'buyer-agent': required('BUYER_API_KEY'),
  'sourcing-agent': required('SOURCING_API_KEY'),
  'supplier-agent': required('SUPPLIER_API_KEY'),
});
const supplier = new HttpSupplierService(
  process.env.SUPPLIER_URL ?? 'http://127.0.0.1:4200',
  required('SUPPLIER_SERVICE_KEY'),
);
const authority = createAuthorityApp({ db, supplier }).listen(authorityPort, '127.0.0.1');

const mcp = createMcpHandler(({ requestInfo }) => {
  const agentApiKey = bearer(requestInfo?.headers.get('authorization'));
  if (!agentApiKey) throw new Error('Unauthenticated MCP request reached the server factory.');
  return createMcpServer({ authorityUrl, agentApiKey });
}, { onerror: () => console.error('AgentPass MCP request error.') });

function bearer(header: string | null | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

async function isKnownAgent(key: string): Promise<boolean> {
  const res = await fetch(`${authorityUrl}/v1/me`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  return res.ok;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit);
}

async function sendWebResponse(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health') {
      db.prepare('SELECT 1').get();
      return json(res, 200, { status: 'OK' });
    }
    if (path !== '/mcp') return json(res, 404, { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Not found' });

    const key = bearer(req.headers.authorization);
    if (!key || !(await isKnownAgent(key))) {
      return json(res, 401, {
        status: 'DENIED',
        code: 'INVALID_CALLER',
        reason: 'Send this agent\'s AgentPass key as Authorization: Bearer <key>.',
      }, { 'www-authenticate': 'Bearer realm="agentpass"' });
    }
    await sendWebResponse(res, await mcp.fetch(toWebRequest(req)));
  } catch {
    if (!res.headersSent) json(res, 503, { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'Request failed', next_action: 'retry' });
    else res.end();
  }
});

server.listen(port, host, () => console.log(JSON.stringify({ service: 'agentpass-remote', port, mcp: '/mcp', simulated: true })));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    authority.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

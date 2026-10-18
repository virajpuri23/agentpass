/**
 * Live activity view for the judge demo (docs/06-DEVELOPER-B.md B4).
 * Streams the real DemoEvents of a run (local or hosted) over SSE, or replays
 * a recorded run from docs/evidence, clearly labeled as a recording.
 * Loopback only; never serves keys, and every event comes from real calls.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedStack, isolatedStack, viaHttpMcp, type DemoStack } from '../../../scripts/demo-stack.js';
import type { TraceEvent } from '../../agent-kit/src/transport.js';
import { runDemo, type Check, type DemoEvent } from '../../../scripts/run-e2e.js';
import { runDemo as runWorkforceDemo, type WorkforceStreamEvent } from '../../../scripts/run-workforce.js';

type Mode = 'local' | 'local-http' | 'hosted';
type AnyEvent = DemoEvent | WorkforceStreamEvent;
type Envelope = { seq: number; run: number; recorded: boolean; event: AnyEvent };

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const EVIDENCE = fileURLToPath(new URL('../../../docs/evidence/', import.meta.url));
const port = Number(process.env.ACTIVITY_PORT ?? 3200);

let runId = 0;
let running = false;
let buffer: Envelope[] = [];
const clients = new Set<ServerResponse>();

function publish(event: AnyEvent, recorded: boolean) {
  const env: Envelope = { seq: buffer.length, run: runId, recorded, event };
  buffer.push(env);
  const frame = `data: ${JSON.stringify(env)}\n\n`;
  for (const res of clients) res.write(frame);
}

function startRun(label: string) {
  runId += 1;
  buffer = [];
  running = true;
  for (const res of clients) res.write(`event: reset\ndata: ${JSON.stringify({ run: runId, label })}\n\n`);
}

async function stackFor(mode: Mode): Promise<DemoStack> {
  if (mode === 'hosted') return hostedStack();
  const local = await isolatedStack();
  return mode === 'local-http' ? viaHttpMcp(local) : local;
}

/** The coding-agent workforce demo (lead + 4 specialists) on a fresh project copy. */
async function runWorkforce(authority: 'agentpass' | 'mock') {
  startRun(`workforce · ${authority}`);
  try {
    await runWorkforceDemo({ authority, onStream: (e) => publish(e, false) });
  } catch (error) {
    publish({ type: 'trace', at: new Date().toISOString(), agent: 'runner', kind: 'denied', text: `Run failed: ${(error as Error).message}` }, false);
    publish({ type: 'done', passed: false }, false);
  } finally {
    running = false;
  }
}

async function run(mode: Mode) {
  startRun(mode);
  let stack: DemoStack | undefined;
  try {
    stack = await stackFor(mode);
    await runDemo({ stack, onEvent: (e) => publish(e, false) });
  } catch (error) {
    publish({ type: 'runner', at: new Date().toISOString(), text: `Run failed: ${(error as Error).message}` }, false);
    publish({ type: 'done', passed: false }, false);
  } finally {
    await stack?.stop().catch(() => {});
    running = false;
  }
}

function recordings() {
  return readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).sort().reverse();
}

/** Replays a recorded run at its original pace (capped), labeled as recorded. */
async function replay(file: string) {
  if (!recordings().includes(file)) throw new Error('Unknown recording');
  const data = JSON.parse(readFileSync(join(EVIDENCE, file), 'utf8')) as { trace: TraceEvent[]; checks: Check[]; passed: boolean };
  startRun(`recording ${file}`);
  publish({ type: 'meta', mode: 'hosted', mcp: `recorded: ${file}`, root: '', decider: 'deterministic' }, true);
  let last: number | undefined;
  for (const event of data.trace) {
    const t = Date.parse(event.at);
    if (last !== undefined) await new Promise((r) => setTimeout(r, Math.min(Math.max(t - last!, 0), 900)));
    last = t;
    publish({ type: 'trace', event }, true);
  }
  for (const check of data.checks) publish({ type: 'check', check }, true);
  publish({ type: 'done', passed: data.passed }, true);
  running = false;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw new Error('Body too large'); }
  return raw ? JSON.parse(raw) : {};
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: reset\ndata: ${JSON.stringify({ run: runId, label: 'current' })}\n\n`);
      for (const env of buffer) res.write(`data: ${JSON.stringify(env)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, {
        running, run: runId, recordings: recordings(),
        hostedConfigured: Boolean(process.env.HOSTED_MCP_URL && process.env.HOSTED_BUYER_API_KEY && process.env.HOSTED_SOURCING_API_KEY),
        hostedRoot: process.env.HOSTED_ROOT_GRANT_ID ?? null,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/workforce/run') {
      if (running) return json(res, 409, { status: 'ERROR', code: 'BUSY', reason: 'A run is already in progress' });
      const input = await body(req).catch(() => ({}));
      running = true;
      void runWorkforce(input.authority === 'mock' ? 'mock' : 'agentpass');
      return json(res, 202, { status: 'OK', run: runId + 1 });
    }
    if (req.method === 'POST' && (url.pathname === '/api/run' || url.pathname === '/api/replay')) {
      if (running) return json(res, 409, { status: 'ERROR', code: 'BUSY', reason: 'A run is already in progress' });
      const input = await body(req);
      if (url.pathname === '/api/run') {
        const mode = input.mode as Mode;
        if (!['local', 'local-http', 'hosted'].includes(mode)) return json(res, 400, { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'mode must be local, local-http or hosted' });
        running = true;
        void run(mode);
      } else {
        running = true;
        void replay(String(input.file)).catch((e) => { running = false; publish({ type: 'runner', at: new Date().toISOString(), text: `Replay failed: ${e.message}` }, true); });
      }
      return json(res, 202, { status: 'OK', run: runId });
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-z0-9-]+\.(html|js|css)$/.test(file)) return json(res, 404, { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Not found' });
      res.writeHead(200, { 'content-type': TYPES[extname(file)]!, 'cache-control': 'no-store' }).end(readFileSync(join(PUBLIC, file)));
      return;
    }
    json(res, 404, { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Not found' });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: (error as Error).message });
  }
});

// Loopback only, on both IPv4 and IPv6: browsers may resolve `localhost` to ::1 first, which a 127.0.0.1-only bind refuses.
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ service: 'activity', url: `http://127.0.0.1:${port}` })));
const server6 = createServer(server.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void);
server6.on('error', () => { /* no IPv6 loopback on this host: IPv4 is enough */ });
server6.listen(port, '::1');

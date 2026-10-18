/**
 * Entry point: `node --import tsx apps/workforce/src/gateway-main.ts`
 *
 * Environment:
 *   WORKFORCE_SERVICE_KEY      shared secret AgentPass presents as X-Service-Key (required)
 *   WORKFORCE_REPO_ROOT        the project the gateway operates on; realpath'd (required)
 *   WORKFORCE_ANALYTICS_FILE   events dataset (default <root>/data/analytics-events.json)
 *   WORKFORCE_ORG              organization the resource belongs to (default buyer-co)
 *   WORKFORCE_OWNER            owner principal of the resource (default owner-1)
 *   PORT                       listen port (default 4300; 0 picks a free port)
 *   WORKFORCE_HOST             bind address (default 0.0.0.0 so a hosted platform can route to it)
 *
 * When forked with an IPC channel (the local demo does this) the chosen port is
 * reported to the parent as `{type:'listening', port}`.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGatewayService } from './gateway-service.js';

const serviceKey = process.env.WORKFORCE_SERVICE_KEY;
if (!serviceKey) throw new Error('WORKFORCE_SERVICE_KEY is required');
if (!process.env.WORKFORCE_REPO_ROOT) throw new Error('WORKFORCE_REPO_ROOT is required');
const repoRoot = realpathSync(process.env.WORKFORCE_REPO_ROOT);
const port = Number(process.env.PORT ?? 4300);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
const host = process.env.WORKFORCE_HOST ?? '0.0.0.0';

const service = createGatewayService({
  serviceKey, repoRoot,
  analyticsFile: process.env.WORKFORCE_ANALYTICS_FILE ?? join(repoRoot, 'data/analytics-events.json'),
  organization_id: process.env.WORKFORCE_ORG ?? 'buyer-co',
  owner_principal_id: process.env.WORKFORCE_OWNER ?? 'owner-1',
});

const server = service.app.listen(port, host, () => {
  const bound = (server.address() as AddressInfo).port;
  console.log(JSON.stringify({ service: 'workforce-gateway', port: bound, resource: service.adapter.resource, dedup: 'in-memory (process lifetime)' }));
  process.send?.({ type: 'listening', port: bound });
});
let stopping = false;
const shutdown = () => {
  if (stopping) return; stopping = true;
  server.close(() => void service.stop().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
process.on('message', (m) => { if ((m as { type?: string })?.type === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);

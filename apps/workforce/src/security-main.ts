/**
 * Entry point: `node --import tsx apps/workforce/src/security-main.ts`
 *
 * Environment (and nothing else is needed; see `securityServiceEnv` in processes.ts):
 *   SECURITY_CREDENTIAL      the security agent's own AgentPass credential (required)
 *   SECURITY_TASK_TOKEN      per-task token the lead must present as X-Task-Token (required)
 *   SECURITY_REPO_ROOT       project root for directory listings (reads go through AgentPass) (required)
 *   SECURITY_ANALYTICS_FILE  unused by the auditor; defaults under the root
 *   SECURITY_AUTHORITY_URL   when set, requests must name exactly this authority
 *   PORT                     listen port (default 4310; 0 picks a free port)
 *   SECURITY_HOST            bind address (default 127.0.0.1)
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSecurityService } from './security-service.js';

const credential = process.env.SECURITY_CREDENTIAL;
const taskToken = process.env.SECURITY_TASK_TOKEN;
if (!credential) throw new Error('SECURITY_CREDENTIAL is required');
if (!taskToken) throw new Error('SECURITY_TASK_TOKEN is required');
if (!process.env.SECURITY_REPO_ROOT) throw new Error('SECURITY_REPO_ROOT is required');
const repoRoot = realpathSync(process.env.SECURITY_REPO_ROOT);
const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');

const { app } = createSecurityService({
  credential, taskToken, repoRoot,
  analyticsFile: process.env.SECURITY_ANALYTICS_FILE ?? join(repoRoot, 'data/analytics-events.json'),
  authorityUrl: process.env.SECURITY_AUTHORITY_URL,
});
const server = app.listen(port, process.env.SECURITY_HOST ?? '127.0.0.1', () => {
  const bound = (server.address() as AddressInfo).port;
  console.log(JSON.stringify({ service: 'security-agent', port: bound, holds: ['SECURITY_CREDENTIAL'] }));
  process.send?.({ type: 'listening', port: bound });
});
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
process.on('message', (m) => { if ((m as { type?: string })?.type === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);

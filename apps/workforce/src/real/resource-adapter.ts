/**
 * The `demo-project` resource registration for AgentPass (Developer A's
 * workforce contract, docs/11). AgentPass validates the live grant chain,
 * paths and quota, then invokes `execute` with a server-issued execution
 * id; this trusted code performs exactly that operation and returns only
 * public results. It never chooses what to do from model text: the action
 * and parameters arrive already validated against the contract schemas.
 */
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { WorkforceExecutionContext, WorkforceResource } from '../../../authority/src/workforce.js';
import { openWorkforceFile } from '../../../authority/src/workforce-paths.js';
import { scanSource } from '../agents/security.js';
import { summarize, type AnalyticsEvent } from '../gateways/analytics.js';
import { buildAndServe, stopServers } from '../gateways/deploy.js';

export const DEMO_RESOURCE = 'demo-project';

/** sha256 over the deployable tree (src/** + package.json), so a deploy names exactly what gets built. */
export function digestOf(root: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else files.push(full);
    }
  };
  walk(join(root, 'src'));
  files.push(join(root, 'package.json'));
  const h = createHash('sha256');
  for (const f of files) { h.update(relative(root, f).split(sep).join('/')); h.update('\0'); h.update(readFileSync(f)); h.update('\0'); }
  return h.digest('hex');
}

export interface DemoResourceOptions {
  repoRoot: string;
  analyticsFile: string;
  organization_id: string;
  owner_principal_id: string;
}

export function createDemoProjectResource(opts: DemoResourceOptions): WorkforceResource & { stop(): Promise<void>; executions(): number } {
  const servers: ChildProcess[] = [];
  const done = new Map<string, Record<string, unknown>>(); // execution_id -> result (AgentPass dedupes too)
  const readText = async (path: string) => {
    const file = await openWorkforceFile(opts.repoRoot, path);
    try { return await file.readFile('utf8'); } finally { await file.close(); }
  };

  async function perform({ input, paths }: WorkforceExecutionContext): Promise<Record<string, unknown>> {
    switch (input.action) {
      case 'repo.read':
        return { path: input.parameters.path, content: await readText(input.parameters.path) };
      case 'repo.write': {
        const file = await openWorkforceFile(opts.repoRoot, input.parameters.path, true);
        try { await file.writeFile(input.parameters.content, 'utf8'); } finally { await file.close(); }
        return { path: input.parameters.path, bytes: Buffer.byteLength(input.parameters.content) };
      }
      case 'security.audit.run': {
        const files: Record<string, string> = {};
        for (const p of paths) files[p] = await readText(p);
        return { scanned_files: Object.keys(files).length, findings: scanSource(files) };
      }
      case 'deploy.preview': {
        const current = digestOf(opts.repoRoot);
        if (current !== input.parameters.artifact_digest) {
          return { deployed: false, reason: 'artifact digest does not match the current tree; re-quote the build' };
        }
        const r = await buildAndServe(opts.repoRoot, servers);
        if (r.status !== 'OK') return { deployed: false, reason: r.reason };
        return { deployed: true, ...r.data, artifact_digest: current };
      }
      case 'deploy.production':
        // Only reachable with owner-level authority, which the demo never issues.
        return { deployed: false, reason: 'this demo has no production target' };
      case 'analytics.aggregate.read': {
        const data = JSON.parse(readFileSync(opts.analyticsFile, 'utf8')) as { dataset: string; events: AnalyticsEvent[] };
        if (input.parameters.metric !== data.dataset) return { error: `unknown dataset ${input.parameters.metric}` };
        return { summary: summarize(data.dataset, data.events) };
      }
      case 'analytics.raw.read': {
        const data = JSON.parse(readFileSync(opts.analyticsFile, 'utf8')) as { events: AnalyticsEvent[] };
        return { events: data.events };
      }
    }
  }

  return {
    resource: DEMO_RESOURCE,
    organization_id: opts.organization_id,
    owner_principal_id: opts.owner_principal_id,
    repo_root: opts.repoRoot,
    allowed_actions: ['repo.read', 'repo.write', 'security.audit.run', 'deploy.preview', 'analytics.aggregate.read'],
    async execute(context) {
      const prior = done.get(context.execution_id);
      if (prior) return prior;
      const result = await perform(context);
      done.set(context.execution_id, result);
      return result;
    },
    executions: () => done.size,
    async stop() { stopServers(servers); },
  };
}

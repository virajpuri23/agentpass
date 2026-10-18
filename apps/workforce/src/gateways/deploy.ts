/**
 * Deploy gateway: builds the project and serves it. `preview` starts a real
 * local server (`next start` on a free port) and returns its URL, labeled
 * local. `production` is accepted by the interface so the authority can
 * refuse it; nothing here ever performs a production deploy.
 *
 * `buildAndServe` is the trusted build step; the mock-mode gateway calls it
 * after authorizing, and the AgentPass resource adapter calls it when the
 * authority invokes the registered `demo-project` resource.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { ApiResult, WorkforceSession } from '../contract.js';

export interface Deployment {
  environment: 'preview';
  url: string;
  /** Honest provenance: this demo serves the built app locally. */
  provider: 'local-next-start';
  pid: number;
  build_log_tail: string[];
}

export interface DeployGateway {
  deploy(session: WorkforceSession, grant_id: string, environment: 'preview' | 'production'): Promise<ApiResult<Deployment>>;
  stopAll(): Promise<void>;
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  s.on('error', reject);
});

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; tail: string[] }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    const keep = (d: Buffer) => { for (const l of String(d).split('\n')) if (l.trim()) lines.push(l.trim()); if (lines.length > 40) lines.splice(0, lines.length - 40); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('close', (code) => resolve({ code, tail: lines }));
  });
}

/** Real `next build` + `next start` on a free loopback port. Started servers are pushed onto `servers` so the caller can stop them. */
export async function buildAndServe(projectRoot: string, servers: ChildProcess[]): Promise<ApiResult<Deployment>> {
  const build = await run('npm', ['run', 'build'], projectRoot);
  if (build.code !== 0) return { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: `Build failed:\n${build.tail.slice(-8).join('\n')}` };
  const port = await freePort();
  const server = spawn('npm', ['start', '--', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: projectRoot, env: { ...process.env }, stdio: 'ignore' });
  servers.push(server);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) {
      return { status: 'OK', data: { environment: 'preview', url, provider: 'local-next-start', pid: server.pid ?? -1, build_log_tail: build.tail.slice(-6) } };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill('SIGTERM');
  return { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'Preview server did not start' };
}

export function stopServers(servers: ChildProcess[]) {
  for (const s of servers.splice(0)) s.kill('SIGTERM');
}

export function createDeployGateway(projectRoot: string): DeployGateway {
  const servers: ChildProcess[] = [];
  return {
    async deploy(session, grant_id, environment) {
      const auth = await session.authorize({ grant_id, action: environment === 'production' ? 'deploy.production' : 'deploy.preview', resource: environment });
      if (auth.status !== 'OK') return auth;
      if (environment === 'production') {
        // Authority said yes only if an owner-level grant was used; the demo still refuses to pretend.
        return { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: 'This demo has no production target; nothing was deployed' };
      }
      return buildAndServe(projectRoot, servers);
    },
    async stopAll() { stopServers(servers); },
  };
}

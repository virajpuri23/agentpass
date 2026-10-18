/**
 * Launchers for the two out-of-process services the demo can run: the
 * protected workforce gateway and the external Security agent. Each child is
 * started with an explicit allow-listed environment, so the lead's credential
 * (or anything else in the parent's environment) never reaches it. The child
 * reports its bound port over IPC.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GATEWAY_ENTRY = fileURLToPath(new URL('./gateway-main.ts', import.meta.url));
export const SECURITY_ENTRY = fileURLToPath(new URL('./security-main.ts', import.meta.url));

/** Only what a Node process needs to start plus the service's own variables. */
const BASE_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'NO_COLOR'] as const;
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return env;
}

export function gatewayServiceEnv(opts: { serviceKey: string; repoRoot: string; analyticsFile?: string; organization_id?: string; owner_principal_id?: string; port?: number; host?: string }): Record<string, string> {
  return {
    ...baseEnv(),
    WORKFORCE_SERVICE_KEY: opts.serviceKey, WORKFORCE_REPO_ROOT: opts.repoRoot,
    ...(opts.analyticsFile ? { WORKFORCE_ANALYTICS_FILE: opts.analyticsFile } : {}),
    ...(opts.organization_id ? { WORKFORCE_ORG: opts.organization_id } : {}),
    ...(opts.owner_principal_id ? { WORKFORCE_OWNER: opts.owner_principal_id } : {}),
    PORT: String(opts.port ?? 0), WORKFORCE_HOST: opts.host ?? '127.0.0.1',
  };
}

export function securityServiceEnv(opts: { credential: string; taskToken: string; repoRoot: string; analyticsFile?: string; authorityUrl?: string; port?: number; host?: string }): Record<string, string> {
  return {
    ...baseEnv(),
    SECURITY_CREDENTIAL: opts.credential, SECURITY_TASK_TOKEN: opts.taskToken, SECURITY_REPO_ROOT: opts.repoRoot,
    ...(opts.analyticsFile ? { SECURITY_ANALYTICS_FILE: opts.analyticsFile } : {}),
    ...(opts.authorityUrl ? { SECURITY_AUTHORITY_URL: opts.authorityUrl } : {}),
    PORT: String(opts.port ?? 0), SECURITY_HOST: opts.host ?? '127.0.0.1',
  };
}

export interface ChildService { child: ChildProcess; port: number; url: string; stop(): Promise<void> }

/** Forks `entry` under tsx with exactly `env`, waits for its `{type:'listening', port}` message. */
export function startChildService(entry: string, env: Record<string, string>, opts: { onLog?: (line: string) => void; timeoutMs?: number } = {}): Promise<ChildService> {
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], { execArgv: ['--import', 'tsx'], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const forward = (stream: NodeJS.ReadableStream | null) => {
      let buf = '';
      stream?.on('data', (chunk: Buffer) => { buf += chunk.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) opts.onLog?.(line); } });
    };
    forward(child.stdout); forward(child.stderr);
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${entry} did not start in time`)); }, opts.timeoutMs ?? 30_000);
    const stop = () => new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', () => done());
      try { child.send({ type: 'shutdown' }); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${entry} exited with ${code}`)); });
    child.on('message', (m) => {
      const msg = m as { type?: string; port?: number };
      if (msg?.type !== 'listening' || typeof msg.port !== 'number') return;
      clearTimeout(timer);
      resolve({ child, port: msg.port, url: `http://127.0.0.1:${msg.port}`, stop });
    });
  });
}

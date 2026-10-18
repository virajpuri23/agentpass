/**
 * Repository gateway: the ONLY way agents read or write project files.
 * Every call is authorized against the caller's grant for the exact path;
 * the gateway never holds a broader credential than the project root.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ApiResult, WorkforceSession } from '../contract.js';

export interface RepoGateway {
  readonly root: string;
  /** Lists files under `dir` (relative). Listing is governed by repo.read on the directory glob. */
  list(session: WorkforceSession, grant_id: string, dir: string): Promise<ApiResult<string[]>>;
  read(session: WorkforceSession, grant_id: string, path: string): Promise<ApiResult<{ path: string; content: string }>>;
  write(session: WorkforceSession, grant_id: string, path: string, content: string): Promise<ApiResult<{ path: string; bytes: number }>>;
}

const IGNORED = new Set(['node_modules', '.next', '.git']);
/** Secrets are never a repo resource, whatever a grant says: defense in depth behind the authority check. */
const SECRET_FILE = /(^|\/)\.env(\.|$)/;

export function createRepoGateway(root: string): RepoGateway {
  const abs = resolve(root);

  /** Normalizes to a root-relative '/' path; rejects escapes. */
  function safe(path: string): string | undefined {
    const target = resolve(abs, path);
    const rel = relative(abs, target);
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return undefined;
    return rel.split(sep).join('/');
  }

  function walk(dir: string, out: string[]) {
    for (const name of readdirSync(dir)) {
      if (IGNORED.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else { const r = relative(abs, full).split(sep).join('/'); if (!SECRET_FILE.test(r)) out.push(r); }
    }
  }

  return {
    root: abs,
    async list(session, grant_id, dir) {
      const rel = safe(dir || '.');
      if (rel === undefined) return { status: 'DENIED', code: 'RESOURCE_DENIED', reason: 'Path escapes the project' };
      const auth = await session.authorize({ grant_id, action: 'repo.read', resource: rel === '' ? '**' : `${rel}/**` });
      if (auth.status !== 'OK') return auth;
      const out: string[] = [];
      const start = join(abs, rel);
      if (!existsSync(start)) return { status: 'OK', data: [] };
      walk(start, out);
      return { status: 'OK', data: out.sort() };
    },
    async read(session, grant_id, path) {
      const rel = safe(path);
      if (rel === undefined) return { status: 'DENIED', code: 'RESOURCE_DENIED', reason: 'Path escapes the project' };
      const auth = await session.authorize({ grant_id, action: 'repo.read', resource: rel });
      if (auth.status !== 'OK') return auth;
      if (SECRET_FILE.test(rel)) return { status: 'DENIED', code: 'RESOURCE_DENIED', reason: 'Secret files are never readable through the repo gateway' };
      const full = join(abs, rel);
      if (!existsSync(full)) return { status: 'ERROR', code: 'INVALID_REQUEST', reason: `${rel} does not exist` };
      return { status: 'OK', data: { path: rel, content: readFileSync(full, 'utf8') } };
    },
    async write(session, grant_id, path, content) {
      const rel = safe(path);
      if (rel === undefined) return { status: 'DENIED', code: 'RESOURCE_DENIED', reason: 'Path escapes the project' };
      const auth = await session.authorize({ grant_id, action: 'repo.write', resource: rel });
      if (auth.status !== 'OK') return auth;
      if (SECRET_FILE.test(rel)) return { status: 'DENIED', code: 'RESOURCE_DENIED', reason: 'Secret files are never writable through the repo gateway' };
      const full = join(abs, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return { status: 'OK', data: { path: rel, bytes: Buffer.byteLength(content) } };
    },
  };
}

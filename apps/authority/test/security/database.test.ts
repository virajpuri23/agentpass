import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../../db/database.js';
import { seedDatabase } from '../../../../db/seed.js';

describe('authority database persistence', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('initializes SQLite safeguards and reseeding preserves keys and root expiry', () => {
    directory = mkdtempSync(join(tmpdir(), 'agentpass-db-'));
    const db = openDatabase(join(directory, 'authority.sqlite'));
    try {
      const firstNow = new Date('2026-10-17T20:00:00.000Z');
      seedDatabase(db, { 'owner-1': 'first-owner-key', 'buyer-agent': 'first-buyer-key' }, firstNow);
      const keyBefore = db.prepare("SELECT key_hash FROM principal_keys WHERE principal_id = 'owner-1'").get() as { key_hash: string };
      const scopeBefore = db.prepare("SELECT scope_json FROM grants WHERE id = 'grant-root-buyer'").get() as { scope_json: string };
      db.prepare("UPDATE principal_keys SET revoked_at = '2026-10-17T20:01:00.000Z' WHERE principal_id = 'owner-1'").run();

      seedDatabase(db, { 'owner-1': 'rotated-owner-key', 'buyer-agent': 'rotated-buyer-key' }, new Date('2027-10-17T20:00:00.000Z'));

      const keyAfter = db.prepare("SELECT key_hash, revoked_at FROM principal_keys WHERE principal_id = 'owner-1'").get() as { key_hash: string; revoked_at: string };
      const scopeAfter = db.prepare("SELECT scope_json FROM grants WHERE id = 'grant-root-buyer'").get() as { scope_json: string };
      expect(keyAfter.key_hash).toBe(keyBefore.key_hash);
      expect(keyAfter.revoked_at).toBe('2026-10-17T20:01:00.000Z');
      expect(scopeAfter.scope_json).toBe(scopeBefore.scope_json);
      expect((db.prepare('SELECT COUNT(*) AS count FROM principal_keys').get() as { count: number }).count).toBe(2);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('adds private demo keys to an existing env file without replacing its values', () => {
    directory = mkdtempSync(join(tmpdir(), 'agentpass-seed-cli-'));
    const envPath = join(directory, '.env');
    writeFileSync(envPath, 'AUTHORITY_DB_PATH=authority.sqlite\nKEEP_ME=unchanged\n', { mode: 0o644 });
    const tsx = fileURLToPath(new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const seed = fileURLToPath(new URL('../../../../db/seed.ts', import.meta.url));
    const run = () => spawnSync(process.execPath, [tsx, seed], { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });

    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const firstEnv = readFileSync(envPath, 'utf8');
    expect(firstEnv).toContain('KEEP_ME=unchanged');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const names = ['OWNER_API_KEY', 'BUYER_API_KEY', 'SOURCING_API_KEY', 'SUPPLIER_API_KEY'];
    const firstKeys = Object.fromEntries(names.map(name => [name, firstEnv.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]]));
    expect(new Set(Object.values(firstKeys)).size).toBe(names.length);
    expect(`${first.stdout}${first.stderr}`).not.toContain(firstKeys.OWNER_API_KEY);

    const second = run();
    expect(second.status, second.stderr).toBe(0);
    const secondEnv = readFileSync(envPath, 'utf8');
    for (const name of names) expect(secondEnv.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]).toBe(firstKeys[name]);
    expect(secondEnv.match(/^KEEP_ME=/gm)).toHaveLength(1);
  });
});

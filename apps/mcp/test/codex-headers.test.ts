import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareChildCredential } from '../../cli/src/child-credential.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const endpoint = 'https://agentpass.example/mcp';
const helper = resolve('apps/mcp/src/codex-headers.ts');
function fixture(expiresAt = new Date(Date.now() + 60000).toISOString()) {
  const directory = mkdtempSync(join(tmpdir(), 'agentpass-codex-headers-'));
  directories.push(directory);
  const path = join(directory, 'child.json');
  const state = prepareChildCredential(path, {
    endpoint, parent_grant_id: 'fixture-parent',
    scope: { actions: ['supplier.quote.request'], supplier_ids: ['supplier'], sku_ids: ['sku'],
      max_per_action_cents: 0, total_budget_cents: 0,
      expires_at: expiresAt, max_delegation_depth: 0 },
  });
  return { path, state };
}

describe('Codex private credential headers', () => {
  it('delivers the child credential directly to the HTTP header helper consumer', () => {
    const { path, state } = fixture();
    const output = execFileSync(process.execPath, ['--import', 'tsx', helper, path, endpoint], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({ Authorization: `Bearer ${state.credential}` });
  });

  it('fails without emitting a credential for another endpoint', () => {
    const { path, state } = fixture();
    const result = spawnSync(process.execPath, ['--import', 'tsx', helper, path, 'https://other.example/mcp'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(state.credential);
  });

  it('fails without emitting an expired credential', () => {
    const { path } = fixture(new Date(Date.now() - 60000).toISOString());
    const result = spawnSync(process.execPath, ['--import', 'tsx', helper, path, endpoint], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});

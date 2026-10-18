import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readChildCredential } from '../../cli/src/child-credential.js';

export function codexHeaders(credentialFile: string, endpoint: string) {
  const state = readChildCredential(credentialFile);
  if (state.endpoint !== endpoint || Date.parse(state.scope.expires_at) <= Date.now()) {
    throw new Error('Credential endpoint mismatch or expired authority.');
  }
  return { Authorization: `Bearer ${state.credential}` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4) throw new Error('Invalid arguments.');
    process.stdout.write(JSON.stringify(codexHeaders(process.argv[2]!, process.argv[3]!)) + '\n');
  } catch {
    process.stderr.write('AgentPass credential unavailable, expired, or bound to another endpoint.\n');
    process.exitCode = 1;
  }
}

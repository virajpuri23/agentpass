/**
 * Writes .env from .env.example, filling every empty *_API_KEY / *_SERVICE_KEY
 * with a fresh random value. Existing .env values are kept unless --force.
 * Key values are never printed.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const force = process.argv.includes('--force');
const template = readFileSync('.env.example', 'utf8');
const existing = new Map<string, string>();

if (existsSync('.env') && !force) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m?.[1] && m[2]) existing.set(m[1], m[2]);
  }
}

const generated: string[] = [];
const out = template
  .split('\n')
  .map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m?.[1]) return line;
    const name = m[1];
    const kept = existing.get(name);
    if (kept) return `${name}=${kept}`;
    if (/_(API|SERVICE)_KEY$/.test(name) && !m[2]) {
      generated.push(name);
      return `${name}=ap_${randomBytes(24).toString('base64url')}`;
    }
    return line;
  })
  .join('\n');

writeFileSync('.env', out, { mode: 0o600 });
console.log(generated.length ? `Generated: ${generated.join(', ')}` : 'All keys already set; .env unchanged');

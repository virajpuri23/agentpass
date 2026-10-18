/** Scope algebra shared by the mock and tests: subset checks and resource globs. */
import type { WorkforceAction, WorkforceScope } from './contract.js';

/** Minimal glob: `**` matches any depth, `*` matches within one segment. Paths are '/'-separated. */
export function resourceMatches(pattern: string, resource: string): boolean {
  const re = '^' + pattern
    .split('**').map((part) => part.split('*').map(escape).join('[^/]*')).join('.*') + '$';
  return new RegExp(re).test(resource);
}
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function resourceAllowed(scope: WorkforceScope, resource: string): boolean {
  return scope.resources.some((p) => resourceMatches(p, resource));
}

/** True when every pattern in `child` is covered by some pattern in `parent`. */
export function resourcesSubset(child: string[], parent: string[]): boolean {
  return child.every((c) => parent.some((p) => p === c || (p.endsWith('**') && c.startsWith(p.slice(0, -2))) || resourceMatches(p, c)));
}

export function isSubset(child: WorkforceScope, parent: WorkforceScope): { ok: true } | { ok: false; why: string } {
  const extra = child.actions.filter((a) => !parent.actions.includes(a));
  if (extra.length) return { ok: false, why: `actions not held by parent: ${extra.join(', ')}` };
  if (!child.resources.length) return { ok: false, why: 'resources must not be empty' };
  if (!resourcesSubset(child.resources, parent.resources)) return { ok: false, why: 'resources exceed parent allow-list' };
  if (Date.parse(child.expires_at) > Date.parse(parent.expires_at)) return { ok: false, why: 'expires after parent' };
  if (child.max_delegation_depth >= parent.max_delegation_depth) return { ok: false, why: 'delegation depth must decrease' };
  return { ok: true };
}

export function hasAction(scope: WorkforceScope, action: WorkforceAction): boolean {
  return scope.actions.includes(action);
}

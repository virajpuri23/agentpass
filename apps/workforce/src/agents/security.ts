/**
 * Security agent: an EXTERNAL company's auditor (organization `sentinel-sec`)
 * holding a read-only grant (repo.read on `src/**` and `package.json`).
 *
 * It reads every source file through the repo gateway and runs a
 * deterministic rule set (no LLM). `scanSource` is pure and reusable: the lead
 * can re-run it after fixing a finding to prove the fix. The run ends with two
 * negative checks traced as denials: reading `.env` (never a repo resource) and
 * writing `src/lib/newsletter.ts` (it has no repo.write at all).
 */
import { type AgentContext, isError, noteDenied } from '../agent-base.js';
import type { ApiResult } from '../contract.js';

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number; // 1-based
  evidence: string;
  fix: string;
}

export interface SecurityReport {
  scanned_files: number;
  findings: Finding[];
  passed_checks: string[];
  denied: { what: string; code: string }[];
  generated_by: 'sentinel-sec/security-agent (deterministic rules)';
}

export const RULES = {
  R1: 'dangerouslySetInnerHTML fed by an unescaped value',
  R2: 'hardcoded secret-looking literal in source',
  R3: 'dependency pinned to a non-exact version',
} as const;

const R1_FIX = 'wrap the user value with escapeHtml() from src/lib/newsletter.ts';
const SOURCE_FILE = /\.(tsx?|jsx?|mjs|cjs)$/;
const SINK = /dangerouslySetInnerHTML=\{\{\s*__html:\s*(.+?)\s*\}\}/;
const ESCAPED = /^(escapeHtml|escape|sanitizeHtml|sanitize|DOMPurify\.sanitize)\s*\(/;
const STRING_LITERAL = /^(['"][^'"]*['"]|`[^`$]*`)$/;
const CALL = /^([A-Za-z_$][\w$]*)\s*\((.*)\)$/;
const SECRET = /(sk_(?:live|test)_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

const lines = (content: string) => content.split(/\r?\n/);
const rootIdent = (expr: string) => /^[A-Za-z_$][\w$]*/.exec(expr.trim())?.[0];

/** Finds `function name(` / `const name =` across the scanned files; returns its location, parameter names and body lines. */
function resolveFunction(name: string, files: Record<string, string>): { file: string; line: number; params: string[]; body: { line: number; text: string }[] } | undefined {
  const def = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\s*\\(([^)]*)\\)|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\(([^)]*)\\)|([A-Za-z_$][\\w$]*))\\s*=>?)`);
  for (const file of Object.keys(files).sort()) {
    if (!SOURCE_FILE.test(file)) continue;
    const src = lines(files[file]!);
    for (let i = 0; i < src.length; i++) {
      const m = def.exec(src[i]!);
      if (!m) continue;
      const paramList = m[1] ?? m[2] ?? m[3] ?? '';
      const params = paramList.split(',').map((p) => rootIdent(p.replace(/^\s*\{?\s*/, ''))).filter((p): p is string => !!p);
      // Body: from the definition line until brace depth returns to zero (or the next blank-line-terminated statement for expression bodies).
      // Body: the definition line (it may hold a single-expression arrow body) through the line where brace depth returns to zero.
      const body: { line: number; text: string }[] = [];
      let depth = 0, opened = false;
      for (let j = i; j < src.length; j++) {
        const text = src[j]!;
        for (const ch of text) { if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--; }
        body.push({ line: j + 1, text });
        if (opened && depth <= 0) break;
        if (!opened && j > i && text.trim() === '') break;
      }
      return { file, line: i + 1, params, body };
    }
  }
  return undefined;
}

/** Interpolations on one line that reach a parameter without an escape call: `'..' + name`, `name + '..'`, `${name}`. */
function unescapedInterpolations(text: string, params: string[]): string[] {
  const found = new Set<string>();
  const consider = (expr: string) => {
    const e = expr.trim();
    if (!e || ESCAPED.test(e)) return;
    const id = rootIdent(e);
    if (id && (params.length === 0 || params.includes(id))) found.add(e);
  };
  for (const m of text.matchAll(/\$\{([^}]+)\}/g)) consider(m[1]!);
  for (const m of text.matchAll(/(['"`][^'"`]*['"`])\s*\+\s*([A-Za-z_$][\w$]*(?:\([^)]*\))?)/g)) consider(m[2]!);
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*(?:\([^)]*\))?)\s*\+\s*(['"`][^'"`]*['"`])/g)) consider(m[1]!);
  return [...found];
}

function ruleR1(files: Record<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const file of Object.keys(files).sort()) {
    if (!SOURCE_FILE.test(file)) continue;
    const src = lines(files[file]!);
    src.forEach((text, i) => {
      const sink = SINK.exec(text);
      if (!sink) return;
      const expr = sink[1]!.trim();
      if (STRING_LITERAL.test(expr) || ESCAPED.test(expr)) return; // constant markup or sanitized at the sink
      const sinkFinding = (severity: Severity, why: string): Finding => ({
        rule: RULES.R1, severity, file, line: i + 1, evidence: text.trim(), fix: `${why}; ${R1_FIX}`,
      });
      const call = CALL.exec(expr);
      if (!call) { out.push(sinkFinding('high', `"${expr}" reaches innerHTML without escaping`)); return; }
      const fn = resolveFunction(call[1]!, files);
      if (!fn) { out.push(sinkFinding('medium', `could not resolve ${call[1]}() in the scanned files; verify it escapes its input`)); return; }
      const leaks = fn.body.flatMap((b) => unescapedInterpolations(b.text, fn.params).map((e) => ({ ...b, expr: e })));
      if (!leaks.length) return; // the producer escapes (or never interpolates) its parameters
      for (const leak of leaks) {
        out.push({ rule: RULES.R1, severity: 'high', file: fn.file, line: leak.line, evidence: leak.text.trim(),
          fix: `${call[1]}() concatenates "${leak.expr}" into HTML unescaped and the result is rendered by ${file}:${i + 1}; ${R1_FIX}` });
      }
      out.push(sinkFinding('high', `renders ${call[1]}() output, which interpolates its argument unescaped (${fn.file}:${leaks[0]!.line})`));
    });
  }
  return out;
}

function ruleR2(files: Record<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const file of Object.keys(files).sort()) {
    if (!file.startsWith('src/')) continue;
    lines(files[file]!).forEach((text, i) => {
      const m = SECRET.exec(text);
      if (!m) return;
      const token = m[1]!;
      out.push({ rule: RULES.R2, severity: 'high', file, line: i + 1,
        evidence: text.trim().replace(token, `${token.slice(0, 8)}…[redacted]`),
        fix: 'move the value to an environment variable, rotate it, and purge it from history' });
    });
  }
  return out;
}

function ruleR3(files: Record<string, string>): Finding[] {
  const pkg = files['package.json'];
  if (!pkg) return [];
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { parsed = JSON.parse(pkg); } catch { return [{ rule: RULES.R3, severity: 'info', file: 'package.json', line: 1, evidence: 'package.json is not valid JSON', fix: 'fix package.json so dependency pins can be audited' }]; }
  const src = lines(pkg);
  const out: Finding[] = [];
  for (const [name, version] of Object.entries({ ...parsed.dependencies, ...parsed.devDependencies })) {
    if (EXACT_VERSION.test(version)) continue;
    const idx = src.findIndex((l) => new RegExp(`^\\s*"${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\s*:`).test(l));
    out.push({ rule: RULES.R3, severity: 'info', file: 'package.json', line: idx + 1 || 1, evidence: (src[idx] ?? `"${name}": "${version}"`).trim(),
      fix: `pin "${name}" to an exact version (currently "${version}") so builds are reproducible beyond the lockfile` });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Pure, deterministic scan over `{ path: content }`. Findings are ordered by rule, then file, then line. */
export function scanSource(files: Record<string, string>): Finding[] {
  const byPos = (a: Finding, b: Finding) => a.file.localeCompare(b.file) || a.line - b.line;
  return [...ruleR1(files).sort(byPos), ...ruleR2(files).sort(byPos), ...ruleR3(files)];
}

/** Rules with no finding, phrased for the report. */
export function passedChecks(findings: Finding[], scannedFiles: number): string[] {
  const hit = new Set(findings.map((f) => f.rule));
  return Object.entries(RULES).filter(([, rule]) => !hit.has(rule)).map(([id, rule]) => `${id} ${rule}: none found in ${scannedFiles} files`);
}

export async function runSecurityAgent(ctx: AgentContext): Promise<SecurityReport> {
  const repo = ctx.gateways.repo;
  if (!repo) throw new Error('security agent needs the repo gateway');
  const { session, grant_id } = ctx;
  const say = (text: string, kind: 'note' | 'call' | 'result' = 'note', data?: unknown) => ctx.trace({ agent: ctx.name, kind, text, data });
  const must = async <T>(what: string, p: Promise<ApiResult<T>>): Promise<T> => {
    say(what, 'call');
    const r = await p;
    if (isError(r)) { noteDenied(ctx, what, r); throw new Error(`${what} failed: ${r.code} ${r.reason}`); }
    return r.data;
  };

  // Read everything the grant covers, and nothing else, through the gateway.
  const files: Record<string, string> = {};
  const paths = [...await must('repo.list src', repo.list(session, grant_id, 'src')), 'package.json'];
  for (const path of paths) files[path] = (await must(`repo.read ${path}`, repo.read(session, grant_id, path))).content;
  const scanned_files = Object.keys(files).length;
  say(`read ${scanned_files} files through the repo gateway`);

  const findings = scanSource(files);
  const passed_checks = passedChecks(findings, scanned_files);
  say(`scan: ${findings.length} findings (${findings.filter((f) => f.severity === 'high').length} high), ${passed_checks.length} checks passed`, 'result', { findings, passed_checks });

  // Negative checks: both must be refused; the refusal is part of the report.
  const denied: SecurityReport['denied'] = [];
  const negative: [string, () => Promise<ApiResult<unknown>>][] = [
    ['negative check: repo.read .env', () => repo.read(session, grant_id, '.env')],
    ['negative check: repo.write src/lib/newsletter.ts', () => repo.write(session, grant_id, 'src/lib/newsletter.ts', '// an external auditor must not be able to write this\n')],
  ];
  for (const [what, attempt] of negative) {
    say(what, 'call');
    const r = await attempt();
    if (!noteDenied(ctx, what, r)) throw new Error(`${what} unexpectedly succeeded: an external read-only auditor must never hold this`);
    denied.push({ what, code: r.code });
  }

  return { scanned_files, findings, passed_checks, denied, generated_by: 'sentinel-sec/security-agent (deterministic rules)' };
}

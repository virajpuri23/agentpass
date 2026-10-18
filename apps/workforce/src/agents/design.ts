/**
 * Design agent: improves the landing page's UI, deterministically and only
 * through the repo gateway, within its grant (repo.read + repo.write on
 * `src/components/**` and `src/styles/**`).
 *
 * No LLM: the new Hero, Features and stylesheet are fixed, reviewed assets
 * below. Signup.tsx is read but left untouched (its XSS is the lead's to fix
 * after the Security agent reports it). The run ends with two negative
 * checks, traced as denials: reading `.env` and writing outside its paths.
 */
import { type AgentContext, isError, noteDenied } from '../agent-base.js';
import type { ApiResult } from '../contract.js';

export interface DesignResult {
  changed_files: string[];
  /** Contents before the run, for files the agent was allowed to read only. */
  before: Record<string, string>;
  /** Contents after the run (re-read through the gateway), same files as `before`. */
  after: Record<string, string>;
  denied: { what: string; code: string }[];
}

export const HERO_HEADLINE = 'Ship your SaaS in an afternoon';

const HERO_TSX = `export function Hero() {
  return (
    <section className="hero">
      <p className="eyebrow">Launchpad</p>
      <h1>${HERO_HEADLINE}</h1>
      <p className="subhead">
        Billing, auth and analytics, wired together and ready on day one. Spend your
        time on the product your customers pay for, not on the plumbing underneath it.
      </p>
      <div className="hero-actions">
        <a className="button button-primary" href="#signup">Get early access</a>
        <a className="link-secondary" href="#features">See what&apos;s included</a>
      </div>
    </section>
  );
}
`;

const FEATURES_TSX = `const FEATURES = [
  { title: 'Billing', blurb: 'Subscriptions, invoices and dunning without writing webhook code.' },
  { title: 'Auth', blurb: 'Email, passkeys and SSO with sessions that just work.' },
  { title: 'Analytics', blurb: 'Signup funnels and retention, computed for you.' },
];

export function Features() {
  return (
    <section className="features" id="features">
      <h2>Everything a small team needs</h2>
      <div className="feature-grid">
        {FEATURES.map(({ title, blurb }) => (
          <article className="feature-card" key={title}>
            <h3>{title}</h3>
            <p>{blurb}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
`;

const GLOBALS_CSS = `:root {
  --brand: #2563eb;
  --accent: #f59e0b;
  --bg: #ffffff;
  --surface: #f8fafc;
  --text: #0f172a;
  --muted: #475569;
  --border: #e2e8f0;
  --radius: 12px;
  --space-1: 0.5rem;
  --space-2: 1rem;
  --space-3: 1.5rem;
  --space-4: 2.5rem;
  --space-5: 4rem;
}

@media (prefers-color-scheme: dark) {
  :root {
    --brand: #60a5fa;
    --accent: #fbbf24;
    --bg: #0b1220;
    --surface: #111a2e;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --border: #1e293b;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  line-height: 1.6;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}

main {
  max-width: 960px;
  margin: 0 auto;
  padding: var(--space-4) var(--space-3) var(--space-5);
}

h1, h2, h3 {
  line-height: 1.15;
  margin: 0 0 var(--space-2);
  letter-spacing: -0.01em;
}

h1 {
  font-size: clamp(2.25rem, 5vw, 3.5rem);
}

h2 {
  font-size: clamp(1.5rem, 3vw, 2rem);
}

h3 {
  font-size: 1.125rem;
}

p {
  margin: 0 0 var(--space-2);
}

a {
  color: var(--brand);
}

.button {
  display: inline-block;
  padding: 0.75rem 1.5rem;
  border-radius: var(--radius);
  font-weight: 600;
  text-decoration: none;
  border: 1px solid transparent;
  transition: transform 120ms ease, box-shadow 120ms ease;
}

.button:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
}

.button-primary {
  background: var(--brand);
  color: #ffffff;
}

.link-secondary {
  font-weight: 600;
  text-decoration: none;
  color: var(--muted);
}

.link-secondary:hover {
  color: var(--brand);
}

/* Hero */
.hero {
  padding: var(--space-5) 0 var(--space-4);
  text-align: center;
}

.hero .eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--accent);
}

.hero .subhead {
  max-width: 40rem;
  margin: 0 auto var(--space-3);
  font-size: 1.125rem;
  color: var(--muted);
}

.hero-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
}

/* Features */
.features {
  padding: var(--space-4) 0;
  text-align: center;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-3);
  margin-top: var(--space-3);
  text-align: left;
}

.feature-card {
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.feature-card p {
  margin: 0;
  color: var(--muted);
}

/* Signup */
.signup {
  margin-top: var(--space-4);
  padding: var(--space-4) var(--space-3);
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  text-align: center;
}

.signup form {
  display: flex;
  gap: var(--space-1);
  justify-content: center;
  flex-wrap: wrap;
}

.signup input {
  flex: 1 1 240px;
  max-width: 320px;
  padding: 0.75rem 1rem;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font: inherit;
}

.signup button {
  padding: 0.75rem 1.5rem;
  border-radius: var(--radius);
  border: none;
  background: var(--brand);
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

@media (max-width: 600px) {
  main {
    padding: var(--space-3) var(--space-2) var(--space-4);
  }
  .hero {
    padding-top: var(--space-4);
  }
}
`;

const STYLESHEET = 'src/styles/globals.css';
const HERO = 'src/components/Hero.tsx';
const FEATURES = 'src/components/Features.tsx';

export async function runDesignAgent(ctx: AgentContext): Promise<DesignResult> {
  const repo = ctx.gateways.repo;
  if (!repo) throw new Error('design agent needs the repo gateway');
  const { session, grant_id } = ctx;
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  const changed_files: string[] = [];
  const denied: DesignResult['denied'] = [];
  const say = (text: string, kind: 'note' | 'call' | 'result' = 'note', data?: unknown) => ctx.trace({ agent: ctx.name, kind, text, data });
  /** Unwraps a gateway result; a failure on the happy path is a bug in the grant, so it throws. */
  const must = async <T>(what: string, p: Promise<ApiResult<T>>): Promise<T> => {
    say(what, 'call');
    const r = await p;
    if (isError(r)) { noteDenied(ctx, what, r); throw new Error(`${what} failed: ${r.code} ${r.reason}`); }
    return r.data;
  };

  // (a) Read what is there, through the gateway only.
  const components = (await must('repo.list src/components', repo.list(session, grant_id, 'src/components'))).filter((f) => f.endsWith('.tsx'));
  for (const path of [...components, STYLESHEET]) {
    before[path] = (await must(`repo.read ${path}`, repo.read(session, grant_id, path))).content;
  }
  say(`read ${Object.keys(before).length} files: ${Object.keys(before).join(', ')}`);

  // (b) + (c) Deterministic rewrites. Signup.tsx is deliberately left alone.
  const edits: [string, string][] = [[HERO, HERO_TSX], [FEATURES, FEATURES_TSX], [STYLESHEET, GLOBALS_CSS]];
  for (const [path, content] of edits) {
    if (before[path] === content) continue;
    await must(`repo.write ${path}`, repo.write(session, grant_id, path, content));
    changed_files.push(path);
  }
  say(`rewrote ${changed_files.join(', ')}; Signup.tsx left for the lead (confirmationHtml is the Security agent's finding)`);

  // (d) Negative checks: both must be refused, and the refusal is part of the result.
  const negative: [string, () => Promise<ApiResult<unknown>>][] = [
    ['negative check: repo.read .env', () => repo.read(session, grant_id, '.env')],
    ['negative check: repo.write src/lib/newsletter.ts', () => repo.write(session, grant_id, 'src/lib/newsletter.ts', '// design agent must not be able to write this\n')],
  ];
  for (const [what, attempt] of negative) {
    say(what, 'call');
    const r = await attempt();
    if (!noteDenied(ctx, what, r)) throw new Error(`${what} unexpectedly succeeded: the grant is wider than the design agent should hold`);
    denied.push({ what, code: r.code });
  }

  // Re-read through the gateway so `after` reflects what the project really holds now.
  for (const path of Object.keys(before)) {
    after[path] = (await must(`repo.read ${path}`, repo.read(session, grant_id, path))).content;
  }
  say(`done: ${changed_files.length} files changed, ${denied.length} refusals recorded`, 'result', { changed_files, denied });
  return { changed_files, before, after, denied };
}

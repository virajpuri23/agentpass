import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const port = 3290 + Math.floor(Math.random() * 60);
const base = `http://127.0.0.1:${port}`;
let server: ChildProcess;

beforeAll(async () => {
  // No .env: hosted mode must stay disabled in tests.
  server = spawn(process.execPath, ['--import', 'tsx', 'apps/activity/src/server.ts'], {
    env: { PATH: process.env.PATH, ACTIVITY_PORT: String(port) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('activity server did not start');
}, 20_000);

afterAll(() => { server?.kill('SIGTERM'); });

/** Collects SSE envelopes until the run's `done` event. */
async function collect(timeoutMs: number) {
  const res = await fetch(`${base}/api/events`);
  const reader = res.body!.getReader();
  const events: any[] = [];
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    let i;
    while ((i = text.indexOf('\n\n')) >= 0) {
      const frame = text.slice(0, i);
      text = text.slice(i + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data: '));
      if (data && !frame.startsWith('event: reset')) events.push(JSON.parse(data.slice(6)));
    }
    if (events.some((e) => e.event.type === 'done')) break;
  }
  await reader.cancel();
  return events;
}

describe('activity server', () => {
  it('serves the page and assets without exposing other files', async () => {
    expect((await fetch(base)).status).toBe(200);
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/../../.env`)).status).toBe(404);
    expect((await fetch(`${base}/server.ts`)).status).toBe(404);
  });

  it('reports hosted mode unavailable without HOSTED_* settings', async () => {
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status.hostedConfigured).toBe(false);
    expect(status.recordings.length).toBeGreaterThan(0);
  });

  it('streams a real local run end to end and refuses a concurrent run', async () => {
    const stream = collect(60_000);
    const start = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"local"}' });
    expect(start.status).toBe(202);
    const busy = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"local"}' });
    expect(busy.status).toBe(409);
    const events = await stream;
    const types = events.map((e) => e.event.type);
    expect(types[0]).toBe('meta');
    expect(events.every((e) => e.recorded === false)).toBe(true);
    expect(events.filter((e) => e.event.type === 'check').map((e) => e.event.check.pass)).toEqual(Array(9).fill(true));
    expect(events.at(-1).event).toEqual({ type: 'done', passed: true });
    expect(events.filter((e) => e.event.type === 'process').map((e) => e.event.agent)).toEqual(expect.arrayContaining(['buyer-agent', 'sourcing-agent']));
  }, 70_000);

  it('labels replays as recorded', async () => {
    const status = await (await fetch(`${base}/api/status`)).json();
    const stream = collect(30_000);
    await fetch(`${base}/api/replay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: status.recordings[0] }) });
    const events = await stream;
    expect(events.length).toBeGreaterThan(10);
    expect(events.every((e) => e.recorded === true)).toBe(true);
  }, 40_000);

  it('rejects unknown modes and recordings', async () => {
    expect((await fetch(`${base}/api/run`, { method: 'POST', body: '{"mode":"prod"}' })).status).toBe(400);
  });
});

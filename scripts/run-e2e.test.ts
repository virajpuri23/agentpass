import { describe, expect, it } from 'vitest';
import { isolatedStack } from './demo-stack.js';
import { runDemo } from './run-e2e.js';

describe('demo runner', () => {
  it('passes all 9 judge-demo checks on a fresh isolated stack', async () => {
    const stack = await isolatedStack();
    try {
      const { checks, passed } = await runDemo({ stack });
      expect(checks.map((c) => c.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(checks.filter((c) => !c.pass), JSON.stringify(checks, null, 2)).toEqual([]);
      expect(passed).toBe(true);
    } finally {
      await stack.stop();
    }
  }, 60_000);
});

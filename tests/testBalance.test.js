// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { balanceTests, durationsFromReport, testFiles } from '../scripts/test-balance.mjs';
describe('duration-balanced complete regression suite', () => {
  it('covers every discovered test exactly once and is stable regardless of filesystem order', () => {
    const files = testFiles(),
      plan = balanceTests(files, {}, 8);
    expect(plan.flatMap(s => s.files).sort()).toEqual(files);
    expect(balanceTests([...files].reverse(), {}, 8)).toEqual(plan);
  });
  it('places expensive files on different workers rather than balancing only file count', () => {
    const files = ['a', 'b', 'c', 'd'];
    const shards = balanceTests(files, { a: 9000, b: 8000, c: 2000, d: 1000 }, 2);
    expect(shards.map(s => s.ms)).toEqual([11000, 11000]);
  });
  it('handles new files, invalid durations and rejects duplicate files/counts', () => {
    expect(balanceTests(['new', 'bad'], { bad: -1 }, 2).map(s => s.ms)).toEqual([3000, 3000]);
    expect(() => balanceTests(['a', 'a'])).toThrow();
    expect(() => balanceTests([], {}, 0)).toThrow();
  });
  it('exports only allowed paths and finite positive timings, not test names or errors', () => {
    expect(
      durationsFromReport(
        {
          testResults: [
            { name: '/repo/tests/a.test.js', startTime: 1, endTime: 51, message: 'secret' },
            { name: '/other/file', startTime: 1, endTime: 9 }
          ]
        },
        '/repo',
        ['tests/a.test.js']
      )
    ).toEqual({ 'tests/a.test.js': 50 });
  });
});

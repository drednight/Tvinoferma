import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

it('registers each real-crypto setup suite exactly once for each provider', () => {
  const helper = readFileSync('tests/helpers/cloudInitialSetupSuites.js', 'utf8');
  const suites = [...helper.matchAll(/export function (registerSetupSuite\d+)\(/g)].map(match => match[1]);
  const registrations = readdirSync('tests')
    .filter(name => /^cloudInitialSetup(?:\.\d+(?:\.part\d+)?\.(?:google|yandex))?\.integration\.test\.js$/.test(name))
    .map(name => {
      const source = readFileSync(`tests/${name}`, 'utf8');
      const match = source.match(/(registerSetupSuite\d+)\(\['(google|yandex)'\](?:, (\d+), (\d+))?\);/);
      expect(match, name).not.toBeNull();
      return { key: `${match[1]}:${match[2]}`, part: Number(match[3] || 0), count: Number(match[4] || 1) };
    });
  expect(suites.length).toBe(25);
  const groups = new Map();
  for (const row of registrations) {
    if (!groups.has(row.key)) groups.set(row.key, []);
    groups.get(row.key).push(row);
  }
  expect([...groups.keys()].sort()).toEqual(suites.flatMap(suite => [`${suite}:google`, `${suite}:yandex`]).sort());
  for (const [key, parts] of groups) {
    const count = parts[0].count;
    expect(
      parts.every(p => p.count === count),
      key
    ).toBe(true);
    expect(
      parts.map(p => p.part).sort((a, b) => a - b),
      key
    ).toEqual(Array.from({ length: count }, (_, i) => i));
  }
});

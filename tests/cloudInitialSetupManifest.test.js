import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

it('registers each real-crypto setup suite exactly once for each provider', () => {
  const helper = readFileSync('tests/helpers/cloudInitialSetupSuites.js', 'utf8');
  const suites = [...helper.matchAll(/export function (registerSetupSuite\d+)\(/g)].map(match => match[1]);
  const registrations = readdirSync('tests')
    .filter(name => /^cloudInitialSetup(?:\.\d+\.(?:google|yandex))?\.integration\.test\.js$/.test(name))
    .map(name => {
      const source = readFileSync(`tests/${name}`, 'utf8');
      const match = source.match(/(registerSetupSuite\d+)\(\['(google|yandex)'\]\);/);
      expect(match, name).not.toBeNull();
      return `${match[1]}:${match[2]}`;
    });
  expect(suites.length).toBe(25);
  expect(registrations.sort()).toEqual(suites.flatMap(suite => [`${suite}:google`, `${suite}:yandex`]).sort());
});

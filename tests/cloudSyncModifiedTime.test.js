import { describe, expect, it } from 'vitest';
import { parseCloudModifiedTime } from '../js/modules/cloudSync/providers/modifiedTime.js';

describe('справочная дата файла облака', () => {
  it.each([
    ['2026-10-29T13:45:12Z', '2026-10-29T13:45:12.000Z'],
    ['2026-10-29T16:45:12+03:00', '2026-10-29T13:45:12.000Z'],
    ['2026-10-29T08:15:12.123456789-05:30', '2026-10-29T13:45:12.123Z'],
    ['2024-02-29T00:00:00+00:00', '2024-02-29T00:00:00.000Z']
  ])('переводит %s в момент UTC без зависимости от часового пояса ПК', (input, expected) => {
    expect(parseCloudModifiedTime(input)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    0,
    {},
    '',
    '2026-10-29',
    '2026-10-29T13:45:12',
    '2026-10-29T13:45:12-00:00',
    '2026-02-29T13:45:12Z',
    '1900-02-29T13:45:12Z',
    '2026-13-01T13:45:12Z',
    '2026-10-29T24:00:00Z',
    '2026-10-29T13:60:12Z',
    '2026-10-29T13:45:60Z',
    '2026-10-29T13:45:12+24:00',
    '2026-10-29T13:45:12+03:60',
    '2026-10-29T13:45:12.1234567890Z',
    '0001-01-01T00:00:00+01:00',
    '9999-12-31T23:59:59-01:00',
    '2026-10-29T13:45:12Z <script>private</script>'
  ])('не выдумывает дату из неоднозначного или некорректного значения %#', input => {
    expect(parseCloudModifiedTime(input)).toBeNull();
  });

  it('не вызывает методы или getter у постороннего объекта', () => {
    let called = false;
    const foreign = { toString: () => ((called = true), '2026-10-29T13:45:12Z') };
    expect(parseCloudModifiedTime(foreign)).toBeNull();
    expect(called).toBe(false);
  });
});

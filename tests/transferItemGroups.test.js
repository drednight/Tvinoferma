import { expect, it } from 'vitest';
import {
  groupTransferItems,
  chooseTransferPackets,
  transferExpiry
} from '../js/modules/automation/transferItemGroups.js';
const item = (id, extra = {}) => ({ id, name: 'Подарок', qty: 50, source: '', until: '', ...extra });
it('groups matching name and quantity across all categories/deadlines, retaining original IDs', () => {
  const groups = groupTransferItems([
    item('a'),
    item('b'),
    item('c', { qty: 1 }),
    item('d', { source: 'Акция' }),
    item('e', { until: 'Завтра' }),
    item('f', { name: 'Другое' })
  ]);
  expect(groups).toHaveLength(3);
  expect(groups[0].items.map(item => item.id)).toEqual(['a', 'b', 'd', 'e']);
});
it('chooses a subset of real packets, leaves unrelated IDs and uses stable order for equal or unknown deadlines', () => {
  const [group] = groupTransferItems(['a', 'b', 'c', 'd'].map(id => item(id)));
  const previous = new Set(['c', 'unrelated']);
  expect([...chooseTransferPackets(group, 2, previous)]).toEqual(['unrelated', 'a', 'b']);
  expect([...previous]).toEqual(['c', 'unrelated']);
  expect([...chooseTransferPackets(group, 0, previous)]).toEqual(['unrelated']);
  expect(chooseTransferPackets(group, 4, previous).size).toBe(5);
  for (const count of [-1, 1.5, 5, NaN, Infinity, '2'])
    expect(chooseTransferPackets(group, count, previous)).toBeNull();
});

it('chooses the nearest known Moscow deadline first, never invents missing/invalid dates', () => {
  const [group] = groupTransferItems([
    item('unknown', { until: '' }),
    item('late', { until: '23:59 10.11.2026', source: 'Одна акция' }),
    item('early', { until: '11:30 04.11.2026', source: 'Другая акция' }),
    item('same-day', { until: '05.11.2026 08:00' }),
    item('invalid', { until: '31.02.2026' })
  ]);
  expect(group.items.map(item => item.id)).toEqual(['early', 'same-day', 'late', 'unknown', 'invalid']);
  expect([...chooseTransferPackets(group, 2, new Set(['late', 'unknown', 'other']))]).toEqual([
    'other',
    'early',
    'same-day'
  ]);
  expect(transferExpiry('11:30 04.11.2026')).toBe(Date.UTC(2026, 10, 4, 8, 30));
  expect(transferExpiry('04.11.2026')).toBe(Date.UTC(2026, 10, 4, 20, 59));
  for (const raw of ['31.02.2026', '00.11.2026', '24:00 04.11.2026', '12:60 04.11.2026', 'завтра', '04.11', ''])
    expect(transferExpiry(raw)).toBe(Infinity);
});

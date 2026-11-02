import { expect, it } from 'vitest';
import { groupTransferItems, chooseTransferPackets } from '../js/modules/automation/transferItemGroups.js';
const item = (id, extra = {}) => ({ id, name: 'Подарок', qty: 50, source: '', until: '', ...extra });
it('groups only identical indivisible site packets, retaining original IDs', () => {
  const groups = groupTransferItems([
    item('a'),
    item('b'),
    item('c', { qty: 1 }),
    item('d', { source: 'Акция' }),
    item('e', { until: 'Завтра' }),
    item('f', { name: 'Другое' })
  ]);
  expect(groups).toHaveLength(5);
  expect(groups[0].items.map(item => item.id)).toEqual(['a', 'b']);
});
it('chooses a subset of real packets, leaves unrelated IDs and prioritizes previous choices', () => {
  const [group] = groupTransferItems(['a', 'b', 'c', 'd'].map(id => item(id)));
  const previous = new Set(['c', 'unrelated']);
  expect([...chooseTransferPackets(group, 2, previous)]).toEqual(['unrelated', 'c', 'a']);
  expect([...previous]).toEqual(['c', 'unrelated']);
  expect([...chooseTransferPackets(group, 0, previous)]).toEqual(['unrelated']);
  expect(chooseTransferPackets(group, 4, previous).size).toBe(5);
  for (const count of [-1, 1.5, 5, NaN, Infinity, '2'])
    expect(chooseTransferPackets(group, count, previous)).toBeNull();
});

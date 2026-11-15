import { it, expect } from 'vitest';
import { leaderChoices, selectableRecipients } from '../js/modules/gameMacros/recipients.js';
import { normalizeGameMacros } from '../js/modules/gameMacros/model.js';

it('recommends only an unambiguous majority with a running selected saved leader, never assigning it', () => {
  const state = {
    parties: [
      { id: 'p', name: 'Первая' },
      { id: 'q', name: 'Вторая' }
    ],
    characters: [
      { id: 'a', nick: 'A', partyIds: ['p'] },
      { id: 'b', nick: 'B', partyIds: ['p'] },
      { id: 'c', nick: 'C', partyIds: ['q'] }
    ]
  };
  const config = normalizeGameMacros({ leaders: { p: 'a', q: 'c' } });
  const rows = ['a', 'b', 'c'].map(charId => ({ charId, known: true }));
  expect(leaderChoices(state, config, rows).suggestion).toMatchObject({ partyId: 'p', leaderId: 'a', count: 2 });
  expect(config.partyId).toBe('');
  config.excludedCommandCharacters = ['b'];
  expect(leaderChoices(state, config, rows)).toMatchObject({ suggestion: null, tie: true });
  config.excludedCommandCharacters = ['a'];
  expect(leaderChoices(state, config, rows).suggestion).toMatchObject({ partyId: 'q' });
});
it('omits duplicate and unknown identities from the selection', () => {
  expect(
    selectableRecipients([
      { charId: 'a', known: true },
      { charId: 'a', known: true },
      { charId: 'b', known: false },
      { charId: 'c', known: true }
    ])
  ).toEqual([{ charId: 'c', known: true }]);
});

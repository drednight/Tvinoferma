import { expect, it } from 'vitest';
import { state } from '../js/core/state.js';
import { mergeCharacterReferences } from '../js/modules/characters/identity.js';
it('unions shared marathon participation and merges disjoint progress without losing either character', () => {
  state.archivedParties = [];
  state.ui.authCheck = {};
  state.ui.revealedContacts = {};
  state.marathons = [{ participantIds: ['a', 'b'], progress: { a: { task1: 1 }, b: { task2: 2 } } }];
  mergeCharacterReferences('b', 'a');
  expect(state.marathons[0]).toEqual({ participantIds: ['a'], progress: { a: { task1: 1, task2: 2 } } });
});
it('refuses conflicting progress transactionally rather than adding or overwriting credits', () => {
  state.marathons = [{ participantIds: ['a', 'b'], progress: { a: { task1: 1 }, b: { task1: 2 } } }];
  const before = JSON.stringify(state.marathons);
  expect(() => mergeCharacterReferences('b', 'a')).toThrow();
  expect(JSON.stringify(state.marathons)).toBe(before);
});

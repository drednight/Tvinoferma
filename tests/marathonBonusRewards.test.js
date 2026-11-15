import { it, expect } from 'vitest';
import { createMarathon, bonusRewardCoins, marathonTotals, freezeAwards } from '../js/modules/marathons/model.js';
it('extracts only Ancient Coins, before/after name and with grouped quantities', () => {
  for (const text of [
    '50 Древних монет + 3 сундука',
    'Древние монеты — 50',
    'Древняя монета × 50',
    'Древняя монета (50 шт.)',
    '50 «Древних монет»'
  ])
    expect(bonusRewardCoins({ text })).toBe(50);
  expect(bonusRewardCoins({ text: '1 000 Древних монет и 25 Древних монет' })).toBe(1025);
  expect(bonusRewardCoins({ text: '2 ларца, 30 монет другого вида' })).toBe(0);
});
it('adds reached bonuses to the recipient and total once, freezes and does not change site balances', () => {
  const m = createMarathon({
    participantIds: ['a', 'b'],
    tasks: [{ id: 't', targetChecks: 1, rewards: [{ threshold: 1, rewardCoins: 10 }] }],
    assignments: { a: ['t'], b: ['t'] },
    bonuses: [{ id: 'bonus', needTasks: 1, text: '50 Древних монет и 2 ларца' }],
    progress: { a: { t: { site: 1 } }, b: { t: { site: 0 } } }
  });
  const characters = [{ id: 'a', nick: 'Alpha', ancientCoins: 123 }];
  expect(marathonTotals(m)).toMatchObject({ coins: 60, maxCoins: 120, perChar: { a: { coins: 60 }, b: { coins: 0 } } });
  expect(marathonTotals(m).coins).toBe(60);
  m.awards = freezeAwards(m, characters);
  m.status = 'completed';
  expect(m.awards).toHaveLength(2);
  expect(m.awards[1]).toMatchObject({ characterId: 'a', coins: 50, taskTitle: 'Бонус' });
  expect(marathonTotals(m).coins).toBe(60);
  expect(characters[0].ancientCoins).toBe(123);
  m.progress.a.t.site = 0;
  expect(marathonTotals(m).coins).toBe(60);
});
it('does not award unmet bonuses or rewrite historical frozen awards', () => {
  const m = createMarathon({
    participantIds: ['a'],
    tasks: [{ id: 't', targetChecks: 1 }],
    assignments: { a: ['t'] },
    bonuses: [{ needTasks: 2, text: '100 Древних монет' }],
    progress: { a: { t: { site: 1 } } }
  });
  expect(marathonTotals(m).coins).toBe(0);
  expect(freezeAwards(m, [])).toEqual([]);
  m.status = 'completed';
  m.awards = [{ characterId: 'a', coins: 7 }];
  expect(marathonTotals(m).coins).toBe(7);
});

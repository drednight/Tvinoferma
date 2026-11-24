import { describe, expect, it, beforeEach } from 'vitest';
import { state } from '../js/core/state.js';
import { writePendingPollVotes, readPendingPollVotes, writeGuildData } from '../js/modules/guild/state.js';

describe('real persist path with pendingPollVotes', () => {
  beforeEach(() => {
    localStorage.clear();
    state.settings.guild = {
      enabled: true,
      events: [],
      parties: [],
      selfNick: '',
      polls: [],
      syncedAt: 123,
      pendingResponses: [],
      pendingPollVotes: []
    };
  });

  it('writePendingPollVotes persists without throwing', async () => {
    let error = null;
    try {
      await writePendingPollVotes([{ pollId: '901', optionIds: ['501'], failed: false }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeNull();
    expect(readPendingPollVotes()).toEqual([{ pollId: '901', optionIds: ['501'], failed: false }]);
  });

  it('writeGuildData with polls persists without throwing', async () => {
    let error = null;
    try {
      await writeGuildData({
        events: [],
        parties: [],
        selfNick: '',
        polls: [
          {
            id: '901',
            title: [{ text: 'Q' }],
            type: 'multiple',
            options: [{ id: '501', text: [{ text: 'A' }], selected: false }]
          }
        ],
        syncedAt: 1
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeNull();
  });

  it('writePendingResponses (events) persists without throwing', async () => {
    const { writePendingResponses, readPendingResponses } = await import('../js/modules/guild/state.js');
    let error = null;
    try {
      await writePendingResponses([{ eventId: '7', response: 'yes', failed: false }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeNull();
    expect(readPendingResponses()).toEqual([{ eventId: '7', response: 'yes', failed: false }]);
  });
});

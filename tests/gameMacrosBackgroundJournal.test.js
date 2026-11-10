import { beforeEach, it, expect, vi } from 'vitest';
let journal;
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '<div id="modal-root"></div>';
  journal = await import('../js/modules/gameMacros/backgroundJournal.js');
});
it('persists allowlisted phases across reload and never stores arbitrary secrets or payload fields', async () => {
  journal.appendBackgroundJournal('background-phase', {
    key: 'B',
    errorCode: 1460,
    password: 'secret',
    url: 'https://secret.test',
    details: { token: 'secret', ok: false, messages: [{ phase: 'up', vk: 66, lparam: '0x1234', error: 1460 }] }
  });
  const before = journal.backgroundJournalText();
  expect(before).toContain('1460');
  expect(before).toContain('0x1234');
  expect(before).not.toContain('secret');
  vi.resetModules();
  const reloaded = await import('../js/modules/gameMacros/backgroundJournal.js');
  expect(reloaded.backgroundJournalEntries()).toHaveLength(1);
});
it('exports every retained record instead of only the current display tail', () => {
  for (let i = 0; i < 310; i++) journal.appendBackgroundJournal('background-phase', { n: i });
  expect(JSON.parse(journal.backgroundJournalText()).records).toHaveLength(310);
  const ov = journal.openBackgroundJournal();
  expect(JSON.parse(ov.body.querySelector('textarea').value).records).toHaveLength(310);
  ov.close();
});
it('keeps new records in memory and reports persistence failure instead of silently dropping them', () => {
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  try {
    journal.appendBackgroundJournal('background-phase', { errorCode: 1460 });
    expect(journal.backgroundJournalText()).toContain('только в памяти');
    expect(journal.backgroundJournalEntries()).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});

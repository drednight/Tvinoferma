import { beforeEach, it, expect, vi } from 'vitest';
import { renderCharacterUpdatePanel } from '../js/modules/cloudSync/ui/characterUpdatePanel.js';
const fields = { nick: 'Совпадает <img src=x onerror=alert(1)>', level: 10 };
const view = () => ({
  locals: [
    { id: 'local', nick: fields.nick, fields },
    { id: 'other', nick: 'Другой', fields }
  ],
  records: [
    {
      id: 'remote',
      nick: fields.nick,
      fields: { ...fields, level: 20 },
      matchedLocalId: '',
      suggestedLocalIds: ['local']
    }
  ]
});
let host;
beforeEach(() => {
  document.body.innerHTML = '<section></section>';
  host = document.querySelector('section');
});
it('never preselects a nickname suggestion; no HTML injection or auto consent', () => {
  const apply = vi.fn();
  renderCharacterUpdatePanel(host, view(), apply);
  expect(host.querySelector('select').value).toBe('');
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('[data-character-update-apply]').disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
});
it('requires explicit mapping, selected fields and fresh acknowledgment; uses captured selections', async () => {
  const apply = vi.fn(async () => {});
  renderCharacterUpdatePanel(host, view(), apply);
  const select = host.querySelector('select');
  select.value = 'local';
  select.dispatchEvent(new Event('change'));
  const level = host.querySelector('input[value="level"]');
  expect(level.checked).toBe(false);
  level.click();
  const ack = host.querySelector('[data-character-update-ack]');
  ack.click();
  host.querySelector('[data-character-update-apply]').click();
  await vi.waitFor(() =>
    expect(apply).toHaveBeenCalledWith([{ cloudId: 'remote', localId: 'local', fields: ['level'] }])
  );
  await vi.waitFor(() => expect(ack.checked).toBe(false));
});
it('stored mapping is preselected but fields and consent are not; duplicate targets disable apply', () => {
  const v = view();
  v.records[0].matchedLocalId = 'local';
  v.records.push({ ...v.records[0], id: 'remote2' });
  renderCharacterUpdatePanel(host, v, vi.fn());
  expect([...host.querySelectorAll('select')].map(s => s.value)).toEqual(['local', 'local']);
  expect(host.textContent).toContain('нескольких облачных');
  host.querySelector('[data-character-update-ack]').click();
  expect(host.querySelector('[data-character-update-apply]').disabled).toBe(true);
});

it('cannot bypass consent after a parent operation re-enables controls', async () => {
  const { setCharacterUpdateBusy } = await import('../js/modules/cloudSync/ui/characterUpdatePanel.js');
  const v = view();
  v.records[0].matchedLocalId = 'local';
  const apply = vi.fn();
  renderCharacterUpdatePanel(host, v, apply);
  setCharacterUpdateBusy(host, true);
  setCharacterUpdateBusy(host, false);
  const button = host.querySelector('[data-character-update-apply]');
  expect(button.disabled).toBe(true);
  // Even an unrelated caller toggling disabled cannot skip the logical gate.
  button.disabled = false;
  button.click();
  expect(apply).not.toHaveBeenCalled();
});

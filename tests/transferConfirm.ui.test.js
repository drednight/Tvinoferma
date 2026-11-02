import { beforeEach, expect, it, vi } from 'vitest';
const confirm = vi.hoisted(() => vi.fn());
vi.mock('../js/core/ui.js', () => ({ confirmModal: confirm }));
import { confirmTransfer } from '../js/modules/automation/transferConfirm.js';
import { saveLimits, loadLimits } from '../js/modules/automation/transferStore.js';
const $ = s => document.querySelector(s);
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"><div id="parent"></div></div>';
  localStorage.clear();
  confirm.mockReset().mockResolvedValue(false);
});
it('forgets remembered limits only after an explicit confirmation and never treats this as consent to transfer', async () => {
  saveLimits({ server: 'Фенрир', sources: ['Акция'] });
  const promise = confirmTransfer({
    parent: $('#parent'),
    plansFor: () => [{ run: true, itemSelection: [{ qty: 25 }] }]
  });
  $('#tr-forget').click();
  await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(Object.keys(loadLimits())).toHaveLength(1);
  confirm.mockResolvedValue(true);
  $('#tr-forget').click();
  await vi.waitFor(() => expect(Object.keys(loadLimits())).toHaveLength(0));
  expect($('#tr-ack').checked).toBe(false);
  expect($('[data-confirm-transfer]').disabled).toBe(true);
  $('[data-confirm-cancel]').click();
  expect(await promise).toBeNull();
});
it('returns the exact plan displayed at acceptance and requires a new acknowledgement each time', async () => {
  const plans = [{ run: true, itemSelection: [{ id: '11', qty: 25 }] }];
  const promise = confirmTransfer({ parent: $('#parent'), plansFor: () => plans });
  $('#tr-ack').click();
  $('[data-confirm-transfer]').click();
  expect(await promise).toEqual({ force: false, plans });
  const next = confirmTransfer({ parent: $('#parent'), plansFor: () => plans });
  expect($('#tr-ack').checked).toBe(false);
  $('[data-confirm-cancel]').click();
  await next;
});
it('aborting the parent closes the child without approving anything', async () => {
  const controller = new AbortController();
  const promise = confirmTransfer({ parent: $('#parent'), signal: controller.signal, plansFor: () => [] });
  expect($('#parent').inert).toBe(true);
  controller.abort();
  expect(await promise).toBeNull();
  expect($('.tr-confirm-dialog')).toBeNull();
  expect($('#parent').inert).toBe(false);
});

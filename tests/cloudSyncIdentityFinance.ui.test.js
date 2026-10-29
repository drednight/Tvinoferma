import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));
import { state } from '../js/core/state.js';
import { normalizeFinance } from '../js/modules/finance/model.js';
import { bindFinance, renderFinance } from '../js/modules/finance/page.js';

const ids = [
  'a9115bf2-e834-444d-aeb6-7c3af1db8890',
  'b9115bf2-e834-444d-aeb6-7c3af1db8890',
  'c9115bf2-e834-444d-aeb6-7c3af1db8890',
  'd9115bf2-e834-444d-aeb6-7c3af1db8890',
  'e9115bf2-e834-444d-aeb6-7c3af1db8890'
];
const $ = selector => document.querySelector(selector);
const save = async () => {
  $('#modal-root .modal-footer .btn.primary').click();
  await vi.waitFor(() => expect($('#modal-root .modal-overlay')).toBeNull());
};

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="finance-root"></div>';
  state.finance = normalizeFinance({
    operations: [
      { id: 'op', syncId: ids[0], date: '2026-10-01', kind: 'in', currency: 'gold', amount: 10 },
      {
        id: 'loan-op',
        syncId: ids[3],
        date: '2026-10-01',
        kind: 'in',
        currency: 'gold',
        amount: 50,
        source: 'debt',
        ref: 'loan'
      }
    ],
    shopItems: [{ id: 'item', syncId: ids[1], side: 'sell', name: 'Зелье', price: 10, qty: 2, date: '2026-10-01' }],
    loans: [
      {
        id: 'loan',
        syncId: ids[2],
        direction: 'borrowed',
        who: 'Друг',
        principal: 50,
        percent: 1,
        start: '2026-10-01',
        end: '2026-12-01',
        currency: 'gold',
        opId: 'loan-op',
        payments: [{ id: 'payment', syncId: ids[4], date: '2026-10-02', amount: 5 }]
      }
    ]
  });
  bindFinance();
  renderFinance();
});

describe('sync-ID в настоящих формах Банка', () => {
  it('сохраняет ID при редактировании операции', async () => {
    $('[data-fin-act="edit-op"][data-id="op"]').click();
    $('#modal-root [name="amount"]').value = '25';
    await save();
    expect(state.finance.operations.find(row => row.id === 'op')).toMatchObject({ syncId: ids[0], amount: 25 });
  });
  it('сохраняет ID при редактировании позиции комиссионки', async () => {
    $('[data-fin-act="edit-item"][data-id="item"]').click();
    $('#modal-root [name="qty"]').value = '4';
    await save();
    expect(state.finance.shopItems[0]).toMatchObject({ syncId: ids[1], qty: 4 });
  });
  it('сохраняет направление взятого долга и ID долга, выплаты и связанной операции', async () => {
    $('[data-fin-act="edit-loan"][data-id="loan"]').click();
    $('#modal-root [name="principal"]').value = '80';
    await save();
    expect(state.finance.loans[0]).toMatchObject({
      syncId: ids[2],
      direction: 'borrowed',
      principal: 80,
      payments: [{ syncId: ids[4] }]
    });
    expect(state.finance.operations.find(row => row.id === 'loan-op')).toMatchObject({
      syncId: ids[3],
      amount: 80,
      kind: 'in',
      ref: 'loan'
    });
  });
});

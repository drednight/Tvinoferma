import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFinance, normalizeFinance } from '../js/modules/finance/model.js';
import { exportFinance } from '../js/modules/cloudSync/financeExport.js';

const ids = {
  op: '10000000-0000-4000-8000-000000000001',
  shopOp: '10000000-0000-4000-8000-000000000002',
  loanOp: '10000000-0000-4000-8000-000000000003',
  item: '10000000-0000-4000-8000-000000000004',
  loan: '10000000-0000-4000-8000-000000000005',
  payment: '10000000-0000-4000-8000-000000000006'
};
let finance;

beforeEach(() => {
  finance = normalizeFinance({
    operations: [
      {
        id: 'local-manual',
        syncId: ids.op,
        date: '2026-10-28',
        kind: 'in',
        currency: 'gold',
        amount: 100,
        counterparty: 'Выручка',
        source: 'manual'
      },
      {
        id: 'local-shop-operation',
        syncId: ids.shopOp,
        date: '2026-10-28',
        kind: 'out',
        currency: 'gold',
        amount: 20,
        counterparty: 'Магазин',
        source: 'shop',
        ref: 'local-item'
      },
      {
        id: 'local-loan-operation',
        syncId: ids.loanOp,
        date: '2026-10-28',
        kind: 'out',
        currency: 'coins',
        amount: 50,
        counterparty: 'Долг',
        source: 'debt',
        ref: 'local-loan'
      }
    ],
    shopItems: [
      {
        id: 'local-item',
        syncId: ids.item,
        side: 'buy',
        name: 'Предмет',
        price: 10,
        qty: 2,
        date: '2026-10-28',
        note: 'заметка'
      }
    ],
    loans: [
      {
        id: 'local-loan',
        syncId: ids.loan,
        direction: 'lent',
        who: 'Игрок',
        principal: 50,
        percent: 3,
        start: '2026-10-28',
        currency: 'coins',
        opId: 'local-loan-operation',
        payments: [{ id: 'local-payment', syncId: ids.payment, date: '2026-10-29', amount: 10 }]
      }
    ],
    settings: {
      goldRate: 12,
      goldRateAt: '2026-10-28',
      commissionPct: 2,
      opening: { gold: 100, coins: 5 },
      monthAdjust: { '2026-10': { gold: -30 } },
      monthCarry: { '2026-10': { gold: 20 } }
    }
  });
});

describe('подготовительный экспорт финансов', () => {
  it('сохраняет записи, порядок, коррекции и ссылки, заменяя локальные ID', () => {
    const before = JSON.stringify(finance);
    const result = exportFinance(finance);
    expect(result.records).toHaveLength(6);
    expect(result.order).toEqual({
      operations: [ids.op, ids.shopOp, ids.loanOp],
      shopItems: [ids.item],
      loans: [ids.loan]
    });
    expect(result.settings).toMatchObject({
      opening: { gold: 100, coins: 5 },
      monthAdjust: { '2026-10': { gold: -30 } },
      monthCarry: { '2026-10': { gold: 20 } }
    });
    expect(result.records.find(row => row.id === ids.shopOp).fields.ref).toBe(ids.item);
    expect(result.records.find(row => row.id === ids.loanOp).fields.ref).toBe(ids.loan);
    expect(result.records.find(row => row.id === ids.loan).fields).toMatchObject({
      opId: ids.loanOp,
      paymentIds: [ids.payment],
      principal: 50
    });
    expect(result.records.find(row => row.id === ids.payment).fields).toEqual({
      loanId: ids.loan,
      date: '2026-10-29',
      amount: 10
    });
    expect(JSON.stringify(result)).not.toContain('local-');
    expect(JSON.stringify(finance)).toBe(before);
  });

  it('экспортирует пустой новый раздел без придуманных записей', () => {
    expect(exportFinance(defaultFinance())).toEqual({
      settings: {
        goldRate: 0,
        goldRateAt: null,
        commissionPct: 2,
        opening: { gold: 0, coins: 0 },
        monthAdjust: {},
        monthCarry: {}
      },
      order: { operations: [], shopItems: [], loans: [] },
      records: []
    });
  });

  it('останавливается на ссылке на удалённую позицию, не теряя её молча', () => {
    finance.shopItems = [];
    expect(() => exportFinance(finance)).toThrow('финансовая ссылка');
  });

  it('останавливается на ссылке на отсутствующий долг или операцию', () => {
    finance.loans[0].opId = 'missing-operation';
    expect(() => exportFinance(finance)).toThrow('финансовая ссылка');
    finance.loans[0].opId = null;
    finance.operations.find(row => row.source === 'debt').ref = 'missing-loan';
    expect(() => exportFinance(finance)).toThrow('финансовая ссылка');
  });

  it('не связывает долг с чужой операцией', () => {
    finance.loans[0].opId = 'local-manual';
    expect(() => exportFinance(finance)).toThrow('финансовая ссылка');
    finance.loans[0].opId = 'local-loan-operation';
    finance.operations.find(row => row.id === 'local-loan-operation').ref = 'another-loan';
    expect(() => exportFinance(finance)).toThrow('финансовая ссылка');
  });

  it('не использует неизвестные источники ссылок и не отправляет локальный ID', () => {
    finance.operations.find(row => row.source === 'manual').ref = 'local-private-ref';
    expect(() => exportFinance(finance)).toThrow('финансовая ссылка');
  });

  it('отклоняет лишние поля и дубль sync-ID между разными сущностями', () => {
    finance.operations[0].accessToken = 'secret';
    expect(() => exportFinance(finance)).toThrow('экспорт остановлен');
    delete finance.operations[0].accessToken;
    finance.shopItems[0].syncId = finance.loans[0].syncId;
    expect(() => exportFinance(finance)).toThrow();
  });

  it('отклоняет отсутствующие и неверные sync-ID без угадывания', () => {
    delete finance.loans[0].payments[0].syncId;
    expect(() => exportFinance(finance)).toThrow();
    finance.loans[0].payments[0].syncId = 'local-payment';
    expect(() => exportFinance(finance)).toThrow();
  });

  it('не допускает невалидные суммы, настройки и произвольные поля месяца', () => {
    finance.operations[0].amount = NaN;
    expect(() => exportFinance(finance)).toThrow();
    finance.operations[0].amount = 100;
    finance.settings.opening.password = 1;
    expect(() => exportFinance(finance)).toThrow();
    delete finance.settings.opening.password;
    finance.settings.monthAdjust.bad = { gold: 1 };
    expect(() => exportFinance(finance)).toThrow();
  });

  it('не исполняет getter и не раскрывает пользовательский текст в ошибке', () => {
    const getter = vi.fn(() => 'тайная сумма');
    Object.defineProperty(finance.operations[0], 'amount', { enumerable: true, get: getter });
    expect(() => exportFinance(finance)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const error = (() => {
      try {
        exportFinance(finance);
      } catch (e) {
        return String(e);
      }
      return '';
    })();
    expect(error).not.toContain('тайная сумма');
  });
});

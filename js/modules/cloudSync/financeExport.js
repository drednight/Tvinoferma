// @ts-check
// Строгий экспорт нормализованного «Банка»; без чтения state и без записи/сети.
// Удалённые объекты, на которые ссылается реестр, пока не имеют устойчивого реестра tombstones.
// Поэтому неразрешённые ссылки блокируют экспорт, а не заменяются null или локальными ID.
import { preparationCheck, preparationError } from './preparationDiagnostics.js';
import { isSyncId } from './envelope.js';
import { array, dictionary, invalidExport, nullableText, number, object, oneOf, text } from './exportSchema.js';

const CURRENCIES = ['gold', 'coins'];
const OP_KEYS = [
  'id',
  'syncId',
  'date',
  'currency',
  'kind',
  'amount',
  'counterparty',
  'note',
  'status',
  'source',
  'ref'
];
const ITEM_KEYS = ['id', 'syncId', 'side', 'name', 'price', 'qty', 'date', 'note'];
const LOAN_KEYS = [
  'id',
  'syncId',
  'direction',
  'who',
  'principal',
  'percent',
  'start',
  'end',
  'currency',
  'note',
  'opId',
  'payments'
];
const PAYMENT_KEYS = ['id', 'syncId', 'date', 'amount'];

function collect(values, keys, allSyncIds) {
  const localToSync = new Map();
  const rows = array(values, value => {
    const row = object(value, keys);
    if (!text(row.id) || !isSyncId(row.syncId) || localToSync.has(row.id) || allSyncIds.has(row.syncId)) {
      throw invalidExport();
    }
    localToSync.set(row.id, row.syncId);
    allSyncIds.add(row.syncId);
    return row;
  });
  return { rows, localToSync };
}

function positive(value) {
  const amount = number(value);
  if (amount <= 0) throw invalidExport();
  return amount;
}
function nonnegative(value) {
  const amount = number(value);
  if (amount < 0) throw invalidExport();
  return amount;
}

function reference(value, mapping) {
  if (value === null) return null;
  if (!text(value) || !mapping.has(value))
    throw preparationError(new Error('Не найдена финансовая ссылка; экспорт остановлен'), 'reference');
  return mapping.get(value);
}

function currencyMap(value, required) {
  const data = object(value, required ? CURRENCIES : [], required ? [] : CURRENCIES);
  return Object.fromEntries(Object.keys(data).map(key => [key, number(data[key])]));
}
function months(value) {
  return dictionary(
    value,
    key => /^\d{4}-\d{2}$/.test(key),
    item => currencyMap(item, false)
  );
}
function settings(value) {
  // В новом ещё не сохранённом состоянии monthAdjust/monthCarry могут отсутствовать.
  const data = object(value, ['goldRate', 'goldRateAt', 'commissionPct', 'opening'], ['monthAdjust', 'monthCarry']);
  return {
    goldRate: nonnegative(data.goldRate),
    goldRateAt: nullableText(data.goldRateAt),
    commissionPct: nonnegative(data.commissionPct),
    opening: currencyMap(data.opening, true),
    monthAdjust: Object.hasOwn(data, 'monthAdjust') ? months(data.monthAdjust) : {},
    monthCarry: Object.hasOwn(data, 'monthCarry') ? months(data.monthCarry) : {}
  };
}

/** Все локальные ID в ссылках заменяются на sync-ID; записи с неизвестными полями отклоняются. */
export function exportFinance(finance) {
  const data = object(finance, ['operations', 'shopItems', 'loans', 'settings']);
  const allSyncIds = new Set();
  const operations = collect(data.operations, OP_KEYS, allSyncIds);
  const items = collect(data.shopItems, ITEM_KEYS, allSyncIds);
  const loans = collect(data.loans, LOAN_KEYS, allSyncIds);
  const payments = [];
  const paymentIds = new Set();
  const operationsById = new Map(operations.rows.map(row => [row.id, row]));
  const loanRecords = loans.rows.map(loan => {
    if (loan.opId !== null) {
      const opening = operationsById.get(loan.opId);
      if (!opening || opening.source !== 'debt' || opening.ref !== loan.id) {
        throw preparationError(new Error('Не найдена финансовая ссылка; экспорт остановлен'), 'reference');
      }
    }
    const loanPayments = array(loan.payments, value => {
      const row = object(value, PAYMENT_KEYS);
      if (!text(row.id) || !isSyncId(row.syncId) || allSyncIds.has(row.syncId) || paymentIds.has(row.id))
        throw invalidExport();
      allSyncIds.add(row.syncId);
      paymentIds.add(row.id);
      payments.push({
        id: row.syncId,
        type: 'financePayment',
        fields: { loanId: loan.syncId, date: text(row.date), amount: positive(row.amount) }
      });
      return row.syncId;
    });
    return {
      id: loan.syncId,
      type: 'financeLoan',
      fields: {
        direction: oneOf(loan.direction, ['lent', 'borrowed']),
        who: text(loan.who),
        principal: positive(loan.principal),
        percent: nonnegative(loan.percent),
        start: text(loan.start),
        end: text(loan.end),
        currency: oneOf(loan.currency, CURRENCIES),
        note: text(loan.note),
        opId: reference(loan.opId, operations.localToSync),
        paymentIds: loanPayments
      }
    };
  });
  const operationRecords = operations.rows.map(row =>
    preparationCheck('operations', () => {
      const source = oneOf(row.source, ['manual', 'shop', 'gold', 'debt']);
      let ref = null;
      if (source === 'shop') ref = reference(row.ref, items.localToSync);
      else if (source === 'debt') ref = reference(row.ref, loans.localToSync);
      else if (row.ref !== null)
        throw preparationError(new Error('Не найдена финансовая ссылка; экспорт остановлен'), 'reference');
      return {
        id: row.syncId,
        type: 'financeOperation',
        fields: {
          date: text(row.date),
          currency: oneOf(row.currency, CURRENCIES),
          kind: oneOf(row.kind, ['in', 'out']),
          amount: positive(row.amount),
          counterparty: text(row.counterparty),
          note: text(row.note),
          status: text(row.status),
          source,
          ref
        }
      };
    })
  );
  const itemRecords = items.rows.map(row => ({
    id: row.syncId,
    type: 'financeShopItem',
    fields: {
      side: oneOf(row.side, ['buy', 'sell']),
      name: text(row.name),
      price: positive(row.price),
      qty: positive(row.qty),
      date: text(row.date),
      note: text(row.note)
    }
  }));
  return {
    settings: settings(data.settings),
    order: {
      operations: operationRecords.map(row => row.id),
      shopItems: itemRecords.map(row => row.id),
      loans: loanRecords.map(row => row.id)
    },
    records: [...operationRecords, ...itemRecords, ...loanRecords, ...payments]
  };
}

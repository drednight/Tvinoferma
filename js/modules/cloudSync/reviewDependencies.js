// @ts-check
// Предварительная проверка известных ссылок в ОДНОМ подготовленном публичном снимке.
// Нет state, сети, импорта или сохранения. Нулевой список проблем не является разрешением
// на импорт: полная бизнес-схема, история, подтверждение удаления, архивы и транзакции
// требуют отдельной проверки. Секреты могут находиться даже внутри текстовых примечаний.
import { isSyncId } from './envelope.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { array, boolean, number, object, oneOf } from './exportSchema.js';

const SECTIONS = ['characters', 'parties', 'marathons', 'planner', 'finance'];
const MAX_ISSUES = 10_000;

function invalid() {
  return new Error('Некорректные или неподдерживаемые связи данных синхронизации');
}

function syncId(value) {
  if (!isSyncId(value)) throw invalid();
  return value;
}

function syncList(value) {
  const result = array(value, syncId);
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}

function entries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return Object.entries(value).map(([id, item]) => [syncId(id), item]);
}

function freezeSnapshot(snapshot) {
  // Структурная проверка работает до копирования и отклоняет getters, циклы и опасные ключи.
  publicSnapshotIdentityTypes(snapshot);
  let copy;
  try {
    copy = structuredClone(snapshot);
  } catch {
    throw invalid();
  }
  return { snapshot: copy, identities: publicSnapshotIdentityTypes(copy) };
}

/**
 * Возвращает только выявленные проблемы известных ссылок, без имён и значений полей.
 * Источники/пути/ID тоже могут быть чувствительными, поэтому их нельзя писать в журнал.
 * Не выясняет, почему записи нет: отсутствие не доказывает удаление и не разрешает создание.
 * @param {any} input подготовленный публичный снимок-кандидат, без секретного раздела
 */
export function reviewSnapshotDependencies(input) {
  const { snapshot, identities } = freezeSnapshot(input);
  const records = new Map();
  for (const section of SECTIONS) {
    for (const record of snapshot.sections[section].records) records.set(record.id, { ...record, section });
  }
  const issues = [];
  const issue = (code, source, path, targetId, expectedType, actualType = null) => {
    if (issues.length >= MAX_ISSUES) throw new Error('Слишком много проблем в связях синхронизации');
    issues.push({
      code,
      source: { section: source.section, type: source.type, id: source.id },
      path: [...path],
      target: { id: targetId, expectedType, actualType }
    });
  };
  const link = (source, path, id, expectedType, nullable = false) => {
    if (nullable && id === null) return null;
    syncId(id);
    const actual = identities.get(id) || null;
    if (actual === null) issue('missing', source, path, id, expectedType);
    else if (actual !== expectedType) issue('wrong_type', source, path, id, expectedType, actual);
    return actual === expectedType ? records.get(id) || null : null;
  };
  const inconsistent = (source, path, target, expectedType) => {
    issue('inconsistent', source, path, target, expectedType, identities.get(target) || null);
  };
  const chars = 'characters:character';
  const parties = 'parties:party';
  const marathon = 'marathons:marathon';
  const series = 'marathons:marathonSeries';
  const template = 'marathons:marathonTemplate';
  const loan = 'finance:financeLoan';
  const operation = 'finance:financeOperation';
  const payment = 'finance:financePayment';
  const item = 'finance:financeShopItem';

  for (const record of records.values()) {
    const f = record.fields;
    if (record.type === 'character') {
      const ids = syncList(f.partyIds);
      for (const id of ids) link(record, ['partyIds'], id, parties);
      if (f.mainPartyId !== null) {
        link(record, ['mainPartyId'], f.mainPartyId, parties);
        if (!ids.includes(f.mainPartyId)) inconsistent(record, ['mainPartyId'], f.mainPartyId, parties);
      }
      for (const [partyId, order] of entries(f.partyOrder)) {
        number(order);
        link(record, ['partyOrder', partyId], partyId, parties);
      }
    } else if (record.type === 'party') {
      const memberIds = new Set();
      const links = array(f.memberLinks, value => {
        const row = object(value, ['characterId', 'isMain', 'order']);
        const id = syncId(row.characterId);
        if (memberIds.has(id)) throw invalid();
        memberIds.add(id);
        boolean(row.isMain);
        if (row.order !== null) number(row.order);
        return id;
      });
      if (!record.archived && links.length) throw invalid();
      for (const id of links) link(record, ['memberLinks'], id, chars);
    } else if (record.type === 'marathon' || record.type === 'marathonSeries') {
      const source = object(f.source, ['type', 'url', 'siteName', 'stageKey', 'stageName', 'templateId', 'newsUrl']);
      link(record, ['source', 'templateId'], source.templateId, template, true);
      if (record.type === 'marathonSeries') {
        const childIds = syncList(f.childIds);
        for (const id of childIds) {
          const child = link(record, ['childIds'], id, marathon);
          if (child && child.fields.seriesId !== record.id) inconsistent(record, ['childIds'], id, marathon);
        }
        continue;
      }
      const parent = link(record, ['seriesId'], f.seriesId, series, true);
      if (parent && !syncList(parent.fields.childIds).includes(record.id)) {
        inconsistent(record, ['seriesId'], parent.id, series);
      }
      for (const id of syncList(f.participantIds)) link(record, ['participantIds'], id, chars);
      const taskType = `marathonTask:${record.id}`;
      for (const [characterId, assigned] of entries(f.assignments)) {
        link(record, ['assignments', characterId], characterId, chars);
        for (const taskId of syncList(assigned)) link(record, ['assignments', characterId], taskId, taskType);
      }
      for (const [characterId, byTask] of entries(f.progress)) {
        link(record, ['progress', characterId], characterId, chars);
        for (const [taskId, cell] of entries(byTask)) {
          if (!cell || typeof cell !== 'object' || Array.isArray(cell)) throw invalid();
          link(record, ['progress', characterId, taskId], taskId, taskType);
        }
      }
      const balance = object(f.balance, ['start', 'end']);
      for (const side of ['start', 'end']) {
        for (const [characterId, point] of entries(balance[side])) {
          object(point, ['coins', 'at']);
          link(record, ['balance', side, characterId], characterId, chars);
        }
      }
      const awards = array(f.awards, value =>
        object(value, ['characterId', 'charNick', 'taskId', 'taskTitle', 'rewardText', 'coins'])
      );
      for (const [index, award] of awards.entries()) {
        link(record, ['awards', String(index), 'characterId'], award.characterId, chars, true);
        link(record, ['awards', String(index), 'taskId'], award.taskId, taskType, true);
      }
    } else if (record.type === 'financeOperation') {
      const source = oneOf(f.source, ['manual', 'shop', 'gold', 'debt']);
      if (source === 'shop') link(record, ['ref'], f.ref, item, true);
      else if (source === 'debt') link(record, ['ref'], f.ref, loan, true);
      else if (f.ref !== null) {
        syncId(f.ref);
        inconsistent(record, ['ref'], f.ref, 'no-reference');
      }
    } else if (record.type === 'financeLoan') {
      const linkedOp = link(record, ['opId'], f.opId, operation, true);
      if (linkedOp && (linkedOp.fields.source !== 'debt' || linkedOp.fields.ref !== record.id)) {
        inconsistent(record, ['opId'], linkedOp.id, operation);
      }
      for (const id of syncList(f.paymentIds)) {
        const linkedPayment = link(record, ['paymentIds'], id, payment);
        if (linkedPayment && linkedPayment.fields.loanId !== record.id) {
          inconsistent(record, ['paymentIds'], id, payment);
        }
      }
    } else if (record.type === 'financePayment') {
      const linkedLoan = link(record, ['loanId'], f.loanId, loan);
      if (linkedLoan && !syncList(linkedLoan.fields.paymentIds).includes(record.id)) {
        inconsistent(record, ['loanId'], linkedLoan.id, loan);
      }
    }
  }
  return { issues };
}

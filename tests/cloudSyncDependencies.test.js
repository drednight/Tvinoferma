import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { createMarathon, createSeries, createTask } from '../js/modules/marathons/model.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { reviewSnapshotDependencies } from '../js/modules/cloudSync/reviewDependencies.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';

let snapshot;
let ids;
const randomId = () => generateSyncId(webcrypto);

function fixture() {
  const folder = createSeries({ id: 'local-folder', title: 'Папка', childIds: ['local-marathon'] });
  const marathon = createMarathon({
    id: 'local-marathon',
    title: 'Марафон',
    seriesId: 'local-folder',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    participantIds: ['local-hero', 'local-old'],
    source: { type: 'template', templateId: 'local-template' },
    tasks: [createTask({ id: 'local-task', title: 'Задание', rewards: [] })],
    assignments: { 'local-hero': ['local-task'] },
    progress: { 'local-hero': { 'local-task': { site: 1 } } },
    balance: {
      start: { 'local-hero': { coins: 3, at: '2026-10-01T00:00:00Z' } },
      end: { 'local-old': { coins: 9, at: '2026-10-31T00:00:00Z' } }
    },
    awards: [
      {
        characterId: 'local-hero',
        charNick: 'Имя',
        taskId: 'local-task',
        taskTitle: 'Задание',
        rewardText: '',
        coins: 7
      }
    ]
  });
  const state = normalizeState({
    schemaVersion: 10,
    characters: [
      {
        id: 'local-hero',
        nick: 'Герой',
        partyIds: ['local-party'],
        mainPartyId: 'local-party',
        partyOrder: { 'local-party': 1 }
      }
    ],
    archivedCharacters: [{ id: 'local-old', nick: 'Архив' }],
    parties: [{ id: 'local-party', name: 'Альфа', order: 1 }],
    archivedParties: [
      {
        id: 'local-archived-party',
        name: 'Бета',
        order: 2,
        memberLinks: [{ characterId: 'local-old', isMain: true, order: 0 }]
      }
    ],
    marathons: [folder, marathon],
    marathonTemplates: [{ id: 'local-template', name: 'Шаблон', tasks: [] }],
    plannerEntries: [{ id: 'guild-462', title: 'Клановый поход', date: '2026-11-01', kind: 'event', status: 'done' }],
    finance: {
      operations: [
        {
          id: 'local-debt-op',
          date: '2026-10-01',
          currency: 'coins',
          kind: 'out',
          amount: 50,
          source: 'debt',
          ref: 'local-loan'
        },
        {
          id: 'local-shop-op',
          date: '2026-10-01',
          currency: 'gold',
          kind: 'out',
          amount: 20,
          source: 'shop',
          ref: 'local-item'
        }
      ],
      shopItems: [{ id: 'local-item', side: 'buy', name: 'Предмет', price: 10, qty: 2, date: '2026-10-01' }],
      loans: [
        {
          id: 'local-loan',
          direction: 'lent',
          who: 'Игрок',
          principal: 50,
          percent: 3,
          start: '2026-10-01',
          currency: 'coins',
          opId: 'local-debt-op',
          payments: [{ id: 'local-payment', date: '2026-10-02', amount: 10 }]
        }
      ]
    }
  });
  const { ui, ...source } = state;
  const planned = planSyncIdentities({ snapshot: source, cryptoSource: webcrypto }).snapshot;
  return {
    snapshot: buildPublicSnapshot(planned),
    ids: {
      hero: planned.characters[0].syncId,
      old: planned.archivedCharacters[0].syncId,
      party: planned.parties[0].syncId,
      archivedParty: planned.archivedParties[0].syncId,
      folder: planned.marathons[0].syncId,
      marathon: planned.marathons[1].syncId,
      task: planned.marathons[1].tasks[0].syncId,
      template: planned.marathonTemplates[0].syncId,
      operation: planned.finance.operations[0].syncId,
      shopOperation: planned.finance.operations[1].syncId,
      item: planned.finance.shopItems[0].syncId,
      loan: planned.finance.loans[0].syncId,
      payment: planned.finance.loans[0].payments[0].syncId
    }
  };
}

function record(section, id) {
  return snapshot.sections[section].records.find(row => row.id === id);
}
function removeRecord(section, id, orderName) {
  snapshot.sections[section].records = snapshot.sections[section].records.filter(row => row.id !== id);
  if (orderName)
    snapshot.sections[section].order[orderName] = snapshot.sections[section].order[orderName].filter(row => row !== id);
}
function find(issues, sourceId, path, targetId, code = 'missing') {
  return issues.find(
    issue =>
      issue.source.id === sourceId &&
      JSON.stringify(issue.path) === JSON.stringify(path) &&
      issue.target.id === targetId &&
      issue.code === code
  );
}

beforeEach(() => {
  ({ snapshot, ids } = fixture());
});

describe('предварительная проверка зависимостей выбранного набора', () => {
  it('принимает известные связи пати, архива, марафона и банка из настоящего экспортера', () => {
    const before = JSON.stringify(snapshot);
    expect(reviewSnapshotDependencies(snapshot)).toEqual({ issues: [] });
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('замечает, что выбранному персонажу не хватает невыбранной пати', () => {
    removeRecord('parties', ids.party, 'active');
    const { issues } = reviewSnapshotDependencies(snapshot);
    expect(find(issues, ids.hero, ['partyIds'], ids.party)).toMatchObject({
      source: { section: 'characters', type: 'character', id: ids.hero },
      target: { id: ids.party, expectedType: 'parties:party', actualType: null }
    });
    expect(find(issues, ids.hero, ['mainPartyId'], ids.party)).toBeDefined();
    expect(find(issues, ids.hero, ['partyOrder', ids.party], ids.party)).toBeDefined();
  });

  it('не принимает ссылку на сущность другого типа и основной выбор вне списка пати', () => {
    const hero = record('characters', ids.hero);
    hero.fields.mainPartyId = ids.marathon;
    const { issues } = reviewSnapshotDependencies(snapshot);
    expect(find(issues, ids.hero, ['mainPartyId'], ids.marathon, 'wrong_type')).toBeDefined();
    expect(find(issues, ids.hero, ['mainPartyId'], ids.marathon, 'inconsistent')).toBeDefined();
  });

  it('показывает недостающего участника архивной пати, не стирая её состав', () => {
    removeRecord('characters', ids.old, 'archived');
    const { issues } = reviewSnapshotDependencies(snapshot);
    expect(find(issues, ids.archivedParty, ['memberLinks'], ids.old)).toBeDefined();
    expect(record('parties', ids.archivedParty).fields.memberLinks[0].characterId).toBe(ids.old);
  });

  it('выявляет недостающие записи, задания, шаблон, серию, баланс и награды марафона', () => {
    const m = record('marathons', ids.marathon);
    const gone = randomId();
    m.fields.participantIds.push(gone);
    m.fields.assignments[gone] = [randomId()];
    m.fields.progress[gone] = { [randomId()]: { site: 1 } };
    m.fields.balance.end[gone] = { coins: 1, at: '2026-10-31' };
    m.fields.awards[0].characterId = gone;
    m.fields.awards[0].taskId = randomId();
    const missingTemplate = randomId();
    m.fields.source.templateId = missingTemplate;
    const issues = reviewSnapshotDependencies(snapshot).issues;
    expect(find(issues, ids.marathon, ['participantIds'], gone)).toBeDefined();
    expect(find(issues, ids.marathon, ['assignments', gone], gone)).toBeDefined();
    expect(
      issues.some(
        x =>
          x.source.id === ids.marathon &&
          x.path[0] === 'assignments' &&
          x.target.expectedType === `marathonTask:${ids.marathon}`
      )
    ).toBe(true);
    expect(find(issues, ids.marathon, ['progress', gone], gone)).toBeDefined();
    const missingProgressTask = Object.keys(m.fields.progress[gone])[0];
    expect(find(issues, ids.marathon, ['progress', gone, missingProgressTask], missingProgressTask)).toBeDefined();
    expect(find(issues, ids.marathon, ['balance', 'end', gone], gone)).toBeDefined();
    expect(find(issues, ids.marathon, ['awards', '0', 'characterId'], gone)).toBeDefined();
    expect(find(issues, ids.marathon, ['awards', '0', 'taskId'], m.fields.awards[0].taskId)).toBeDefined();
    expect(find(issues, ids.marathon, ['source', 'templateId'], missingTemplate)).toBeDefined();
  });

  it('не принимает задание другого марафона как задание текущего', () => {
    const m = record('marathons', ids.marathon);
    const other = structuredClone(m);
    other.id = randomId();
    other.fields.seriesId = null;
    other.fields.tasks[0].id = randomId();
    other.fields.assignments = {};
    other.fields.progress = {};
    other.fields.awards = [];
    snapshot.sections.marathons.records.push(other);
    snapshot.sections.marathons.order.marathons.push(other.id);
    const otherTask = other.fields.tasks[0].id;
    m.fields.assignments[ids.hero] = [otherTask];
    const issues = reviewSnapshotDependencies(snapshot).issues;
    expect(find(issues, ids.marathon, ['assignments', ids.hero], otherTask, 'wrong_type')).toMatchObject({
      target: { expectedType: `marathonTask:${ids.marathon}`, actualType: `marathonTask:${other.id}` }
    });
  });

  it('выявляет отсутствие и несовпадение двусторонней связи серии и марафона', () => {
    const folder = record('marathons', ids.folder);
    folder.fields.childIds = [];
    expect(
      find(reviewSnapshotDependencies(snapshot).issues, ids.marathon, ['seriesId'], ids.folder, 'inconsistent')
    ).toBeDefined();
    folder.fields.childIds = [ids.marathon];
    record('marathons', ids.marathon).fields.seriesId = null;
    expect(
      find(reviewSnapshotDependencies(snapshot).issues, ids.folder, ['childIds'], ids.marathon, 'inconsistent')
    ).toBeDefined();
    const nonexistent = randomId();
    folder.fields.childIds.push(nonexistent);
    expect(find(reviewSnapshotDependencies(snapshot).issues, ids.folder, ['childIds'], nonexistent)).toBeDefined();
  });

  it('останавливается на отсутствующих связанных операциях, долгах, товарах и платежах', () => {
    removeRecord('finance', ids.item, 'shopItems');
    removeRecord('finance', ids.operation, 'operations');
    removeRecord('finance', ids.payment);
    const { issues } = reviewSnapshotDependencies(snapshot);
    expect(find(issues, ids.shopOperation, ['ref'], ids.item)).toBeDefined();
    expect(find(issues, ids.loan, ['opId'], ids.operation)).toBeDefined();
    expect(find(issues, ids.loan, ['paymentIds'], ids.payment)).toBeDefined();
    removeRecord('finance', ids.loan, 'loans');
    expect(find(reviewSnapshotDependencies(snapshot).issues, ids.shopOperation, ['ref'], ids.item)).toBeDefined();
  });

  it('останавливается, если операция и платёж ссылаются на отсутствующий долг', () => {
    removeRecord('finance', ids.loan, 'loans');
    const { issues } = reviewSnapshotDependencies(snapshot);
    expect(find(issues, ids.operation, ['ref'], ids.loan)).toBeDefined();
    expect(find(issues, ids.payment, ['loanId'], ids.loan)).toBeDefined();
  });

  it('не связывает долг с чужой операцией или платёж с другим долгом', () => {
    const debt = record('finance', ids.loan);
    debt.fields.opId = ids.shopOperation;
    expect(
      find(reviewSnapshotDependencies(snapshot).issues, ids.loan, ['opId'], ids.shopOperation, 'inconsistent')
    ).toBeDefined();
    debt.fields.opId = ids.operation;
    debt.fields.paymentIds = [];
    expect(
      find(reviewSnapshotDependencies(snapshot).issues, ids.payment, ['loanId'], ids.loan, 'inconsistent')
    ).toBeDefined();
    debt.fields.paymentIds = [ids.payment];
    record('finance', ids.payment).fields.loanId = ids.item;
    expect(
      find(reviewSnapshotDependencies(snapshot).issues, ids.loan, ['paymentIds'], ids.payment, 'inconsistent')
    ).toBeDefined();
    expect(
      find(reviewSnapshotDependencies(snapshot).issues, ids.payment, ['loanId'], ids.item, 'wrong_type')
    ).toBeDefined();
  });

  it('разрешает пустые необязательные ссылки, но не превращает их в удаление', () => {
    record('finance', ids.loan).fields.opId = null;
    record('finance', ids.shopOperation).fields.ref = null;
    const result = reviewSnapshotDependencies(snapshot);
    expect(find(result.issues, ids.loan, ['opId'], ids.operation)).toBeUndefined();
    expect(find(result.issues, ids.shopOperation, ['ref'], ids.item)).toBeUndefined();
  });

  it('отклоняет неверные, дублирующиеся, приватные и неполные структуры', () => {
    record('characters', ids.hero).fields.partyIds.push('local-private-id');
    expect(() => reviewSnapshotDependencies(snapshot)).toThrow();
    record('characters', ids.hero).fields.partyIds = [ids.party, ids.party];
    expect(() => reviewSnapshotDependencies(snapshot)).toThrow();
    record('characters', ids.hero).fields.partyIds = [ids.party];
    record('marathons', ids.marathon).fields.progress[ids.hero] = 'private';
    expect(() => reviewSnapshotDependencies(snapshot)).toThrow();
    delete snapshot.sections.finance;
    expect(() => reviewSnapshotDependencies(snapshot)).toThrow();
  });

  it('не вызывает getters, не включает имена/значения в ошибки и не изменяет вход', () => {
    const get = vi.fn(() => 'PRIVATE_PASSWORD');
    Object.defineProperty(record('characters', ids.hero).fields, 'partyIds', { enumerable: true, get });
    expect(() => reviewSnapshotDependencies(snapshot)).toThrow();
    expect(get).not.toHaveBeenCalled();
    const again = fixture();
    const original = JSON.stringify(again.snapshot);
    again.snapshot.sections.characters.records[0].fields.partyIds = [randomId()];
    const result = reviewSnapshotDependencies(again.snapshot);
    expect(JSON.stringify(result)).not.toContain('Герой');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PASSWORD');
    expect(original).not.toBe(JSON.stringify(again.snapshot));
    const before = JSON.stringify(again.snapshot);
    result.issues[0].path[0] = 'altered';
    expect(JSON.stringify(again.snapshot)).toBe(before);
  });

  it('ограничивает число возвращаемых проблем вместо усечения результата', () => {
    record('characters', ids.hero).fields.partyIds = Array.from(
      { length: 10_001 },
      (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
    );
    expect(() => reviewSnapshotDependencies(snapshot)).toThrow('Слишком много проблем');
  });

  it('не отправляет сеть и не пишет в хранилище', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    try {
      reviewSnapshotDependencies(snapshot);
      expect(fetch).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      storage.mockRestore();
    }
  });
});

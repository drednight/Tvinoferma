import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { isVerifiedHistory, sealHistoryVersion, verifyHistory } from '../js/modules/cloudSync/history.js';
import { createFieldProvenanceReview } from '../js/modules/cloudSync/fieldProvenanceReview.js';

const id = () => generateSyncId(webcrypto);
const day = '2026-11-01';
let datasetId;
let recoveryKey;
let original;
let plannerId;
let characterId;

function makeSnapshot() {
  const state = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero-1', nick: 'Герой' }],
    plannerEntries: [
      {
        id: 'task-1',
        title: 'Задача дня',
        date: day,
        time: '18:00',
        kind: 'task',
        recurrence: 'daily',
        status: 'todo',
        statusByDate: { [day]: 'todo' }
      }
    ]
  });
  const { ui, ...raw } = state;
  const planned = planSyncIdentities({ snapshot: raw, cryptoSource: webcrypto }).snapshot;
  plannerId = planned.plannerEntries[0].syncId;
  characterId = planned.characters[0].syncId;
  return buildPublicSnapshot(planned);
}
const seal = (publicSnapshot, parent = null) =>
  sealHistoryVersion({
    publicSnapshot,
    parent,
    datasetId,
    recoveryKey,
    versionId: id(),
    cryptoSource: webcrypto
  });
const verify = (versions, root, knownPins = []) =>
  verifyHistory({
    envelopes: versions.map(version => version.envelope),
    expectedDatasetId: datasetId,
    recoveryKey,
    root: root.pin,
    knownPins,
    cryptoSource: webcrypto
  });
const planner = snapshot => snapshot.sections.planner.records.find(record => record.id === plannerId);
const character = snapshot => snapshot.sections.characters.records.find(record => record.id === characterId);
const paths = review => review.changes().map(change => change.path.join('/'));

async function branches() {
  const root = await seal(original);
  const localSnapshot = structuredClone(original);
  planner(localSnapshot).fields.title = 'Моя задача';
  const local = await seal(localSnapshot, root.pin);
  const remoteSnapshot = structuredClone(original);
  planner(remoteSnapshot).fields.time = '20:30';
  planner(remoteSnapshot).fields.statusByDate[day] = 'done';
  const remote = await seal(remoteSnapshot, root.pin);
  const tree = await verify([root, local, remote], root, [local.pin, remote.pin]);
  const review = createFieldProvenanceReview({
    history: tree,
    localPin: local.pin,
    remotePin: remote.pin,
    section: 'planner',
    id: plannerId
  });
  return { root, local, remote, tree, review, localSnapshot, remoteSnapshot };
}

beforeEach(() => {
  datasetId = id();
  recoveryKey = generateRecoveryKey(webcrypto);
  original = makeSnapshot();
});

describe('экспериментальный учёт происхождения отдельных полей', () => {
  it('запоминает только выбранное поле после проверки кандидата и оставляет остальное ожидающим', async () => {
    const { root, local, remote, review } = await branches();
    expect(paths(review)).toEqual(['statusByDate/2026-11-01', 'time']);
    const proposal = review.plan({ selected: [['statusByDate', day]] });
    expect(proposal.status).toBe('proposed');
    expect(proposal.details()).toEqual({
      selected: [{ path: ['statusByDate', day], kind: 'change_field', source: remote.pin }],
      pending: [{ path: ['time'], kind: 'change_field', source: remote.pin }]
    });
    expect(review.origins()).toEqual([]);
    expect(paths(review)).toHaveLength(2); // предложение ничего не подтверждает
    const candidate = proposal.proposedSnapshot();
    expect(planner(candidate).fields).toMatchObject({
      title: 'Моя задача',
      time: '18:00',
      statusByDate: { [day]: 'done' }
    });
    const committed = await seal(candidate, local.pin);
    const extended = await verify([root, local, remote, committed], root, [local.pin, remote.pin, committed.pin]);
    const next = proposal.bind({ history: extended, localPin: committed.pin, remotePin: remote.pin });
    expect(next.origins()).toEqual([{ path: ['statusByDate', day], source: remote.pin }]);
    expect(next.changes()).toEqual([{ path: ['time'], kind: 'change_field', source: remote.pin }]);
    expect(() => proposal.bind({ history: extended, localPin: committed.pin, remotePin: remote.pin })).toThrow(
      'уже использовано'
    );
    const leaked = next.origins();
    leaked[0].path[0] = 'altered';
    candidate.sections.planner.records[0].fields.time = 'постороннее изменение';
    expect(next.origins()[0].path).toEqual(['statusByDate', day]);
    expect(planner(proposal.proposedSnapshot()).fields.time).toBe('18:00');
  });

  it('не теряет ожидающее поле после локальной правки принятого и обнаруживает последующую конкурентную правку', async () => {
    const { root, local, remote, review, remoteSnapshot } = await branches();
    const first = review.plan({ selected: [['statusByDate', day]] });
    const accepted = await seal(first.proposedSnapshot(), local.pin);
    const tree1 = await verify([root, local, remote, accepted], root);
    const one = first.bind({ history: tree1, localPin: accepted.pin, remotePin: remote.pin });

    const editedSnapshot = first.proposedSnapshot();
    planner(editedSnapshot).fields.statusByDate[day] = 'doing';
    const edited = await seal(editedSnapshot, accepted.pin);
    const tree2 = await verify([root, local, remote, accepted, edited], root, [remote.pin]);
    const two = one.refresh({ history: tree2, localPin: edited.pin, remotePin: remote.pin });
    expect(paths(two)).toEqual(['time']);

    const second = two.plan({ selected: [['time']] });
    const finalLocal = await seal(second.proposedSnapshot(), edited.pin);
    const tree3 = await verify([root, local, remote, accepted, edited, finalLocal], root);
    const three = second.bind({ history: tree3, localPin: finalLocal.pin, remotePin: remote.pin });
    expect(three.changes()).toEqual([]);
    expect(three.origins()).toEqual([
      { path: ['statusByDate', day], source: remote.pin },
      { path: ['time'], source: remote.pin }
    ]);
    const remote2Snapshot = structuredClone(remoteSnapshot);
    planner(remote2Snapshot).fields.statusByDate[day] = 'todo';
    planner(remote2Snapshot).fields.time = '21:00';
    const remote2 = await seal(remote2Snapshot, remote.pin);
    const advanced = await verify([root, local, remote, accepted, edited, remote2, finalLocal], root);
    const four = three.refresh({ history: advanced, localPin: finalLocal.pin, remotePin: remote2.pin });
    expect(four.changes()).toEqual([
      { path: ['statusByDate', day], kind: 'conflict', reason: 'concurrent-edit', source: remote2.pin },
      { path: ['time'], kind: 'change_field', source: remote2.pin }
    ]);
    expect(four.plan({ selected: [['statusByDate', day], ['time']] }).status).toBe('needs_review');
    const clean = four.plan({ selected: [['time']] });
    const latest = await seal(clean.proposedSnapshot(), finalLocal.pin);
    const tree4 = await verify([root, local, remote, accepted, edited, remote2, finalLocal, latest], root);
    const five = clean.bind({ history: tree4, localPin: latest.pin, remotePin: remote2.pin });
    expect(five.origins()).toEqual([
      { path: ['statusByDate', day], source: remote.pin },
      { path: ['time'], source: remote.pin },
      { path: ['time'], source: remote2.pin }
    ]);
    expect(paths(five)).toEqual(['statusByDate/2026-11-01']);
  });

  it('не объявляет невыбранное принятым, даже когда его значение совпало с облачным локальной правкой', async () => {
    const { root, local, remote, review, localSnapshot } = await branches();
    planner(localSnapshot).fields.time = '20:30';
    const edited = await seal(localSnapshot, local.pin);
    const tree = await verify([root, local, remote, edited], root);
    expect(() => review.refresh({ history: tree, localPin: edited.pin, remotePin: remote.pin })).toThrow(
      'Ожидающее поле изменено локально'
    );
    expect(paths(review)).toEqual(['statusByDate/2026-11-01', 'time']);
    expect(review.origins()).toEqual([]);
  });

  it('блокирует предложение с отсутствующей пати и показывает незначащие личный текст данные о связи', async () => {
    const root = await seal(original);
    const local = await seal(original, root.pin);
    const cloud = structuredClone(original);
    const missing = id();
    character(cloud).fields.partyIds = [missing];
    const remote = await seal(cloud, root.pin);
    const tree = await verify([root, local, remote], root);
    const review = createFieldProvenanceReview({
      history: tree,
      localPin: local.pin,
      remotePin: remote.pin,
      section: 'characters',
      id: characterId
    });
    const proposal = review.plan({ selected: [['partyIds']] });
    expect(proposal.status).toBe('dependency_review');
    expect(proposal.details().issues).toContainEqual({
      code: 'missing',
      source: { section: 'characters', type: 'character', id: characterId },
      path: ['partyIds'],
      target: { id: missing, expectedType: 'parties:party', actualType: null }
    });
    expect(proposal.proposedSnapshot).toBeUndefined();
    expect(review.origins()).toEqual([]);
    expect(JSON.stringify(proposal.details())).not.toContain('Герой');
  });

  it('не подтверждает пустой выбор, конфликт или неподтверждённое исчезновение поля', async () => {
    const { root, local, remote, review, remoteSnapshot } = await branches();
    expect(review.plan({ selected: [] }).status).toBe('no_selection');
    const absent = structuredClone(remoteSnapshot);
    delete planner(absent).fields.statusByDate[day];
    const newRemote = await seal(absent, remote.pin);
    const tree = await verify([root, local, remote, newRemote], root);
    const fresh = createFieldProvenanceReview({
      history: tree,
      localPin: local.pin,
      remotePin: newRemote.pin,
      section: 'planner',
      id: plannerId
    });
    expect(fresh.plan({ selected: [['statusByDate', day]] }).status).toBe('needs_review');
    expect(fresh.origins()).toEqual([]);
  });

  it('отклоняет несовпадающее состояние и устаревшую облачную версию после просмотра', async () => {
    const { root, local, remote, review, remoteSnapshot } = await branches();
    const proposal = review.plan({ selected: [['time']] });
    const changed = proposal.proposedSnapshot();
    planner(changed).fields.title = 'Изменено после просмотра';
    const wrongLocal = await seal(changed, local.pin);
    const correctLocal = await seal(proposal.proposedSnapshot(), local.pin);
    const advancedRemote = await seal(remoteSnapshot, remote.pin);
    const tree = await verify([root, local, remote, wrongLocal, correctLocal, advancedRemote], root);
    expect(() => proposal.bind({ history: tree, localPin: wrongLocal.pin, remotePin: remote.pin })).toThrow(
      'Локальные данные изменились'
    );
    expect(() => proposal.bind({ history: tree, localPin: correctLocal.pin, remotePin: advancedRemote.pin })).toThrow(
      'Облачная версия изменилась'
    );
    expect(() => proposal.bind({ history: tree, localPin: correctLocal.pin, remotePin: remote.pin })).toThrow(
      'новая версия в известной истории'
    );
    expect(review.origins()).toEqual([]);
    const stillPending = review.refresh({ history: tree, localPin: local.pin, remotePin: remote.pin });
    expect(paths(stillPending)).toEqual(['statusByDate/2026-11-01', 'time']);
    expect(() => stillPending.plan({ selected: [['time']] })).toThrow('новая версия в известной истории');
    expect(() => stillPending.refresh({ history: tree, localPin: local.pin, remotePin: advancedRemote.pin })).toThrow(
      'ожидающими'
    );
  });

  it('после неверного локального кандидата может проверить исправленный, если облачная версия не изменилась', async () => {
    const { root, local, remote, review } = await branches();
    const proposal = review.plan({ selected: [['time']] });
    const wrong = proposal.proposedSnapshot();
    planner(wrong).fields.title = 'Другая правка';
    const wrongLocal = await seal(wrong, local.pin);
    const rightLocal = await seal(proposal.proposedSnapshot(), local.pin);
    const tree = await verify([root, local, remote, wrongLocal, rightLocal], root);
    expect(() => proposal.bind({ history: tree, localPin: wrongLocal.pin, remotePin: remote.pin })).toThrow(
      'Локальные данные изменились'
    );
    expect(proposal.bind({ history: tree, localPin: rightLocal.pin, remotePin: remote.pin }).origins()).toHaveLength(1);
  });

  it('блокирует изменённые соседние записи, хотя выбранная запись точно совпадает', async () => {
    const { root, local, remote, review } = await branches();
    const proposal = review.plan({ selected: [['time']] });
    const snapshot = proposal.proposedSnapshot();
    character(snapshot).fields.nick = 'Локальное изменение';
    const updated = await seal(snapshot, local.pin);
    const tree = await verify([root, local, remote, updated], root);
    expect(() => proposal.bind({ history: tree, localPin: updated.pin, remotePin: remote.pin })).toThrow(
      'Локальные данные изменились'
    );
  });

  it('не принимает чужую ветку вместо потомка и не перескакивает новую облачную ветку', async () => {
    const { root, local, remote, review } = await branches();
    const sibling = await seal(original, root.pin);
    const tree = await verify([root, local, remote, sibling], root);
    expect(() => review.refresh({ history: tree, localPin: sibling.pin, remotePin: remote.pin })).toThrow(
      'разветвление'
    );
    expect(() => review.refresh({ history: tree, localPin: local.pin, remotePin: sibling.pin })).toThrow(
      'разветвление'
    );
  });

  it('не подменяет результат проверки истории похожим объектом или Proxy', async () => {
    const { tree, local, remote } = await branches();
    expect(isVerifiedHistory(tree)).toBe(true);
    expect(isVerifiedHistory({ ...tree })).toBe(false);
    expect(isVerifiedHistory(new Proxy(tree, {}))).toBe(false);
    expect(() =>
      createFieldProvenanceReview({
        history: { ...tree },
        localPin: local.pin,
        remotePin: remote.pin,
        section: 'planner',
        id: plannerId
      })
    ).toThrow();
  });

  it('не считает удалённую или архивированную запись обычным обновлением поля', async () => {
    const root = await seal(original);
    const local = await seal(original, root.pin);
    const deleted = structuredClone(original);
    deleted.sections.characters.records = [];
    deleted.sections.characters.order.active = [];
    const remoteDeleted = await seal(deleted, root.pin);
    const archived = structuredClone(original);
    character(archived).archived = true;
    archived.sections.characters.order.active = [];
    archived.sections.characters.order.archived = [characterId];
    const remoteArchived = await seal(archived, root.pin);
    const tree = await verify([root, local, remoteDeleted, remoteArchived], root);
    expect(() =>
      createFieldProvenanceReview({
        history: tree,
        localPin: local.pin,
        remotePin: remoteDeleted.pin,
        section: 'characters',
        id: characterId
      })
    ).toThrow('Нет общей записи');
    expect(() =>
      createFieldProvenanceReview({
        history: tree,
        localPin: local.pin,
        remotePin: remoteArchived.pin,
        section: 'characters',
        id: characterId
      })
    ).toThrow('Архивация');
  });

  it('не вызывает getter запроса, не пишет данные в Storage и не отправляет сеть', async () => {
    const { review, tree, local, remote } = await branches();
    const getter = vi.fn(() => 'PRIVATE_PASSWORD');
    const options = { history: tree, localPin: local.pin, remotePin: remote.pin, section: 'planner', id: plannerId };
    Object.defineProperty(options, 'id', { enumerable: true, get: getter });
    expect(() => createFieldProvenanceReview(options)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    try {
      const result = review.plan({ selected: [['time']] });
      expect(result.status).toBe('proposed');
      expect(fetch).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(JSON.stringify(result.details())).not.toContain('Задача');
    } finally {
      fetch.mockRestore();
      storage.mockRestore();
    }
  });
});

// @ts-check
// Модель создания и удаления ОДНОЙ ручной записи календаря, только в памяти.
// Никакой записи, сети, подтверждения backup или решения за пользователя здесь нет.
// candidateState() может содержать локальные секреты: не логировать и не отправлять в облако.
// Текущие версии/список известных отпечатков должны быть получены и защищены вызывающей
// стороной; верификация переданного дерева не доказывает полноту облака или отсутствие отката.

import { generateSyncId, isSyncId, validateJsonSnapshot } from './envelope.js';
import { array, object } from './exportSchema.js';
import { isVerifiedHistory, MAX_HISTORY_VERSIONS } from './history.js';
import {
  copyPlannerCandidateValue as copy,
  equalPlannerCandidateValues as equal,
  validatePlannerCandidateEntry
} from './plannerCandidate.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { reviewSnapshotDependencies } from './reviewDependencies.js';

function invalid() {
  return new Error('Не удалось подготовить создание или удаление календаря: данные требуют проверки');
}
function stale() {
  return new Error('Локальные данные изменились после просмотра; требуется новое сравнение');
}
function blocked(reason) {
  return Object.freeze({ status: 'blocked', reason });
}
function pin(value) {
  const result = object(value, ['versionId', 'sha256']);
  return { versionId: result.versionId, sha256: result.sha256 };
}
function samePin(left, right) {
  return left.versionId === right.versionId && left.sha256 === right.sha256;
}
function manual(record) {
  return record?.type === 'plannerEntry' && record.fields.source.kind === 'manual';
}
function manualEntry(record, localId) {
  const fields = copy(record.fields);
  delete fields.source;
  const entry = { id: localId, syncId: record.id, ...fields };
  validatePlannerCandidateEntry(entry, record);
  return entry;
}

// Все параметры и локальный снимок проверяются до его чтения и изменения. Источники
// отпечатков могут быть ошибочны: функция не делает их независимыми или надёжными.
function context(input) {
  const history = input.history;
  if (!isVerifiedHistory(history) || !isSyncId(input.id) || typeof input.selected !== 'boolean') throw invalid();
  const localPin = pin(input.localPin);
  const remotePin = pin(input.remotePin);
  history.requirePin(localPin);
  history.requirePin(remotePin);
  const knownPins = array(input.expectedKnownPins, pin);
  if (!knownPins.length || knownPins.length > MAX_HISTORY_VERSIONS) throw invalid();
  if (new Set(knownPins.map(item => item.versionId)).size !== knownPins.length) throw invalid();
  for (const known of knownPins) history.requirePin(known);
  // Корень и используемая локальная версия обязательно входят в независимый список;
  // остальные ранее известные версии тоже обязан передать вызывающий код.
  if (!knownPins.some(item => samePin(item, history.identity().rootPin))) throw invalid();
  if (!knownPins.some(item => samePin(item, localPin))) throw invalid();

  validateJsonSnapshot(input.snapshot);
  const snapshot = copy(input.snapshot);
  const seenLocal = history.publicSnapshot(localPin);
  const localPublic = buildPublicSnapshot(snapshot, { settingsSelections: seenLocal.sections.preferences.selections });
  if (!equal(localPublic, seenLocal)) throw stale();
  const heads = history.observedHeads();
  const hasOtherBranches = heads.some(head => !samePin(head, localPin) && !samePin(head, remotePin));
  const ancestor = history.commonAncestor(localPin, remotePin);
  return { history, snapshot, localPublic, localPin, remotePin, ancestor, hasOtherBranches, id: input.id };
}

function since(history, ancestor, target) {
  const lineage = history.lineage(target);
  const index = lineage.findIndex(item => samePin(item, ancestor));
  if (index < 0) throw invalid();
  return lineage.slice(index);
}

// Порядок сохранившихся старых записей должен оставаться неизменным. Локально
// добавленные записи не считаются перестановкой, но их позиция также не импортируется.
function sameInheritedOrder(original, current) {
  const before = new Set(original);
  const after = new Set(current);
  return equal(
    original.filter(id => after.has(id)),
    current.filter(id => before.has(id))
  );
}

// Не создавать тот же локальный ID, даже если он использован в другой категории.
// Пространство sync-ID отдельно; сбор имён не выносит их наружу и не записывает в лог.
function localIdentity(snapshot, cryptoSource) {
  const used = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.id === 'string') used.add(value.id.toLowerCase());
    if (typeof value.syncId === 'string') used.add(value.syncId.toLowerCase());
    for (const item of Object.values(value)) visit(item);
  };
  visit(snapshot);
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = `planner-${generateSyncId(cryptoSource)}`;
    if (!used.has(id.toLowerCase())) return id;
  }
  throw invalid();
}

function prepared(context, proposed, details) {
  const actual = buildPublicSnapshot(context.snapshot, {
    settingsSelections: context.localPublic.sections.preferences.selections
  });
  if (!equal(actual, proposed)) throw invalid();
  // Проверка известных ссылок ограничена; нулевой список не разрешает импорт.
  // Не возвращаем пути или значения в ошибке/журнале.
  if (reviewSnapshotDependencies(proposed).issues.length) return blocked('dependency_review_required');
  return Object.freeze({
    status: 'prepared',
    // Только метаданные: содержимое записи показывается отдельно в просмотре.
    details: () => copy(details),
    candidateState: () => copy(context.snapshot),
    candidatePublicSnapshot: () => copy(proposed)
  });
}

/**
 * Подготовить создание новой ручной записи, выбранной целиком, в копии local state.
 * Сравнивается всё известное дерево; источник клана/неоднозначный ID блокируется.
 * Это НЕ разрешение сохранять результат и НЕ доказательство полноты истории.
 * @param {{snapshot: any, history: any, localPin: any, remotePin: any, expectedKnownPins: any[],
 * id: string, selected: boolean, cryptoSource?: Crypto}} options
 */
export function preparePlannerAddition(options) {
  const request = object(
    options,
    ['snapshot', 'history', 'localPin', 'remotePin', 'expectedKnownPins', 'id', 'selected'],
    ['cryptoSource']
  );
  const ctx = context(request);
  if (!request.selected) return blocked('selection_required');
  if (ctx.hasOtherBranches) return blocked('other_known_branches');
  const remote = ctx.history.plannerRecord(ctx.remotePin, ctx.id);
  if (!remote || ctx.history.plannerRecord(ctx.localPin, ctx.id) || ctx.history.plannerRecord(ctx.ancestor, ctx.id)) {
    return blocked('identity_uncertain');
  }
  if (!manual(remote)) return blocked('guild_requires_site_review');

  // ID должен впервые появиться на единственной удалённой линии после общего предка.
  // Даже старое исчезновение без метки или отдельная ветка с этим ID неоднозначны.
  const remoteLine = since(ctx.history, ctx.ancestor, ctx.remotePin);
  const allowed = new Set(remoteLine.map(item => item.versionId));
  let firstAppearance = null;
  let seen = false;
  for (const version of remoteLine) {
    const record = ctx.history.plannerRecord(version, ctx.id);
    if (record) {
      if (!manual(record)) return blocked('guild_requires_site_review');
      manualEntry(record, 'planner-validation');
      if (!seen) firstAppearance = version;
      seen = true;
    } else if (seen) return blocked('identity_uncertain');
  }
  for (const version of ctx.history.pins()) {
    if (!allowed.has(version.versionId) && ctx.history.plannerRecord(version, ctx.id))
      return blocked('identity_uncertain');
    if (ctx.history.plannerDeletions(version).includes(ctx.id)) return blocked('identity_uncertain');
  }
  if (!firstAppearance) throw invalid();

  const entry = manualEntry(remote, localIdentity(ctx.snapshot, request.cryptoSource));
  ctx.snapshot.plannerEntries.push(entry);
  const proposed = copy(ctx.localPublic);
  proposed.sections.planner.records.push(copy(remote));
  proposed.sections.planner.order.push(ctx.id);
  return prepared(ctx, proposed, {
    kind: 'add',
    id: ctx.id,
    localPin: ctx.localPin,
    remotePin: ctx.remotePin,
    ancestorPin: ctx.ancestor,
    firstAppearance
  });
}

/**
 * Подготовить удаление только после явной выбранной метки и отдельного подтверждения.
 * Локальные правки или перестановка старых записей с общего предка блокируют кандидат.
 * Клановые записи требуют отдельной проверки сайта и здесь не удаляются.
 * @param {{snapshot: any, history: any, localPin: any, remotePin: any, expectedKnownPins: any[],
 * id: string, selected: boolean, confirmedDeletion: boolean}} options
 */
export function preparePlannerDeletion(options) {
  const request = object(options, [
    'snapshot',
    'history',
    'localPin',
    'remotePin',
    'expectedKnownPins',
    'id',
    'selected',
    'confirmedDeletion'
  ]);
  if (typeof request.confirmedDeletion !== 'boolean') throw invalid();
  const ctx = context(request);
  if (!request.selected) return blocked('selection_required');
  if (!request.confirmedDeletion) return blocked('deletion_confirmation_required');
  if (ctx.hasOtherBranches) return blocked('other_known_branches');
  const base = ctx.history.plannerRecord(ctx.ancestor, ctx.id);
  const local = ctx.history.plannerRecord(ctx.localPin, ctx.id);
  const remote = ctx.history.plannerRecord(ctx.remotePin, ctx.id);
  if (!base || !local || remote) return blocked('identity_uncertain');
  if (!manual(base) || !manual(local)) return blocked('guild_requires_site_review');

  const originalOrder = ctx.history.plannerOrder(ctx.ancestor);
  for (const version of since(ctx.history, ctx.ancestor, ctx.localPin)) {
    const record = ctx.history.plannerRecord(version, ctx.id);
    if (!record || !manual(record) || !equal(record, base)) return blocked('local_edited');
    const order = ctx.history.plannerOrder(version);
    if (!sameInheritedOrder(originalOrder, order)) return blocked('local_reordered');
  }

  const remoteLine = since(ctx.history, ctx.ancestor, ctx.remotePin);
  let previous = base;
  let previousPin = ctx.ancestor;
  let deletionPin = null;
  let lastPresentPin = null;
  for (const version of remoteLine.slice(1)) {
    const record = ctx.history.plannerRecord(version, ctx.id);
    if (record && !manual(record)) return blocked('guild_requires_site_review');
    if (record) manualEntry(record, 'planner-validation');
    if (previous && !record) {
      if (!ctx.history.plannerDeletions(version).includes(ctx.id)) return blocked('missing_deletion_marker');
      deletionPin = version;
      lastPresentPin = previousPin;
    } else if (!previous && record) return blocked('identity_uncertain');
    previous = record;
    previousPin = version;
  }
  if (!deletionPin || !lastPresentPin) return blocked('missing_deletion_marker');

  const matches = ctx.snapshot.plannerEntries.filter(entry => entry.syncId === ctx.id);
  if (matches.length !== 1) throw invalid();
  // Дополнительная бизнес-проверка удаляемой локальной записи. Неподдерживаемые
  // поля/значения не нормализуются и не стираются, даже если синтаксический экспорт прошёл.
  validatePlannerCandidateEntry(matches[0], local);
  ctx.snapshot.plannerEntries = ctx.snapshot.plannerEntries.filter(entry => entry.syncId !== ctx.id);
  const proposed = copy(ctx.localPublic);
  proposed.sections.planner.records = proposed.sections.planner.records.filter(record => record.id !== ctx.id);
  proposed.sections.planner.order = proposed.sections.planner.order.filter(id => id !== ctx.id);
  return prepared(ctx, proposed, {
    kind: 'delete',
    id: ctx.id,
    localPin: ctx.localPin,
    remotePin: ctx.remotePin,
    ancestorPin: ctx.ancestor,
    deletionPin,
    lastPresentPin
  });
}

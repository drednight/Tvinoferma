// @ts-check
// Экспериментальное ТОЛЬКО ЧТЕНИЕ: сверка известных отпечатков истории и сравнение
// с зафиксированной копией локального публичного снимка. Есть узкий план объединения,
// но здесь нет backup, записи state, выбора за пользователя или разрешения конфликтов.
// Неполнота/откат всего облачного списка, локальной записи и часов не обнаруживаются.
// Результат содержит пользовательские поля: не логировать и рендерить только как текст.
import { isSyncId, MAX_SNAPSHOT_BYTES } from './envelope.js';
import { array, object } from './exportSchema.js';
import { comparePublicSnapshots, publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { MAX_HISTORY_VERSIONS, verifyHistory } from './history.js';
import { copyCloudEnvelope } from './providers/common.js';
import { parseCloudModifiedTime } from './providers/modifiedTime.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { preparePublicSnapshotApply } from './applyPublicSnapshot.js';
import { pendingSelectiveApplyEvents } from './pendingSelectiveApply.js';
import { privateDifferences, applyPrivateSelection } from './privateSnapshot.js';
import { conservativePlannerTransition, planConservativePublicMerge } from './conservativeMerge.js';

const MAX_HISTORY_CHARS = 64 * 1024 * 1024;
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
const verifiedReviews = new WeakSet();
const verifiedAdoptions = new WeakSet();
const verifiedConservativeAdoptions = new WeakSet();

/** Локальная capability для уже проверенного точного совпадения; это не гарантия полноты облака. */
export function isVerifiedCloudAdoption(value) {
  return !!value && typeof value === 'object' && verifiedAdoptions.has(value);
}

/** A merge proof is separate: it additionally requires a durable state marker. */
export function isVerifiedConservativeAdoption(value) {
  return !!value && typeof value === 'object' && verifiedConservativeAdoptions.has(value);
}

/** Маркер объекта текущего процесса, не доказательство независимости pin или полноты диска. */
export function isVerifiedCloudReview(value) {
  return !!value && typeof value === 'object' && verifiedReviews.has(value);
}
function failed() {
  return new Error('Не удалось безопасно подготовить сравнение облачных версий');
}
function result(status) {
  return Object.freeze({ status });
}
function pin(value) {
  const input = object(value, ['versionId', 'sha256']);
  if (!isSyncId(input.versionId) || typeof input.sha256 !== 'string' || !HEX.test(input.sha256)) throw failed();
  return Object.freeze({ versionId: input.versionId, sha256: input.sha256 });
}
function timestamp(value) {
  if (value === null) return null;
  const date = parseCloudModifiedTime(value);
  if (date === null) throw failed();
  return date;
}
function metadata(value) {
  const input = object(value, ['versionId', 'modifiedAt']);
  if (!isSyncId(input.versionId)) throw failed();
  return Object.freeze({ versionId: input.versionId, modifiedAt: timestamp(input.modifiedAt) });
}
function checkTime(now) {
  const value = now();
  if (!Number.isFinite(value) || Math.abs(value) > 8_640_000_000_000_000) throw failed();
  return timestamp(new Date(value).toISOString());
}
function savedSnapshot(value) {
  publicSnapshotIdentityTypes(value);
  let copy;
  try {
    // Отвергает Proxy и не оставляет общих ссылок с изменяемым состоянием приложения.
    copy = structuredClone(value);
  } catch {
    throw failed();
  }
  publicSnapshotIdentityTypes(copy);
  if (new TextEncoder().encode(JSON.stringify(copy)).length > MAX_SNAPSHOT_BYTES) throw failed();
  return copy;
}

// Only a previously saved, deletion-only selective apply can bridge a changed
// state to an older pending intent. No edits, settings, additions or other source
// pins may be inferred from the absence of a record.
function validatesAppliedPlannerDeletionIntent(intent, local, events, provider, datasetId, target, tombstones) {
  if (!intent || !events.length) return false;
  publicSnapshotIdentityTypes(intent);
  const allowed = new Set(tombstones);
  const original = new Set(
    intent.sections.planner.records.filter(record => record.fields.source.kind === 'manual').map(record => record.id)
  );
  const selected = new Set();
  for (const event of events) {
    if (
      event.provider !== provider ||
      event.datasetId !== datasetId ||
      event.pin.versionId !== target.versionId ||
      event.pin.sha256 !== target.sha256 ||
      event.settings.length ||
      event.financeSettings ||
      !event.records.length
    )
      return false;
    for (const record of event.records) {
      if (
        record.section !== 'planner' ||
        !allowed.has(record.id) ||
        !original.has(record.id) ||
        selected.has(record.id)
      )
        return false;
      selected.add(record.id);
    }
  }
  const expected = structuredClone(intent);
  expected.sections.planner.records = expected.sections.planner.records.filter(record => !selected.has(record.id));
  expected.sections.planner.order = expected.sections.planner.order.filter(id => !selected.has(id));
  const difference = comparePublicSnapshots({ local: expected, cloud: local });
  return difference.entries.length === 0 && difference.uncomparedSettings.length === 0;
}

/**
 * Загружает каждую наблюдаемую версию и проверяет дерево против отдельно доверенных root/knownPins.
 * Целевой файл НЕ выбирается по дате и не применяется. localSavedAt передаётся только
 * если известна его реальная привязка к снимку, иначе null; checkedAt — локальные часы.
 * После получения результата локальные данные могли измениться: для применения нужен
 * повторный witness, backup, проверка зависимостей и отдельное подтверждение. При отмене
 * уже начатое native-чтение может продолжаться; следующее чтение не запускается.
 *
 * @param {{provider:'google'|'yandex',session:any,datasetId:string,dataKey:string,rootPin:any,
 * knownPins:any[],localSnapshot:any,localSavedAt:string|null,now?:()=>number,cryptoSource?:Crypto,signal?:AbortSignal}} options
 */
export async function prepareCloudReview(options) {
  let input, root, known, local, savedAt;
  try {
    input = object(
      options,
      ['provider', 'session', 'datasetId', 'dataKey', 'rootPin', 'knownPins', 'localSnapshot', 'localSavedAt'],
      ['now', 'cryptoSource', 'signal']
    );
    if (
      !['google', 'yandex'].includes(input.provider) ||
      !isSyncId(input.datasetId) ||
      typeof input.dataKey !== 'string' ||
      !input.session ||
      typeof input.session.listWithDates !== 'function' ||
      typeof input.session.read !== 'function' ||
      (input.now !== undefined && typeof input.now !== 'function') ||
      (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== 'boolean'))
    )
      throw failed();
    root = pin(input.rootPin);
    known = array(input.knownPins, pin);
    if (known.length > MAX_HISTORY_VERSIONS || new Set(known.map(item => item.versionId)).size !== known.length)
      throw failed();
    local = savedSnapshot(input.localSnapshot);
    savedAt = timestamp(input.localSavedAt);
  } catch {
    throw failed();
  }
  const { session, provider, datasetId, dataKey, cryptoSource } = input;
  const now = input.now || Date.now;
  const signal = input.signal;
  if (signal?.aborted) return result('cancelled');
  try {
    const listing = object(await session.listWithDates(), ['status'], ['versions']);
    if (signal?.aborted) return result('cancelled');
    if (listing.status === 'account_mismatch' || listing.status === 'account_unavailable')
      return result(listing.status);
    if (listing.status !== 'listed') return result('unavailable');
    const versions = array(listing.versions, metadata);
    if (
      versions.length > MAX_HISTORY_VERSIONS ||
      new Set(versions.map(item => item.versionId)).size !== versions.length
    )
      throw failed();
    const envelopes = [];
    let total = 0;
    for (const item of versions) {
      if (signal?.aborted) return result('cancelled');
      const received = object(await session.read(item.versionId), ['status'], ['envelope']);
      if (signal?.aborted) return result('cancelled');
      if (received.status === 'account_mismatch' || received.status === 'account_unavailable')
        return result(received.status);
      if (received.status === 'not_found' || received.status === 'identity_mismatch') return result('changed');
      if (received.status !== 'found') return result('unavailable');
      const envelope = copyCloudEnvelope(received.envelope, datasetId);
      if (envelope.versionId !== item.versionId) return result('changed');
      total += envelope.ciphertext.length + envelope.iv.length + (envelope.keyCapsule?.length || 0);
      if (total > MAX_HISTORY_CHARS) throw failed();
      envelopes.push(envelope);
    }
    let history;
    try {
      history = await verifyHistory({
        envelopes,
        expectedDatasetId: datasetId,
        recoveryKey: dataKey,
        root,
        knownPins: known,
        cryptoSource
      });
    } catch {
      if (signal?.aborted) return result('cancelled');
      // Список, ключ, версия или доверенные отпечатки не прошли проверку.
      return result('history_unverified');
    }
    if (signal?.aborted) return result('cancelled');
    const pins = new Map(history.pins().map(item => [item.versionId, pin(item)]));
    const heads = new Set(history.observedHeads().map(item => item.versionId));
    const observations = Object.freeze(
      versions.map(item => {
        const current = pins.get(item.versionId);
        if (!current) throw failed();
        return Object.freeze({ pin: current, modifiedAt: item.modifiedAt, observedHead: heads.has(item.versionId) });
      })
    );
    const checkedAt = checkTime(now);
    const ready = Object.freeze({
      status: 'ready_for_review',
      provider,
      datasetId,
      checkedAt,
      localSavedAt: savedAt,
      versions: observations,
      comparePrivate(selectedPin, localState, fields) {
        const selected = pin(selectedPin);
        const current = pins.get(selected.versionId);
        if (!current || current.sha256 !== selected.sha256) throw failed();
        return privateDifferences(
          history.privateSnapshot(current),
          history.publicSnapshot(current),
          localState,
          fields
        );
      },
      preparePrivateApply(selectedPin, localState, selections) {
        const selected = pin(selectedPin);
        const current = pins.get(selected.versionId);
        const heads = history.observedHeads();
        if (
          !current ||
          current.sha256 !== selected.sha256 ||
          heads.length !== 1 ||
          heads[0].versionId !== selected.versionId ||
          heads[0].sha256 !== selected.sha256
        )
          throw failed();
        return applyPrivateSelection(
          history.privateSnapshot(current),
          history.publicSnapshot(current),
          localState,
          selections
        );
      },

      /**
       * Узкое согласование: локальный публичный снимок должен полностью и точно
       * совпасть с единственной наблюдаемой головой. Все отметки частичных
       * применений должны относиться к её проверенной линии. Это не разрешение
       * конфликта или доказательство полноты списка облака.
       * @param {{versionId:string,sha256:string}} selectedPin
       * @param {any} settings
       */
      prepareExactAdoption(selectedPin, settings) {
        const selected = pin(selectedPin);
        const head = history.observedHeads();
        if (head.length !== 1 || head[0].versionId !== selected.versionId || head[0].sha256 !== selected.sha256)
          return result('not_unique_head');
        const current = pins.get(selected.versionId);
        if (!current || current.sha256 !== selected.sha256) return result('changed');
        if (JSON.stringify(local) !== JSON.stringify(history.publicSnapshot(current))) return result('not_exact');
        const lineage = history.lineage(current);
        const ancestors = new Map(lineage.map(value => [value.versionId, value.sha256]));
        const events = pendingSelectiveApplyEvents(settings);
        if (
          events.some(
            event =>
              event.provider !== provider ||
              event.datasetId !== datasetId ||
              ancestors.get(event.pin.versionId) !== event.pin.sha256
          )
        )
          return result('unresolved_sources');
        let previousIds = new Map();
        for (const node of lineage) {
          const declared = new Set(history.plannerDeletions(node));
          if (declared.size && !history.usesPlannerTombstones(node)) return result('deletions_unsupported');
          const ids = publicSnapshotIdentityTypes(history.publicSnapshot(node));
          if (
            [...previousIds].some(
              ([id, type]) =>
                ids.get(id) !== type && !(type === 'planner:plannerEntry' && !ids.has(id) && declared.has(id))
            )
          )
            return result('deletions_unsupported');
          previousIds = ids;
        }
        const found = envelopes.find(envelope => envelope.versionId === current.versionId);
        if (!found || found.version !== 2) return result('unsupported_version');
        const proof = Object.freeze({
          status: 'ready_for_adoption',
          provider,
          datasetId,
          rootPin: Object.freeze({ ...root }),
          pin: Object.freeze({ ...current }),
          // Точные пины всей наблюдаемой линии нужны для безопасного переноса
          // уже подтверждённой локальной очереди на более новую основу.
          lineage: Object.freeze(lineage.map(value => Object.freeze({ ...value }))),
          envelope: Object.freeze({ ...found })
        });
        verifiedAdoptions.add(proof);
        return proof;
      },
      /**
       * Узкое трёхстороннее объединение от отдельно подтверждённой локальной
       * основы к единственной наблюдаемой облачной голове. Это read-only план;
       * полнота облака и отсутствие отката всё равно не доказаны.
       * @param {{versionId:string,sha256:string}} selectedPin
       * @param {{versionId:string,sha256:string}} basePin
       * @param {any} settings
       * @param {boolean} [allowDescendantHead] only when resuming an already saved intent
       * @param {any} [resolution] explicit conflict choices, never inferred from dates
       * @param {any} [appliedIntentSnapshot] authenticated queued public intent for deletion-only repair
       */
      prepareConservativeAdoption(
        selectedPin,
        basePin,
        settings,
        allowDescendantHead = false,
        resolution,
        appliedIntentSnapshot
      ) {
        const selectedResolution = resolution ? structuredClone(resolution) : null;
        const selected = pin(selectedPin);
        const base = pin(basePin);
        const head = history.observedHeads();
        if (head.length !== 1) return result('not_unique_head');
        const current = pins.get(selected.versionId);
        if (!current || current.sha256 !== selected.sha256) return result('changed');
        if (head[0].versionId !== selected.versionId || head[0].sha256 !== selected.sha256) {
          if (
            !allowDescendantHead ||
            !history
              .lineage(head[0])
              .some(value => value.versionId === selected.versionId && value.sha256 === selected.sha256)
          )
            return result('not_unique_head');
        }
        const lineage = history.lineage(current);
        const baseIndex = lineage.findIndex(
          value => value.versionId === base.versionId && value.sha256 === base.sha256
        );
        if (baseIndex < 0) return result('base_not_ancestor');
        if (baseIndex === lineage.length - 1) return result('already_on_base');
        const privateBase = JSON.stringify(history.privateSnapshot(lineage[baseIndex]));
        if (lineage.slice(baseIndex + 1).some(node => JSON.stringify(history.privateSnapshot(node)) !== privateBase))
          return result('private_transfer_review_required');

        const appliedEvents = pendingSelectiveApplyEvents(settings);
        const tombstones = history.usesPlannerTombstones(current) ? history.plannerTombstones(current) : [];
        let retained = null;
        if (appliedEvents.length) {
          if (
            !history.usesPlannerTombstones(current) ||
            !validatesAppliedPlannerDeletionIntent(
              appliedIntentSnapshot,
              local,
              appliedEvents,
              provider,
              datasetId,
              current,
              tombstones
            )
          )
            return result('unresolved_sources');
          retained = savedSnapshot(appliedIntentSnapshot);
        } else if (appliedIntentSnapshot) return result('unresolved_sources');
        let previousIds = new Map();
        for (const node of lineage) {
          const declared = new Set(history.plannerDeletions(node));
          if (declared.size && !history.usesPlannerTombstones(node)) return result('deletions_unsupported');
          const ids = publicSnapshotIdentityTypes(history.publicSnapshot(node));
          if (
            [...previousIds].some(
              ([id, type]) =>
                ids.get(id) !== type && !(type === 'planner:plannerEntry' && !ids.has(id) && declared.has(id))
            )
          )
            return result('deletions_unsupported');
          previousIds = ids;
        }
        for (let index = baseIndex + 1; index < lineage.length; index++) {
          const next = lineage[index];
          if (
            !conservativePlannerTransition(
              history.publicSnapshot(lineage[index - 1]),
              history.publicSnapshot(next),
              history.usesPlannerTombstones(next) ? history.plannerTombstones(next) : []
            )
          )
            return result('transition_unsupported');
        }
        const plan = planConservativePublicMerge({
          base: history.publicSnapshot(lineage[baseIndex]),
          local,
          cloud: history.publicSnapshot(current),
          cloudPlannerTombstones: tombstones,
          ...(selectedResolution ? { resolution: selectedResolution } : {})
        });
        if (plan.status !== 'prepared') return plan;
        const found = envelopes.find(envelope => envelope.versionId === current.versionId);
        if (!found || found.version !== 2) return result('unsupported_version');
        const proof = Object.freeze({
          status: 'ready_for_adoption',
          provider,
          datasetId,
          rootPin: Object.freeze({ ...root }),
          basePin: Object.freeze({ ...base }),
          pin: Object.freeze({ ...current }),
          lineage: Object.freeze(lineage.map(value => Object.freeze({ ...value }))),
          envelope: Object.freeze({ ...found }),
          localSnapshot: () => structuredClone(local),
          retainedSnapshot: () => structuredClone(retained || local),
          resolution: () => (selectedResolution ? structuredClone(selectedResolution) : null),
          plan: () => plan
        });
        verifiedConservativeAdoptions.add(proof);
        return proof;
      },
      /**
       * Явный выбор точного отпечатка. Отсутствие записи в одной стороне не объявляется
       * удалением; результат read-only, содержит значения и может устареть.
       * @param {{versionId:string,sha256:string}} selectedPin
       */
      compare(selectedPin) {
        const selected = pin(selectedPin);
        const current = pins.get(selected.versionId);
        if (!current || current.sha256 !== selected.sha256) throw failed();
        const file = observations.find(item => item.pin.versionId === selected.versionId);
        const cloud = history.publicSnapshot(current);
        const sections = ['characters', 'parties', 'marathons', 'planner', 'finance'];
        const records = new Map(
          sections.map(section => [
            section,
            new Map(cloud.sections[section].records.map(record => [record.id, record]))
          ])
        );
        const localRecords = new Map(
          sections.map(section => [
            section,
            new Map(local.sections[section].records.map(record => [record.id, record]))
          ])
        );
        // Метка в проверенной линии — не вывод из отсутствия записи и не разрешение
        // удалять её с ПК. Маркеры других ветвей или будущих версий не учитываются.
        const deletedPlannerIds = new Set(history.plannerTombstones(current));
        const canApplyDeletions =
          history.usesPlannerTombstones(current) && heads.size === 1 && heads.has(current.versionId);
        const differences = comparePublicSnapshots({ local, cloud });
        differences.entries = differences.entries.map(entry =>
          entry.section === 'planner' && entry.kind === 'only_local' && deletedPlannerIds.has(entry.id)
            ? {
                ...entry,
                kind: 'marked_cloud_deletion',
                deletionSelectable:
                  canApplyDeletions && localRecords.get('planner').get(entry.id)?.fields.source.kind === 'manual'
              }
            : entry
        );
        for (const entry of [...differences.entries]) {
          if (entry.section === 'planner' && entry.kind === 'identity_review' && deletedPlannerIds.has(entry.localId)) {
            differences.entries.push({
              section: 'planner',
              id: entry.localId,
              type: 'plannerEntry',
              label: entry.label,
              kind: 'marked_cloud_deletion',
              changes: []
            });
          }
        }
        return Object.freeze({
          provider,
          checkedAt,
          localSavedAt: savedAt,
          cloudModifiedAt: file.modifiedAt,
          pin: current,
          differences,
          /** Публичная запись без контактов и локальных путей; её текст всё равно может быть личным. */
          localRecord(section, id) {
            if (!localRecords.has(section) || !isSyncId(id)) throw failed();
            const record = localRecords.get(section).get(id);
            return record ? structuredClone(record) : null;
          },
          cloudRecord(section, id) {
            if (!records.has(section) || !isSyncId(id)) throw failed();
            const record = records.get(section).get(id);
            return record ? structuredClone(record) : null;
          }
        });
      },
      /**
       * Подготовить только выбранные записи конкретной проверенной версии. Это ещё
       * не запись: кандидат содержит локальные секреты и может сразу устареть.
       * Частичное применение не означает слияния или принятия всей облачной ветки.
       * @param {{versionId:string,sha256:string}} selectedPin
       * @param {{localState:any,selectedRecords:{section:string,id:string}[],selectedSettings?:string[],includeFinanceSettings?:boolean,selectedPlannerDeletions?:string[],cryptoSource?:Crypto}} choices
       */
      prepareApply(selectedPin, choices) {
        const selected = pin(selectedPin);
        const current = pins.get(selected.versionId);
        if (!current || current.sha256 !== selected.sha256) throw failed();
        const deletions = array(choices.selectedPlannerDeletions || [], value => {
          if (!isSyncId(value)) throw failed();
          return value;
        });
        if (deletions.length) {
          const heads = history.observedHeads();
          if (heads.length !== 1 || heads[0].versionId !== current.versionId || heads[0].sha256 !== current.sha256)
            throw failed();
          const declared = new Set(history.plannerTombstones(current));
          if (deletions.some(id => !declared.has(id))) throw failed();
          // Legacy v2 had no durable cumulative protocol and remains read-only.
          if (!history.usesPlannerTombstones(current)) throw failed();
        }
        const currentLocal = buildPublicSnapshot(choices.localState, {
          settingsSelections: local.sections.preferences.selections
        });
        const difference = comparePublicSnapshots({ local, cloud: currentLocal });
        if (difference.entries.length || difference.uncomparedSettings.length) {
          throw new Error('Локальные данные изменились после проверки; требуется новое сравнение');
        }
        return preparePublicSnapshotApply({ ...choices, cloudSnapshot: history.publicSnapshot(current) });
      }
    });
    verifiedReviews.add(ready);
    return ready;
  } catch {
    if (signal?.aborted) return result('cancelled');
    // Ошибка транспорта может содержать OAuth, временную ссылку или данные пользователя.
    throw failed();
  }
}

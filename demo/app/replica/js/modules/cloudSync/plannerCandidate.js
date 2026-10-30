// @ts-check
// Предварительный мост от просмотренного публичного снимка к ЛОКАЛЬНОЙ копии state.
// Только поля существующей записи календаря. Не применяет и не сохраняет состояние,
// не вызывает сайт клана, не подтверждает облако или локальную резервную копию.
// Возвращаемая копия может содержать контакты и другие локальные секреты: не отправлять
// её в облако и не помещать в журнал. Перед настоящим применением нужны доверенные пины,
// актуальность всех данных, согласованная копия хранилищ и подтверждённая запись.

import { normalizePlannerEntry } from '../dashboard/planner.js';
import { isSyncId, validateJsonSnapshot } from './envelope.js';
import { array, object, text } from './exportSchema.js';
import {
  createFieldProvenanceReview,
  fieldProvenanceContext,
  restoreFieldProvenanceCheckpoint,
  sealFieldProvenanceCheckpoint
} from './fieldProvenanceReview.js';
import { exportPlannerEntry } from './plannerExport.js';
import { buildPublicSnapshot } from './publicSnapshot.js';

const EDITABLE_FIELDS = new Set([
  'title',
  'date',
  'time',
  'durationMinutes',
  'kind',
  'priority',
  'reminderMinutes',
  'recurrence',
  'recurrenceEnd',
  'color',
  'status',
  'statusByDate',
  'updatedAt'
]);

function invalid() {
  // Локальные ID, названия, заметки и другие данные не попадают в ошибки.
  return new Error('Не удалось подготовить изменение календаря: данные или выбор требуют проверки');
}

function stale() {
  return new Error('Локальные данные изменились после просмотра; требуется новое сравнение');
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// validateJsonSnapshot заранее ограничивает глубину и запрещает исполняемые поля.
function equal(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (plain(left) && plain(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
  }
  return false;
}

// StructuredClone отклоняет Proxy, но сохраняет общие ссылки. JSON на диске — дерево:
// развязываем ссылки до изменения записи, иначе правка календаря могла бы затронуть
// другое, в том числе непубличное поле, указывающее на тот же объект.
function copy(value) {
  try {
    const cloned = structuredClone(value);
    let units = 0;
    const detach = item => {
      units += 16 + (typeof item === 'string' ? item.length : 0);
      if (units > 32 * 1024 * 1024) throw invalid();
      if (!item || typeof item !== 'object') return item;
      if (Array.isArray(item)) return item.map(detach);
      return Object.fromEntries(
        Object.keys(item).map(key => {
          units += key.length;
          if (units > 32 * 1024 * 1024) throw invalid();
          return [key, detach(item[key])];
        })
      );
    };
    return detach(cloned);
  } catch {
    throw invalid();
  }
}

function validDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function validTime(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  return Number(value.slice(0, 2)) <= 23 && Number(value.slice(3, 5)) <= 59;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !validDate(match[1]) || !validTime(match[2]) || Number(match[3]) > 59) return false;
  return Number.isFinite(Date.parse(value));
}

/** Проверка до нормализатора: недопустимые входящие значения нельзя тихо исправлять. */
export function validatePlannerCandidateEntry(entry, publicRecord) {
  // Общая проверка пригодна и для новой записи: не обращаемся к getter'ам до проверки.
  validateJsonSnapshot({ entry, publicRecord });
  if (!plain(entry) || !plain(publicRecord)) throw invalid();
  if (
    typeof entry.title !== 'string' ||
    !entry.title ||
    entry.title !== entry.title.trim() ||
    entry.title.length > 160 ||
    !validDate(entry.date) ||
    !validTime(entry.time) ||
    !Number.isSafeInteger(entry.durationMinutes) ||
    entry.durationMinutes < 1 ||
    entry.durationMinutes > 1440 ||
    !Number.isSafeInteger(entry.reminderMinutes) ||
    entry.reminderMinutes < 0 ||
    entry.reminderMinutes > 525600 ||
    (entry.recurrenceEnd !== '' && !validDate(entry.recurrenceEnd)) ||
    !validTimestamp(entry.createdAt) ||
    !validTimestamp(entry.updatedAt)
  )
    throw invalid();
  if (!plain(entry.statusByDate)) throw invalid();
  for (const date of Object.keys(entry.statusByDate)) if (!validDate(date)) throw invalid();

  // Экспорт проверяет перечисления, точные поля и восстанавливает источник из локального id.
  // Нормализатор не должен обрезать, заменять или терять ни одно значение.
  const exported = exportPlannerEntry(entry, { syncId: publicRecord.id });
  if (!equal(exported, publicRecord) || !equal(normalizePlannerEntry(entry), entry)) throw invalid();
}

// Для других изолированных моделей; вызывающая сторона сначала проверяет JSON.
// Копия может содержать секреты и предназначена только для локальной памяти.
export { copy as copyPlannerCandidateValue, equal as equalPlannerCandidateValues };

function safePin(value) {
  const pin = object(value, ['versionId', 'sha256']);
  return { versionId: pin.versionId, sha256: pin.sha256 };
}

// Отдельная модель одного просмотра. Никакого state или I/O она не удерживает.
function makePlannerReview({ history, localPin, remotePin, id, fieldReview }) {
  let active = true;
  const requireActive = () => {
    if (!active) throw new Error('Просмотр уже заменён; требуется актуальная версия');
  };
  return Object.freeze({
    changes() {
      requireActive();
      return fieldReview.changes();
    },
    origins() {
      requireActive();
      return fieldReview.origins();
    },
    /**
     * Только зашифрованная модель в памяти. Вызывающий код должен отдельно организовать
     * независимые ключи/пины и атомарную запись; этот метод ничего не сохраняет.
     * @param {{datasetId: string, deviceId: string, checkpointKey: string, cryptoSource?: Crypto}} options
     */
    async sealCheckpoint(options) {
      requireActive();
      const request = object(options, ['datasetId', 'deviceId', 'checkpointKey'], ['cryptoSource']);
      const result = await sealFieldProvenanceCheckpoint({ review: fieldReview, ...request });
      // Нельзя возвращать checkpoint старого просмотра, пока создаётся новый.
      requireActive();
      return result;
    },
    /** @param {{snapshot: any, selected: string[][]}} options */
    plan(options) {
      requireActive();
      const request = object(options, ['snapshot', 'selected']);
      validateJsonSnapshot(request.snapshot);
      validateJsonSnapshot({ selected: request.selected });
      const selected = array(request.selected, path => array(path, text));
      for (const path of selected) {
        if (
          !path.length ||
          !EDITABLE_FIELDS.has(path[0]) ||
          (path[0] === 'statusByDate' ? path.length !== 2 || !validDate(path[1]) : path.length !== 1)
        )
          throw invalid();
      }
      const localState = copy(request.snapshot);
      const seenLocal = history.publicSnapshot(localPin);
      const localPublic = buildPublicSnapshot(localState, {
        settingsSelections: seenLocal.sections.preferences.selections
      });
      if (!equal(localPublic, seenLocal)) throw stale();

      const proposal = fieldReview.plan({ selected });
      if (proposal.status !== 'proposed') {
        return Object.freeze({ status: proposal.status, details: () => copy(proposal.details()) });
      }
      const proposedPublic = proposal.proposedSnapshot();
      const records = proposedPublic.sections.planner.records.filter(record => record.id === id);
      const localMatches = localState.plannerEntries.filter(entry => entry.syncId === id);
      if (records.length !== 1 || localMatches.length !== 1 || records[0].type !== 'plannerEntry') throw invalid();
      const record = records[0];
      const entry = localMatches[0];
      // Источник, createdAt, локальный id и syncId не копируются из облака.
      for (const field of EDITABLE_FIELDS) entry[field] = copy(record.fields[field]);
      validatePlannerCandidateEntry(entry, record);
      const roundTrip = buildPublicSnapshot(localState, {
        settingsSelections: seenLocal.sections.preferences.selections
      });
      if (!equal(roundTrip, proposedPublic)) throw invalid();

      const details = proposal.details();
      return Object.freeze({
        status: 'prepared',
        details: () => copy(details),
        // Эти методы выдают независимые копии; состояние содержит локальные секреты.
        candidateState: () => copy(localState),
        candidatePublicSnapshot: () => copy(proposedPublic),
        /**
         * Только модель: проверяет публичную версию, но НЕ подтверждает запись на диск.
         * Нельзя вызывать в реальном обмене без отдельной проверенной транзакции.
         * @param {{history: any, localPin: any, remotePin: any}} options
         */
        bindModel(options) {
          requireActive();
          const next = object(options, ['history', 'localPin', 'remotePin']);
          const nextLocal = safePin(next.localPin);
          const nextRemote = safePin(next.remotePin);
          const nextField = proposal.bind({ history: next.history, localPin: nextLocal, remotePin: nextRemote });
          const result = makePlannerReview({
            history: next.history,
            localPin: nextLocal,
            remotePin: nextRemote,
            id,
            fieldReview: nextField
          });
          active = false;
          return result;
        }
      });
    },
    /**
     * Только модель: продвижение к проверенным версиям без фактической записи данных.
     * @param {{history: any, localPin: any, remotePin: any}} options
     */
    refreshModel(options) {
      requireActive();
      const next = object(options, ['history', 'localPin', 'remotePin']);
      const nextLocal = safePin(next.localPin);
      const nextRemote = safePin(next.remotePin);
      const nextField = fieldReview.refresh({ history: next.history, localPin: nextLocal, remotePin: nextRemote });
      const result = makePlannerReview({
        history: next.history,
        localPin: nextLocal,
        remotePin: nextRemote,
        id,
        fieldReview: nextField
      });
      active = false;
      return result;
    }
  });
}

/**
 * Создаёт предварительный просмотр ОДНОЙ существующей записи календаря. История — результат
 * verifyHistory; доверенный корень, полнота облака и реальная запись проверяются отдельно.
 *
 * plan принимает сериализованный snapshot без ui. Статус `prepared` — только кандидат в
 * памяти, а не разрешение на запись. bindModel/refreshModel сохраняют происхождение выбранных
 * полей исключительно в этой модели и не подтверждают ни backup, ни сохранение на диск.
 * @param {{history: any, localPin: any, remotePin: any, id: string}} options
 */
export function createPlannerCandidateReview(options) {
  const request = object(options, ['history', 'localPin', 'remotePin', 'id']);
  if (!isSyncId(request.id)) throw invalid();
  const localPin = safePin(request.localPin);
  const remotePin = safePin(request.remotePin);
  const fieldReview = createFieldProvenanceReview({
    history: request.history,
    localPin,
    remotePin,
    section: 'planner',
    id: request.id
  });
  return makePlannerReview({ history: request.history, localPin, remotePin, id: request.id, fieldReview });
}

/**
 * Восстановление лишь бизнес-модели календаря из checkpoint. Требуются независимые доверенные
 * отметки и проверка актуальной публичной проекции; запись и надёжное хранилище не подключены.
 * @param {Parameters<typeof restoreFieldProvenanceCheckpoint>[0]} options
 */
export async function restorePlannerCandidateCheckpoint(options) {
  const fieldReview = await restoreFieldProvenanceCheckpoint(options);
  const context = fieldProvenanceContext(fieldReview);
  if (context.section !== 'planner') throw invalid();
  return makePlannerReview({ ...context, fieldReview });
}

/**
 * Одноразовый вариант для подготовки кандидата; методы bindModel/refreshModel остаются
 * модельными проверками и не доказывают сохранение. Локальная копия может содержать секреты.
 * @param {{snapshot: any, history: any, localPin: any, remotePin: any, id: string, selected: string[][]}} options
 */
export function preparePlannerCandidate(options) {
  const request = object(options, ['snapshot', 'history', 'localPin', 'remotePin', 'id', 'selected']);
  const review = createPlannerCandidateReview({
    history: request.history,
    localPin: request.localPin,
    remotePin: request.remotePin,
    id: request.id
  });
  return review.plan({ snapshot: request.snapshot, selected: request.selected });
}

// @ts-check
// js/data/import.js
// Импорт JSON: разбор файла → сводка (новые / совпадающие / одинаковые) →
// сравнение каждой совпавшей пары (data/compare.js) → применение.
// Совпадение персонажей — по id (id = ник, см. core/ids.js) или по нику без учёта регистра.

import { state, normalizeState, normalizeCharacter } from '../core/state.js';
import {
  saveNow,
  createBackup,
  forceRenderAndPersist,
  assertStateWriteAvailable,
  haltAfterPartialStateChange
} from '../core/storage.js';
import { characterIdFor } from '../core/ids.js';
import { detectVersion, SCHEMA_VERSION } from '../core/migrations.js';
import { showModal, toast } from '../core/ui.js';
import { escapeHtml } from '../core/utils.js';
import { diffCharacters, presentPaths, buildMerged, setPartyNameResolver } from './characterFields.js';
import { planPartyImport, remapCharacterParties, partyNamesOf } from '../modules/parties/membership.js';
import { openCompareDialog } from './compare.js';
import { syncIdWithNick } from '../modules/characters/identity.js';
import { normalizeFinance } from '../modules/finance/model.js';

const CONTACT_KEYS = ['email', 'password', 'recoveryEmail', 'phone'];
let importInProgress = false;

// Свидетельство может содержать контакты и пароли. Его нельзя журналировать или
// передавать в сеть; JavaScript не гарантирует стирания строки из памяти.
function importStateWitness() {
  const { ui: _ui, ...persisted } = state;
  const result = JSON.stringify(persisted);
  if (typeof result !== 'string') throw new Error('Нет снимка состояния');
  return result;
}

function reportChangedImport() {
  toast('Данные изменились во время импорта. Закройте окно и откройте файл заново.', 'warning', 60000);
}

function reportPartialImport() {
  haltAfterPartialStateChange();
  toast(
    'Импорт мог выполниться частично. Сохранение и восстановление остановлены; проверьте данные и резервные копии перед перезапуском.',
    'error',
    60000
  );
}

/** Старый «гибкий экспорт» клал email/password прямо в персонажа — переносим в contacts. */
export function liftLegacyContacts(raw) {
  if (!raw || !Array.isArray(raw.characters)) return raw;
  return {
    ...raw,
    characters: raw.characters.map(c => {
      if (!c || typeof c !== 'object' || CONTACT_KEYS.every(k => !(k in c))) return c;
      const contacts = { ...(c.contacts || {}) };
      CONTACT_KEYS.forEach(k => {
        if (c[k] != null && !contacts[k]) contacts[k] = c[k];
      });
      const { email, password, recoveryEmail, phone, ...rest } = c;
      return { ...rest, contacts };
    })
  };
}

const nickKey = nick =>
  String(nick || '')
    .trim()
    .toLowerCase();

/**
 * Слияние финансов: реестры объединяются по id (при дубле побеждает локальная запись),
 * настройки — из файла с более свежим курсом (goldRateAt). Ничего не удаляет:
 * для merge это единственный безопасный вариант, удаления операций в файле быть не должно.
 */
export function mergeFinance(local, incoming) {
  const union = (a = [], b = []) => {
    const out = new Map(a.map(x => [x.id, x]));
    for (const x of b) if (!out.has(x.id)) out.set(x.id, x);
    return [...out.values()];
  };
  const localRate = String(local?.settings?.goldRateAt || '');
  const incomingRate = String(incoming?.settings?.goldRateAt || '');
  const settings = incomingRate >= localRate ? incoming?.settings : local?.settings;
  const merged = {
    operations: union(local?.operations, incoming?.operations),
    shopItems: union(local?.shopItems, incoming?.shopItems),
    loans: union(local?.loans, incoming?.loans),
    // opening, monthAdjust и monthCarry — часть импортируемых данных, а не рыночный
    // курс: их берём из файла всегда, иначе баланс панели не сойдётся с таблицей.
    settings: {
      ...settings,
      opening: incoming?.settings?.opening ?? settings?.opening,
      monthAdjust: incoming?.settings?.monthAdjust ?? settings?.monthAdjust,
      monthCarry: incoming?.settings?.monthCarry ?? settings?.monthCarry
    }
  };
  return normalizeFinance(merged);
}

/**
 * Сопоставление персонажей файла с текущими. Чистая функция (покрыта тестами).
 * Архивные персонажи — тоже существующие записи: если персонаж из файла уже лежит
 * в архиве, он обновит архивную карточку, а не создаст дубликат в активном списке.
 * @param {any[]} localChars
 * @param {any[]} incomingChars
 * @param {(c: any) => any} [presentFor]
 * @param {any[]} [archivedChars]
 */
export function planImport(localChars, incomingChars, presentFor = () => null, archivedChars = []) {
  const byId = new Map(localChars.map(c => [c.id, c]));
  const byNick = new Map(localChars.map(c => [nickKey(c.nick), c]));
  const archivedById = new Map(archivedChars.map(c => [c.id, c]));
  const archivedByNick = new Map(archivedChars.map(c => [nickKey(c.nick), c]));
  const plan = { added: [], conflicts: [], identical: [] };
  const usedLocal = new Set();
  incomingChars.forEach(inc => {
    // Сначала активные, затем архивные: совпадение по id, иначе по нику без учёта регистра.
    let local = byId.get(inc.id);
    let archived = false;
    if (!local || usedLocal.has(local.id)) local = byNick.get(nickKey(inc.nick));
    if (!local || usedLocal.has(local.id)) {
      local = archivedById.get(inc.id);
      archived = true;
    }
    if (!local || usedLocal.has(local.id)) {
      local = archivedByNick.get(nickKey(inc.nick));
      archived = true;
    }
    if (!local || usedLocal.has(local.id)) {
      plan.added.push(inc);
      return;
    }
    usedLocal.add(local.id);
    const present = presentFor(inc);
    const diffs = diffCharacters(local, inc, present);
    if (diffs.length) plan.conflicts.push({ local, incoming: inc, diffs, present, archived });
    else plan.identical.push({ local, incoming: inc, archived });
  });
  return plan;
}

function hasKey(raw, key) {
  return raw && Object.prototype.hasOwnProperty.call(raw, key);
}

const PLANNER_IMPORT_FIELDS = new Set([
  'id',
  'syncId',
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
  'createdAt',
  'updatedAt'
]);

function validPlannerDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Не заменяем календарь, если нормализатор отбросил или изменил поля из файла. */
export function canReplaceImportedPlanner(raw, normalized) {
  if (!Array.isArray(raw) || !Array.isArray(normalized) || raw.length !== normalized.length) return false;
  const ids = new Set();
  const syncIds = new Set();
  try {
    return raw.every((entry, index) => {
      const next = normalized[index];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !next) return false;
      if (typeof entry.id !== 'string' || !entry.id.trim() || entry.id !== entry.id.trim()) return false;
      const id = entry.id.toLowerCase();
      if (ids.has(id)) return false;
      ids.add(id);
      if (hasKey(entry, 'syncId')) {
        if (typeof entry.syncId !== 'string' || !entry.syncId.trim()) return false;
        const syncId = entry.syncId.toLowerCase();
        if (syncIds.has(syncId)) return false;
        syncIds.add(syncId);
      }
      if (!validPlannerDate(entry.date) || !validPlannerDate(next.date)) return false;
      if (next.recurrenceEnd && !validPlannerDate(next.recurrenceEnd)) return false;
      if (
        next.time &&
        (!/^\d{2}:\d{2}$/.test(next.time) || Number(next.time.slice(0, 2)) > 23 || Number(next.time.slice(3)) > 59)
      )
        return false;
      if (!Number.isSafeInteger(next.durationMinutes) || !Number.isSafeInteger(next.reminderMinutes)) return false;
      if (
        [next.createdAt, next.updatedAt].some(value => typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
      )
        return false;
      if (Object.keys(next.statusByDate).some(date => !validPlannerDate(date))) return false;
      for (const key of Object.keys(entry)) {
        // Старый формат использовал done вместо статуса; противоречие не исправляем молча.
        if (key === 'done') {
          if (typeof entry.done !== 'boolean' || entry.done !== (next.status === 'done')) return false;
        } else if (!PLANNER_IMPORT_FIELDS.has(key) || JSON.stringify(entry[key]) !== JSON.stringify(next[key]))
          return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}

/** Точка входа: файл уже прочитан как JSON. */
export function openImportDialog(raw) {
  if (importInProgress) {
    toast('Другой импорт ещё выполняется. Дождитесь его завершения.', 'warning');
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    toast('Импорт остановлен: файл не содержит объект данных.', 'error');
    return;
  }
  if (detectVersion(raw) > SCHEMA_VERSION) {
    toast(
      'Импорт остановлен: файл создан более новой версией приложения. Сначала обновите Твиноферму.',
      'error',
      60000
    );
    return;
  }
  let approvedState;
  try {
    approvedState = importStateWitness();
  } catch {
    toast('Импорт остановлен: не удалось проверить текущее состояние и резервные копии.', 'error');
    return;
  }
  const isUnchanged = () => {
    try {
      return importStateWitness() === approvedState;
    } catch {
      return false;
    }
  };
  let source;
  let incoming;
  try {
    source = liftLegacyContacts(raw);
    incoming = normalizeState(source);
  } catch {
    // Некорректные данные могут содержать личные сведения, не показываем исходную ошибку.
    toast('Импорт остановлен: файл не удалось безопасно прочитать.', 'error', 60000);
    return;
  }
  const hasPlanner = hasKey(source, 'plannerEntries');
  const plannerCanBeReplaced = !hasPlanner || canReplaceImportedPlanner(source.plannerEntries, incoming.plannerEntries);
  // Какие поля реально есть в файле: не попавшее в экспорт (пароли, статы…) не затирает текущие данные
  const rawChars = Array.isArray(source?.characters) ? source.characters : [];

  // Пати из файла сопоставляются с локальными по названию; персонажи для слияния получают локальные id пати
  const partyPlan = planPartyImport(state.parties, incoming.parties);
  const newParties = partyPlan.newParties;
  const mergeChars = remapCharacterParties(incoming.characters, partyPlan.idMap);
  setPartyNameResolver(id => [...state.parties, ...newParties].find(p => p.id === id)?.name || null);

  const presence = new Map(mergeChars.map((c, i) => [c, presentPaths(rawChars[i] || {})]));
  const plan = planImport(state.characters, mergeChars, c => presence.get(c) || null, state.archivedCharacters);

  const localMarathons = new Map(state.marathons.map(m => [m.id, m]));
  const newMarathons = incoming.marathons.filter(m => !localMarathons.has(m.id));
  const newerMarathons = incoming.marathons.filter(
    m => localMarathons.has(m.id) && new Date(m.updatedAt || 0) > new Date(localMarathons.get(m.id).updatedAt || 0)
  );
  const localTpl = new Set((state.marathonTemplates || []).map(t => t.id));
  const newTemplates = (incoming.marathonTemplates || []).filter(t => !localTpl.has(t.id));

  const list = (items, render) => (items.length ? `<div class="imp-list">${items.map(render).join('')}</div>` : '');

  let dialogClosed = false;
  showModal({
    title: 'Импорт данных',
    onClose: () => {
      dialogClosed = true;
    },
    submitText: 'Продолжить',
    cancelText: 'Отменить',
    content: `
      <div class="form-grid">
        <div class="imp-section">
          <label class="field radio-option" style="display:flex; gap:8px; padding:8px; border:1px solid var(--border); border-radius:4px; margin-bottom:8px; cursor:pointer;">
            <input type="radio" name="mode" value="merge" checked />
            <div><strong>Объединить</strong>
              <p class="muted" style="font-size:0.8rem; margin:0;">Новые персонажи добавятся, для совпадающих откроется сравнение карточек — выберите, какие поля сохранить.</p></div>
          </label>
          <label class="field radio-option" style="display:flex; gap:8px; padding:8px; border:1px solid var(--border); border-radius:4px; cursor:pointer;">
            <input type="radio" name="mode" value="replace" />
            <div><strong>Заменить всё</strong>
              <p class="muted" style="font-size:0.8rem; margin:0;">Текущие данные будут заменены содержимым файла.</p></div>
          </label>
          <p class="muted" style="font-size:0.8rem; margin:8px 0 0;">
            ${state.settings?.backups?.createBeforeImport === false ? 'Автоматическая копия перед импортом отключена. Заранее сохраните нужные данные.' : 'Перед импортом приложение создаст копию состояния и остановится, если её не удалось подтвердить.'}
            Копия состояния не содержит отдельные контакты в хранилище ОС, входы GameCenter и сессии браузера.
          </p>
          <p class="muted" style="font-size:0.8rem; margin:8px 0 0;">${hasPlanner ? (plannerCanBeReplaced ? `Задач и событий в файле: ${incoming.plannerEntries.length}. При замене они заменят текущий календарь целиком; объединение календаря пока не поддерживается.` : 'Данные задач и событий неоднозначны или повреждены: замена будет остановлена. Объединение календаря пока не поддерживается.') : 'В файле нет календаря: существующие задачи и события останутся без изменений.'}</p>
        </div>

        <div class="imp-section">
          <h4 style="margin:0 0 6px;">👤 Новые персонажи: ${plan.added.length}</h4>
          ${list(plan.added, c => `<label><input type="checkbox" name="add" value="${escapeHtml(c.id)}" checked /> ${escapeHtml(c.nick)} <small class="muted">${escapeHtml(c.class || '')} · ${escapeHtml(partyNamesOf(c, [...state.parties, ...newParties]).join(', ') || 'без пати')}</small></label>`)}
        </div>
        <div class="imp-section">
          <h4 style="margin:0 0 6px;">⚖️ Совпадают, но отличаются: ${plan.conflicts.length}</h4>
          ${list(
            plan.conflicts,
            x =>
              `<label><input type="checkbox" name="cmp" value="${escapeHtml(x.local.id)}" checked /> ${escapeHtml(x.local.nick)}${x.archived ? ' <small class="muted">· в архиве</small>' : ''} <small class="muted">— отличий: ${x.diffs.length} (${escapeHtml(
                x.diffs
                  .slice(0, 4)
                  .map(f => f.label)
                  .join(', ')
              )}${x.diffs.length > 4 ? '…' : ''})</small></label>`
          )}
          ${plan.conflicts.length ? '<p class="muted" style="font-size:0.8rem; margin:4px 0 0;">Снимите галочку, чтобы оставить текущую карточку без сравнения.</p>' : ''}
        </div>
        ${plan.identical.length ? `<p class="muted">✔ Полностью совпадают (пропускаются): ${plan.identical.length}${plan.identical.some(x => x.archived) ? ` (в архиве: ${plan.identical.filter(x => x.archived).length})` : ''}</p>` : ''}
        <div class="imp-section">
          <h4 style="margin:0 0 6px;">Прочее</h4>
          <p class="muted" style="margin:0;">Пати: новых ${newParties.length} · Марафоны: новых ${newMarathons.length}, обновлённых ${newerMarathons.length} · Шаблоны марафонов: новых ${newTemplates.length}${hasKey(source, 'finance') ? ` · Финансовых записей в файле: ${incoming.finance.operations.length}` : ''}</p>
        </div>
      </div>`,
    async onSubmit(formData) {
      if (dialogClosed) return false;
      if (importInProgress) {
        toast('Другой импорт ещё выполняется. Дождитесь его завершения.', 'warning');
        return false;
      }
      if (!isUnchanged()) {
        reportChangedImport();
        return false;
      }
      const mode = String(formData.get('mode'));
      if (mode === 'replace' && !plannerCanBeReplaced) {
        toast(
          'Импорт остановлен: данные задач и событий в файле требуют проверки. Текущий календарь не изменён.',
          'error',
          60000
        );
        return false;
      }
      importInProgress = true;
      if (mode === 'replace') {
        let mutationStarted = false;
        try {
          if (!(await backupBeforeImport(isUnchanged, () => dialogClosed))) return false;
          assertStateWriteAvailable();
          mutationStarted = true;
          state.characters = incoming.characters;
          state.archivedCharacters = incoming.archivedCharacters;
          state.archivedParties = incoming.archivedParties;
          // Пати берём из файла всегда, когда они есть: на них ссылаются partyIds персонажей
          if (hasKey(source, 'parties') || incoming.parties.length) state.parties = incoming.parties;
          if (hasKey(source, 'marathons')) state.marathons = incoming.marathons;
          if (hasKey(source, 'marathonTemplates')) state.marathonTemplates = incoming.marathonTemplates;
          if (hasPlanner) state.plannerEntries = incoming.plannerEntries;
          if (hasKey(source, 'settings')) state.settings = incoming.settings;
          if (hasKey(source, 'finance')) state.finance = incoming.finance;
          await forceRenderAndPersist();
          toast('Импорт завершён: данные заменены', 'success');
          return true;
        } catch {
          if (mutationStarted) reportPartialImport();
          else toast('Импорт остановлен: сохранение недоступно. Проверьте данные и резервные копии.', 'error');
          return false;
        } finally {
          importInProgress = false;
        }
      }
      const addIds = new Set(formData.getAll('add'));
      const cmpIds = new Set(formData.getAll('cmp'));
      // Закрываем сводку и идём по сравнениям (они открываются в том же modal-root).
      setTimeout(async () => {
        try {
          await runMerge({
            added: plan.added.filter(c => addIds.has(c.id)),
            conflicts: plan.conflicts.filter(x => cmpIds.has(x.local.id)),
            newParties,
            newMarathons,
            newerMarathons,
            newTemplates,
            finance: hasKey(source, 'finance') ? incoming.finance : null,
            isUnchanged
          });
        } catch {
          // Не раскрываем исходную ошибку: она может содержать данные файла.
          toast('Импорт не завершён. Проверьте данные и резервные копии.', 'error');
        } finally {
          importInProgress = false;
        }
      }, 0);
      return true;
    }
  });
}

async function backupBeforeImport(isUnchanged, isCancelled = () => false) {
  const mayContinue = () => {
    if (isCancelled()) return false;
    if (!isUnchanged()) {
      reportChangedImport();
      return false;
    }
    return true;
  };
  if (!mayContinue()) return false;
  try {
    // Даже когда пользователь отключил автоматическую копию, проверяем, что
    // текущие данные можно сохранить до изменения памяти.
    await saveNow();
    if (!mayContinue()) return false;
    if (state.settings?.backups?.createBeforeImport !== false) {
      const name = await createBackup('pre-import');
      if (!mayContinue()) return false;
      if (typeof name !== 'string' || !name.trim()) throw new Error('Копия не подтверждена');
    }
  } catch {
    if (isCancelled()) return false;
    // Детали ошибки могут содержать путь или сведения из импортируемого файла.
    console.warn('[IMPORT] Не удалось подтвердить сохранение или резервную копию; импорт остановлен.');
    toast(
      'Импорт остановлен: не удалось подтвердить сохранение или резервную копию. Проверьте данные и список копий.',
      'error',
      60000
    );
    return false;
  }
  return mayContinue();
}

/**
 * Обычный импорт может обновить марафон из старого файла без sync-ID. Совпадающие
 * локальные записи остаются теми же сущностями; несовпадающие назначенные sync-ID
 * нельзя заменять без отдельного разрешения конфликта. Новые задания остаются новыми.
 */
export function preserveImportedMarathonIdentity(local, incoming) {
  const keep = (old, next) => {
    const hasOld = Object.hasOwn(old, 'syncId');
    const hasNext = Object.hasOwn(next, 'syncId');
    if (hasOld && hasNext && old.syncId !== next.syncId) throw new Error('Несовпадение идентификаторов марафона');
    return hasOld ? { ...next, syncId: old.syncId } : { ...next };
  };
  const match = (oldRows, nextRows, copy) => {
    const oldMap = new Map();
    for (const row of oldRows) {
      if (!row?.id || oldMap.has(row.id)) throw new Error('Неоднозначные идентификаторы марафона');
      oldMap.set(row.id, row);
    }
    const seen = new Set();
    return nextRows.map(row => {
      if (!row?.id || seen.has(row.id)) throw new Error('Неоднозначные идентификаторы марафона');
      seen.add(row.id);
      const previous = oldMap.get(row.id);
      return previous ? copy(previous, row) : { ...row };
    });
  };
  const result = keep(local, incoming);
  if (local.kind !== incoming.kind) {
    if (Object.hasOwn(local, 'syncId') || Object.hasOwn(incoming, 'syncId'))
      throw new Error('Несовпадение типа марафона');
    return result;
  }
  if (incoming.kind === 'series') return result;
  result.tasks = match(local.tasks, incoming.tasks, (oldTask, nextTask) => ({
    ...keep(oldTask, nextTask),
    rewards: match(oldTask.rewards, nextTask.rewards, keep)
  }));
  result.bonuses = match(local.bonuses, incoming.bonuses, keep);
  return result;
}

async function runMerge({
  added,
  conflicts,
  newParties,
  newMarathons,
  newerMarathons,
  newTemplates,
  finance,
  isUnchanged
}) {
  // 1. Решения по совпадениям (до изменения данных — «Отменить импорт» ничего не трогает)
  const decisions = [];
  let bulk = null;
  for (let i = 0; i < conflicts.length; i++) {
    const { local, incoming, present, archived } = conflicts[i];
    let res = bulk
      ? { action: bulk }
      : await openCompareDialog(local, incoming, { index: i + 1, total: conflicts.length, present, archived });
    if (res.action === 'cancel') {
      toast('Импорт отменён', 'info');
      return;
    }
    if (res.action === 'all-local' || res.action === 'all-incoming') {
      bulk = res.action === 'all-local' ? 'keep' : 'take';
      res = { action: bulk };
    }
    decisions.push({ local, incoming, diffs: conflicts[i].diffs, archived, ...res });
  }

  if (!isUnchanged()) {
    reportChangedImport();
    return;
  }
  // Проверяем совпадение идентичности до изменений и до добавления любых записей.
  // Подмена sync-ID даже у одного вложенного задания отменяет весь импорт.
  let updatedMarathons;
  try {
    updatedMarathons = newerMarathons.map(incoming => {
      const local = state.marathons.find(row => row.id === incoming.id);
      if (!local) throw new Error('Марафон больше не найден');
      return preserveImportedMarathonIdentity(local, incoming);
    });
  } catch {
    toast('Импорт отменён: идентификаторы марафонов не совпадают. Сначала проверьте файл.', 'error');
    return;
  }

  if (!(await backupBeforeImport(isUnchanged))) return;
  try {
    assertStateWriteAvailable();
  } catch {
    toast('Импорт остановлен: сохранение недоступно. Проверьте данные и резервные копии.', 'error');
    return;
  }

  // 2. Сначала синхронно применяем решение и ставим сохранение в очередь. Вызовы
  // переименования профиля выполняются лишь после этой записи, не между изменениями.
  let changed = 0,
    addedCount = 0;
  let mutationStarted = false;
  let renameWarning = false;
  const toRename = [];
  try {
    mutationStarted = true;
    const taken = () => [...state.characters, ...state.archivedCharacters].map(c => c.id);
    const addAsNew = c => {
      const copy = normalizeCharacter({ ...c, id: characterIdFor(c.nick, taken()) });
      state.characters.push(copy);
      addedCount++;
    };
    added.forEach(addAsNew);

    for (const d of decisions) {
      const activeIdx = state.characters.findIndex(c => c.id === d.local.id);
      const archivedIdx = activeIdx === -1 ? state.archivedCharacters.findIndex(c => c.id === d.local.id) : -1;
      if (activeIdx === -1 && archivedIdx === -1) continue;
      if (d.action === 'merge' || d.action === 'take') {
        // «Взять из файла» = все отличающиеся поля, которые есть в файле, берутся из него
        const merged =
          d.action === 'take'
            ? buildMerged(d.local, d.incoming, Object.fromEntries(d.diffs.map(f => [f.path, 'incoming'])))
            : d.character;
        const next = normalizeCharacter(merged);
        // Архивная карточка обновляется на месте: активный список не пополняется дубликатом.
        if (activeIdx !== -1) state.characters[activeIdx] = next;
        else state.archivedCharacters[archivedIdx] = next;
        if (next.nick !== d.local.nick) toRename.push(next);
        changed++;
      } else if (d.action === 'both' && activeIdx !== -1) {
        // «Оставить обе» создаёт новую сущность, а не вторую копию того же sync-ID.
        const copy = { ...d.incoming };
        delete copy.syncId;
        addAsNew(copy);
      }
    }

    newParties.forEach(p => state.parties.push({ ...p, order: state.parties.length + 1 }));
    newMarathons.forEach(m => state.marathons.push(m));
    updatedMarathons.forEach(m => {
      const i = state.marathons.findIndex(x => x.id === m.id);
      if (i !== -1) state.marathons[i] = m;
    });
    newTemplates.forEach(t => state.marathonTemplates.push(t));
    if (finance) state.finance = mergeFinance(state.finance, finance);
    await forceRenderAndPersist();

    let renamed = false;
    for (const character of toRename) {
      assertStateWriteAvailable();
      const result = await syncIdWithNick(character);
      // Даже ответ «профиль занят» не подтверждает неизменность банка cookie:
      // native-команда могла затронуть его до проверки профиля или потерять ответ.
      if (result.error && result.error !== 'references_conflict') {
        reportPartialImport();
        return;
      }
      if (result.error) renameWarning = true;
      if (result.changed) renamed = true;
    }
    if (renamed) await forceRenderAndPersist();
  } catch {
    if (mutationStarted) reportPartialImport();
    return;
  }
  if (renameWarning)
    toast(
      'Импорт сохранён, но перенос некоторых профилей или идентификаторов не подтверждён. Проверьте персонажей.',
      'warning',
      60000
    );
  else toast(`Импорт завершён: добавлено ${addedCount}, обновлено ${changed}`, 'success');
}

// @ts-check
// js/data/import.js
// Импорт JSON: разбор файла → сводка (новые / совпадающие / одинаковые) →
// сравнение каждой совпавшей пары (data/compare.js) → применение.
// Совпадение персонажей — по id (id = ник, см. core/ids.js) или по нику без учёта регистра.

import { state, normalizeState, normalizeCharacter } from '../core/state.js';
import { saveNow, createBackup, forceRenderAndPersist } from '../core/storage.js';
import { characterIdFor } from '../core/ids.js';
import { showModal, toast } from '../core/ui.js';
import { escapeHtml } from '../core/utils.js';
import { diffCharacters, presentPaths, buildMerged, setPartyNameResolver } from './characterFields.js';
import { planPartyImport, remapCharacterParties, partyNamesOf } from '../modules/parties/membership.js';
import { openCompareDialog } from './compare.js';
import { syncIdWithNick } from '../modules/characters/identity.js';
import { normalizeFinance } from '../modules/finance/model.js';

const CONTACT_KEYS = ['email', 'password', 'recoveryEmail', 'phone'];

/** Старый «гибкий экспорт» клал email/password прямо в персонажа — переносим в contacts. */
export function liftLegacyContacts(raw) {
  if (!raw || !Array.isArray(raw.characters)) return raw;
  return {
    ...raw,
    characters: raw.characters.map(c => {
      if (!c || typeof c !== 'object' || CONTACT_KEYS.every(k => !(k in c))) return c;
      const contacts = { ...(c.contacts || {}) };
      CONTACT_KEYS.forEach(k => { if (c[k] != null && !contacts[k]) contacts[k] = c[k]; });
      const { email, password, recoveryEmail, phone, ...rest } = c;
      return { ...rest, contacts };
    })
  };
}

const nickKey = nick => String(nick || '').trim().toLowerCase();

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
    if (!local || usedLocal.has(local.id)) { local = archivedById.get(inc.id); archived = true; }
    if (!local || usedLocal.has(local.id)) { local = archivedByNick.get(nickKey(inc.nick)); archived = true; }
    if (!local || usedLocal.has(local.id)) { plan.added.push(inc); return; }
    usedLocal.add(local.id);
    const present = presentFor(inc);
    const diffs = diffCharacters(local, inc, present);
    if (diffs.length) plan.conflicts.push({ local, incoming: inc, diffs, present, archived });
    else plan.identical.push({ local, incoming: inc, archived });
  });
  return plan;
}

function hasKey(raw, key) { return raw && Object.prototype.hasOwnProperty.call(raw, key); }

/** Точка входа: файл уже прочитан как JSON. */
export function openImportDialog(raw) {
  const source = liftLegacyContacts(raw);
  const incoming = normalizeState(source);
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
  const newerMarathons = incoming.marathons.filter(m => localMarathons.has(m.id) &&
    new Date(m.updatedAt || 0) > new Date(localMarathons.get(m.id).updatedAt || 0));
  const localTpl = new Set((state.marathonTemplates || []).map(t => t.id));
  const newTemplates = (incoming.marathonTemplates || []).filter(t => !localTpl.has(t.id));

  const list = (items, render) => items.length ? `<div class="imp-list">${items.map(render).join('')}</div>` : '';

  showModal({
    title: 'Импорт данных',
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
              <p class="muted" style="font-size:0.8rem; margin:0;">Текущие данные будут заменены содержимым файла (перед этим создаётся бэкап).</p></div>
          </label>
        </div>

        <div class="imp-section">
          <h4 style="margin:0 0 6px;">👤 Новые персонажи: ${plan.added.length}</h4>
          ${list(plan.added, c => `<label><input type="checkbox" name="add" value="${escapeHtml(c.id)}" checked /> ${escapeHtml(c.nick)} <small class="muted">${escapeHtml(c.class || '')} · ${escapeHtml(partyNamesOf(c, [...state.parties, ...newParties]).join(', ') || 'без пати')}</small></label>`)}
        </div>
        <div class="imp-section">
          <h4 style="margin:0 0 6px;">⚖️ Совпадают, но отличаются: ${plan.conflicts.length}</h4>
          ${list(plan.conflicts, x => `<label><input type="checkbox" name="cmp" value="${escapeHtml(x.local.id)}" checked /> ${escapeHtml(x.local.nick)}${x.archived ? ' <small class="muted">· в архиве</small>' : ''} <small class="muted">— отличий: ${x.diffs.length} (${escapeHtml(x.diffs.slice(0, 4).map(f => f.label).join(', '))}${x.diffs.length > 4 ? '…' : ''})</small></label>`)}
          ${plan.conflicts.length ? '<p class="muted" style="font-size:0.8rem; margin:4px 0 0;">Снимите галочку, чтобы оставить текущую карточку без сравнения.</p>' : ''}
        </div>
        ${plan.identical.length ? `<p class="muted">✔ Полностью совпадают (пропускаются): ${plan.identical.length}${plan.identical.some(x => x.archived) ? ` (в архиве: ${plan.identical.filter(x => x.archived).length})` : ''}</p>` : ''}
        <div class="imp-section">
          <h4 style="margin:0 0 6px;">Прочее</h4>
          <p class="muted" style="margin:0;">Пати: новых ${newParties.length} · Марафоны: новых ${newMarathons.length}, обновлённых ${newerMarathons.length} · Шаблоны марафонов: новых ${newTemplates.length}${hasKey(source, 'finance') ? ` · Финансовых записей в файле: ${incoming.finance.operations.length}` : ''}</p>
        </div>
      </div>`,
    async onSubmit(formData) {
      const mode = String(formData.get('mode'));
      if (mode === 'replace') {
        await backupBeforeImport();
        state.characters = incoming.characters;
        state.archivedCharacters = incoming.archivedCharacters;
        state.archivedParties = incoming.archivedParties;
        // Пати берём из файла всегда, когда они есть: на них ссылаются partyIds персонажей
        if (hasKey(source, 'parties') || incoming.parties.length) state.parties = incoming.parties;
        if (hasKey(source, 'marathons')) state.marathons = incoming.marathons;
        if (hasKey(source, 'marathonTemplates')) state.marathonTemplates = incoming.marathonTemplates;
        if (hasKey(source, 'settings')) state.settings = incoming.settings;
        if (hasKey(source, 'finance')) state.finance = incoming.finance;
        await forceRenderAndPersist();
        toast('Импорт завершён: данные заменены', 'success');
        return true;
      }
      const addIds = new Set(formData.getAll('add'));
      const cmpIds = new Set(formData.getAll('cmp'));
      // Закрываем сводку и идём по сравнениям (они открываются в том же modal-root)
      setTimeout(() => runMerge({
        added: plan.added.filter(c => addIds.has(c.id)),
        conflicts: plan.conflicts.filter(x => cmpIds.has(x.local.id)),
        newParties, newMarathons, newerMarathons, newTemplates,
        finance: hasKey(source, 'finance') ? incoming.finance : null
      }), 0);
      return true;
    }
  });
}

async function backupBeforeImport() {
  if (state.settings?.backups?.createBeforeImport === false) return;
  try { await saveNow(); await createBackup('pre-import'); } catch (e) { console.warn('[IMPORT] backup failed', e); }
}

async function runMerge({ added, conflicts, newParties, newMarathons, newerMarathons, newTemplates, finance }) {
  // 1. Решения по совпадениям (до изменения данных — «Отменить импорт» ничего не трогает)
  const decisions = [];
  let bulk = null;
  for (let i = 0; i < conflicts.length; i++) {
    const { local, incoming, present, archived } = conflicts[i];
    let res = bulk ? { action: bulk } : await openCompareDialog(local, incoming, { index: i + 1, total: conflicts.length, present, archived });
    if (res.action === 'cancel') { toast('Импорт отменён', 'info'); return; }
    if (res.action === 'all-local' || res.action === 'all-incoming') {
      bulk = res.action === 'all-local' ? 'keep' : 'take';
      res = { action: bulk };
    }
    decisions.push({ local, incoming, diffs: conflicts[i].diffs, archived, ...res });
  }

  await backupBeforeImport();

  // 2. Применение
  let changed = 0, addedCount = 0;
  const taken = () => [...state.characters, ...state.archivedCharacters].map(c => c.id);
  const addAsNew = (c) => {
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
      const merged = d.action === 'take'
        ? buildMerged(d.local, d.incoming, Object.fromEntries(d.diffs.map(f => [f.path, 'incoming'])))
        : d.character;
      const next = normalizeCharacter(merged);
      // Архивная карточка обновляется на месте: активный список не пополняется дубликатом.
      if (activeIdx !== -1) state.characters[activeIdx] = next;
      else state.archivedCharacters[archivedIdx] = next;
      if (next.nick !== d.local.nick) await syncIdWithNick(next);
      changed++;
    } else if (d.action === 'both' && activeIdx !== -1) {
      // «Оставить обе» для архивного совпадения не имеет смысла: архивная запись уже
      // сохранена, а добавление активной копии создало бы дубликат.
      addAsNew(d.incoming);
    }
  }

  newParties.forEach(p => state.parties.push({ ...p, order: state.parties.length + 1 }));
  newMarathons.forEach(m => state.marathons.push(m));
  newerMarathons.forEach(m => { const i = state.marathons.findIndex(x => x.id === m.id); if (i !== -1) state.marathons[i] = m; });
  newTemplates.forEach(t => state.marathonTemplates.push(t));
  if (finance) state.finance = mergeFinance(state.finance, finance);

  await forceRenderAndPersist();
  toast(`Импорт завершён: добавлено ${addedCount}, обновлено ${changed}`, 'success');
}

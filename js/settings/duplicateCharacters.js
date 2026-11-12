import { vaultStatus } from '../core/secrets.js';
import { state } from '../core/state.js';
import { escapeHtml } from '../core/utils.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import { confirmModal, toast } from '../core/ui.js';
import {
  saveNow,
  createBackup,
  assertStateWriteAvailable,
  forceRenderAndPersist,
  haltAfterPartialStateChange
} from '../core/storage.js';
import { renameCharacterReferences } from '../modules/characters/identity.js';

// Only reasons and IDs leave the comparison; never expose values/password hashes.
export function duplicateReasons(a, b) {
  const reasons = [];
  for (const [key, label] of [
    ['email', 'почта / логин'],
    ['recoveryEmail', 'резервная почта'],
    ['phone', 'телефон']
  ]) {
    const normalize = value =>
      String(value || '')
        .trim()
        .toLowerCase();
    const value = normalize(a.contacts?.[key]);
    if (value && value === normalize(b.contacts?.[key])) reasons.push(label);
  }
  if (a.nick?.trim().toLowerCase() === b.nick?.trim().toLowerCase() && a.nick?.trim()) reasons.push('ник');
  return reasons;
}

// Fill missing data only. Different populated values require manual editing first.
export function mergeDuplicateData(primary, duplicate) {
  const ignored = new Set([
    'id',
    'nick',
    'createdAt',
    'updatedAt',
    'syncId',
    'tags',
    'partyIds',
    'mainPartyId',
    'contacts',
    'secretsRef',
    'launch'
  ]);
  const empty = value =>
    value == null ||
    value === '' ||
    (Array.isArray(value) && !value.length) ||
    (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
  const merged = structuredClone(primary);
  for (const [key, value] of Object.entries(duplicate)) {
    if (ignored.has(key) || empty(value)) continue;
    if (empty(merged[key])) merged[key] = structuredClone(value);
    else if (JSON.stringify(merged[key]) !== JSON.stringify(value)) throw new Error('conflict');
  }
  merged.contacts = { ...primary.contacts };
  for (const [key, value] of Object.entries(duplicate.contacts || {})) {
    if (!value) continue;
    if (merged.contacts[key] && merged.contacts[key] !== value) throw new Error('contacts');
    merged.contacts[key] = value;
  }
  // Credentials/profile stores cannot be merged transactionally. Never drop those bindings.
  if (duplicate.secretsRef || Object.values(duplicate.launch || {}).some(v => !empty(v) && v !== false))
    throw new Error('binding');
  merged.tags = [...new Set([...(primary.tags || []), ...(duplicate.tags || [])])];
  merged.partyIds = [...new Set([...(primary.partyIds || []), ...(duplicate.partyIds || [])])];
  if (primary.mainPartyId && duplicate.mainPartyId && primary.mainPartyId !== duplicate.mainPartyId)
    throw new Error('party');
  merged.mainPartyId ||= duplicate.mainPartyId;
  merged.updatedAt = new Date().toISOString();
  return merged;
}

export function openDuplicateCharacters() {
  const ov = openOverlay({ title: 'Проверить дубли персонажей' });
  let working = false;
  const render = () => {
    const chars = [...state.characters, ...state.archivedCharacters];
    const pairs = [];
    for (let i = 0; i < chars.length; i++)
      for (let j = i + 1; j < chars.length; j++) {
        const reasons = duplicateReasons(chars[i], chars[j]);
        if (reasons.length) pairs.push({ a: chars[i], b: chars[j], reasons });
      }
    ov.body.innerHTML =
      '<p>Совпадения — только кандидаты: один аккаунт может иметь разных персонажей. Значения контактов не показываются. Пароль не используется для поиска совпадений. Можно оставить пару, открыть профиль для удаления или выбрать основную карточку. Слияние переносит только совместимые данные и известные ссылки; конфликтующие значения и сохранённые входы не затираются. При активных записях контактов ОС слияние заблокировано: их безопасная миграция требует отдельной процедуры. Профили браузера и записи ОС не объединяются и не удаляются. Перед слиянием создаётся копия состояния (без отдельного хранилища ОС).</p>' +
      (pairs.length ? '' : '<p>Совпадений не найдено. Недоступные контакты ОС не сравниваются.</p>');
    for (const { a, b, reasons } of pairs) {
      const row = document.createElement('section');
      row.className = 'panel';
      row.innerHTML = `<h3>${escapeHtml(a.nick)} ↔ ${escapeHtml(b.nick)}</h3><p>Совпадает: ${escapeHtml(reasons.join(', '))}</p><select aria-label="Основной персонаж"><option value="a">Основной: ${escapeHtml(a.nick)} (${escapeHtml(a.id)})</option><option value="b">Основной: ${escapeHtml(b.nick)} (${escapeHtml(b.id)})</option></select><div class="row gap"><button class="btn" data-merge>Слить совместимые данные</button><button class="btn" data-profile>Профиль выбранного / удалить…</button><button class="btn ghost" data-keep>Оставить как есть</button></div>`;
      const selected = () => (row.querySelector('select').value === 'a' ? [a, b] : [b, a]);
      row.querySelector('[data-keep]').onclick = () => row.remove();
      row.querySelector('[data-profile]').onclick = async () => {
        if (working) return;
        const [char] = selected();
        const { openCharacterProfile } = await import('../modules/characters/profileView.js');
        ov.close();
        openCharacterProfile(char);
      };
      row.querySelector('[data-merge]').onclick = async () => {
        if (working) return;
        working = true;
        let mutated = false;
        try {
          const [primary, duplicate] = selected();
          if (vaultStatus().count || vaultStatus().blocked || state.secretsInVault) throw new Error('vault');
          mergeDuplicateData(primary, duplicate);
          const witness = JSON.stringify(state);
          if (
            !(await confirmModal({
              title: 'Слить карточки?',
              text: `Оставить «${primary.nick}», убрать «${duplicate.nick}». Конфликты остановят слияние. Копия не содержит отдельных записей ОС; браузерные профили не объединяются.`,
              okText: 'Создать копию и слить',
              danger: true
            }))
          )
            return;
          await saveNow();
          const backup = await createBackup('before-merge-duplicates');
          if (!backup || JSON.stringify(state) !== witness) throw new Error('changed');
          const merged = mergeDuplicateData(primary, duplicate);
          assertStateWriteAvailable();
          // Reference helper prepares everything first, rejects collisions without mutation.
          renameCharacterReferences(duplicate.id, primary.id);
          mutated = true;
          Object.assign(primary, merged);
          state.characters = state.characters.filter(c => c.id !== duplicate.id);
          state.archivedCharacters = state.archivedCharacters.filter(c => c.id !== duplicate.id);
          await forceRenderAndPersist();
          toast('Совместимые данные объединены. Профили браузера и хранилище ОС не менялись.', 'success');
          render();
        } catch {
          if (mutated) haltAfterPartialStateChange();
          toast(
            mutated
              ? 'Сохранение слияния не подтверждено. Не продолжайте изменения; проверьте резервную копию.'
              : 'Слияние остановлено: конфликт данных/ссылок, активное хранилище контактов ОС, сохранённая привязка у удаляемого дубля, изменение состояния или недоступная копия. Отредактируйте карточки вручную; данные не затираются.',
            'warning',
            60000
          );
        } finally {
          working = false;
        }
      };
      ov.body.append(row);
    }
  };
  render();
  ov.foot.innerHTML = '<button class="btn">Закрыть</button>';
  ov.foot.querySelector('button').onclick = () => {
    if (!working) ov.close();
  };
  return ov;
}

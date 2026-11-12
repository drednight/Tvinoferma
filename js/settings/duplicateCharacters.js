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
import { mergeCharacterReferences } from '../modules/characters/identity.js';

// Only reasons and IDs leave the comparison; never expose values/password hashes.
export function duplicateReasons(a, b) {
  const reasons = [];
  for (const [key, label] of [['email', 'почта / логин']]) {
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
export function mergeDuplicateData(primary, duplicate, choices = {}) {
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
    'launch',
    'lastLoginCheck',
    'isLoggedIn'
  ]);
  const empty = value =>
    value == null ||
    value === '' ||
    (Array.isArray(value) && !value.length) ||
    (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
  const merged = structuredClone(primary);
  const combine = (left, right, path) => {
    if (empty(right)) return structuredClone(left);
    if (empty(left)) return structuredClone(right);
    if (JSON.stringify(left) === JSON.stringify(right)) return structuredClone(left);
    if (Array.isArray(left) && Array.isArray(right))
      return [...new Map([...left, ...right].map(v => [JSON.stringify(v), structuredClone(v)])).values()];
    if (typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      const out = structuredClone(left);
      for (const [key, value] of Object.entries(right)) out[key] = combine(out[key], value, `${path}.${key}`);
      return out;
    }
    if (choices[path] === 'primary') return structuredClone(left);
    if (choices[path] === 'duplicate') return structuredClone(right);
    const error = new Error(`Конфликт поля: ${path}`);
    error.field = path;
    throw error;
  };
  for (const [key, value] of Object.entries(duplicate)) {
    if (ignored.has(key) || empty(value)) continue;
    merged[key] = combine(merged[key], value, key);
  }
  merged.contacts = combine(primary.contacts || {}, duplicate.contacts || {}, 'contacts');
  // Credentials/profile stores cannot be merged transactionally. Never drop those bindings.
  if (duplicate.secretsRef || Object.values(duplicate.launch || {}).some(v => !empty(v) && v !== false))
    throw new Error(
      'У удаляемой карточки есть сохранённый вход или привязка запуска. Сохраните эту карточку основной либо перенесите привязку вручную'
    );
  merged.tags = [...new Set([...(primary.tags || []), ...(duplicate.tags || [])])];
  merged.partyIds = [...new Set([...(primary.partyIds || []), ...(duplicate.partyIds || [])])];
  merged.mainPartyId = combine(primary.mainPartyId, duplicate.mainPartyId, 'mainPartyId');
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
      '<p>Совпадения — только кандидаты: один аккаунт может иметь разных персонажей. Значения контактов не показываются. Пароль, резервная почта и телефон не используются для поиска совпадений. Можно оставить пару, открыть профиль для удаления или выбрать основную карточку. Слияние переносит только совместимые данные и известные ссылки; конфликтующие значения и сохранённые входы не затираются. При активных записях контактов ОС слияние заблокировано: их безопасная миграция требует отдельной процедуры. Профили браузера и записи ОС не объединяются и не удаляются. Перед слиянием создаётся копия состояния (без отдельного хранилища ОС).</p>' +
      `<p data-duplicate-count>Найдено пар-кандидатов: <strong>${pairs.length}</strong>. Персонажей в них: <strong>${new Set(pairs.flatMap(({ a, b }) => [a.id, b.id])).size}</strong>.</p>` +
      (pairs.length ? '' : '<p>Совпадений не найдено. Недоступные контакты ОС не сравниваются.</p>');
    for (const { a, b, reasons } of pairs) {
      const row = document.createElement('section');
      row.className = 'panel';
      row.innerHTML = `<h3>${escapeHtml(a.nick)} ↔ ${escapeHtml(b.nick)}</h3><p data-classes>${escapeHtml(a.nick)}: ${escapeHtml(a.class || 'Класс не выбран')} ↔ ${escapeHtml(b.nick)}: ${escapeHtml(b.class || 'Класс не выбран')}</p><p>Совпадает: ${escapeHtml(reasons.join(', '))}</p><select aria-label="Основной персонаж"><option value="a">Основной: ${escapeHtml(a.nick)} (${escapeHtml(a.id)})</option><option value="b">Основной: ${escapeHtml(b.nick)} (${escapeHtml(b.id)})</option></select><div class="row gap"><button class="btn" data-merge>Слить совместимые данные</button><button type="button" class="btn" data-profile="a">Открыть карточку: ${escapeHtml(a.nick)} (${escapeHtml(a.id)})</button><button type="button" class="btn" data-profile="b">Открыть карточку: ${escapeHtml(b.nick)} (${escapeHtml(b.id)})</button><button class="btn ghost" data-keep>Оставить как есть</button></div>`;
      const selected = () => (row.querySelector('select').value === 'a' ? [a, b] : [b, a]);
      row.querySelector('[data-keep]').onclick = () => row.remove();
      for (const button of row.querySelectorAll('[data-profile]')) {
        button.onclick = async () => {
          if (working) return;
          const char = button.dataset.profile === 'a' ? a : b;
          const { openCharacterProfile } = await import('../modules/characters/profileView.js');
          if (working) return;
          // Suspend rather than destroy the candidate list while the profile owns modal-root.
          const root = ov.el.parentElement;
          ov.el.remove();
          openCharacterProfile(char, { onClose: () => root?.append(ov.el) });
        };
      }
      row.querySelector('[data-merge]').onclick = async () => {
        if (working) return;
        working = true;
        let mutated = false;
        try {
          const [primary, duplicate] = selected();
          if (vaultStatus().count || vaultStatus().blocked || state.secretsInVault)
            throw new Error(
              'Слияние контактов из хранилища ОС пока не поддерживается. Нужна отдельная миграция контактов; отключение защиты само по себе не переносит записи.'
            );
          const witness = JSON.stringify(state);
          const choices = {};
          while (true) {
            try {
              mergeDuplicateData(primary, duplicate, choices);
              break;
            } catch (error) {
              if (!error.field) throw error;
              const choice = await chooseMergeConflict(error.field, primary, duplicate);
              if (!choice) return;
              choices[error.field] = choice;
              if (JSON.stringify(state) !== witness) throw new Error('changed', { cause: error });
            }
          }
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
          const merged = mergeDuplicateData(primary, duplicate, choices);
          assertStateWriteAvailable();
          // Reference helper prepares everything first, rejects collisions without mutation.
          mergeCharacterReferences(duplicate.id, primary.id);
          mutated = true;
          Object.assign(primary, merged);
          state.characters = state.characters.filter(c => c.id !== duplicate.id);
          state.archivedCharacters = state.archivedCharacters.filter(c => c.id !== duplicate.id);
          await forceRenderAndPersist();
          toast('Совместимые данные объединены. Профили браузера и хранилище ОС не менялись.', 'success');
          render();
        } catch (error) {
          if (mutated) haltAfterPartialStateChange();
          toast(
            mutated
              ? 'Сохранение слияния не подтверждено. Не продолжайте изменения; проверьте резервную копию.'
              : `Слияние остановлено: ${error.message || 'не удалось сохранить данные'}. Данные не затираются.`,
            'warning',
            8000
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

function chooseMergeConflict(field, primary, duplicate) {
  return new Promise(resolve => {
    const ov = openOverlay({ title: 'Конфликт при слиянии', onClose: () => resolve(null) });
    ov.body.innerHTML = `<p>Различается поле <strong>${escapeHtml(field)}</strong>. Выберите источник значения. Значения контактов и паролей здесь не показываются.</p>`;
    for (const [choice, char] of [
      ['primary', primary],
      ['duplicate', duplicate]
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = `Взять из «${char.nick}» (${char.id})`;
      button.onclick = () => {
        resolve(choice);
        ov.close();
      };
      ov.foot.append(button);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn ghost';
    cancel.textContent = 'Отмена';
    cancel.onclick = () => ov.close();
    ov.foot.append(cancel);
  });
}

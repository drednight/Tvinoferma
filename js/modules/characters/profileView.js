// js/modules/characters/profileView.js

import { state, NOTES_MAX_LENGTH } from '../../core/state.js';
import { mainPartyName, additionalPartiesOf, NO_PARTY_LABEL } from '../parties/membership.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { formatCoins, needsCoinRecheck } from '../../core/coins.js';
import { mskStamp } from '../../core/msk.js';
import { freshnessOf, freshnessChipHtml, marathonSyncList, formatWhen, formatHoursSpan, thresholdHours } from '../../core/freshness.js';
import { openCoinHistory } from './coinHistory.js';
import { showModal, toast, confirmModal, closeModal } from '../../core/ui.js';
import { getClassIconSrc } from '../../core/constants.js';
import { openCharacterForm } from './formEditor.js'; 
import { levelBonusLabel } from './stateManager.js';
import { statChange, statsChangeLog } from './statsHistory.js';
import { ALL_FIELDS } from '../../data/characterFields.js';
import { showCharactersWithTag } from './list.js';
import { openSyncHelper, refreshBalanceFor, refreshAuthFor } from '../sync/syncManager.js';
import { getAuthView, authDetails } from '../sync/authStatus.js';
import { hasGameCenterPath, loginStatusText, launchContext } from '../launcher/launch.js';
import { attachedGcs, accountKeysOf } from '../launcher/gameCenters.js';

function maskText(text, length = 8) {
  if (!text) return '';
  const str = String(text);
  if (str.length <= 4) return '••••';
  return str.substring(0, 2) + '•'.repeat(Math.min(length, str.length - 4)) + str.substring(str.length - 2);
}

const EYE_SVG_OPEN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_SVG_CLOSED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

/** Какие GameCenter из общего списка прикреплены к персонажу (строка в блоке «Запуск игры»). */
function gcListText(char) {
  const names = attachedGcs(char, launchContext().gameCenters).map(g => g.name);
  return names.length ? `Прикреплено: ${names.join(', ')}` : 'GameCenter из общего списка не прикреплены.';
}

/**
 * Строка контакта в профиле: подпись, значение с копированием по клику и глаз.
 *
 * Одинаковый вид у всех четырёх полей — раньше каждое писалось вручную инлайновыми
 * стилями, и «email» с «телефоном» выглядели по-разному. Пустой контакт показывается
 * прочерком и не нажимается: иначе глаз обещает показать то, чего нет.
 */
function contactRowHtml(type, label, value) {
  const filled = !!value;
  return `
    <div class="contact-row-profile${filled ? '' : ' is-empty'}">
      <span class="contact-key-profile">${escapeHtml(label)}</span>
      <div class="contact-row-actions">
        <span class="contact-value profile-copy-trigger" data-type="${type}" data-original="${escapeHtml(value || '')}" title="Скопировать">${filled ? maskText(value) : '—'}</span>
        <button class="icon-btn profile-toggle-eye" data-target="${type}" title="Показать/Скрыть" aria-label="Показать или скрыть: ${escapeHtml(label)}">${EYE_SVG_OPEN}</button>
      </div>
    </div>`;
}

export function openCharacterProfile(char) {
  const isArchived = state.archivedCharacters.some(item => item.id === char.id);
  const archivedPartyLinks = isArchived
    ? state.archivedParties.flatMap(party => (party.memberLinks || [])
        .filter(link => link.characterId === char.id)
        .map(link => ({ party, link })))
    : [];
  const activeMainParty = mainPartyName(char, state.parties);
  const archivedMainParty = archivedPartyLinks.find(({ link }) => link.isMain);
  const stats = char.stats || {};
  const passes = char.dungeonPasses || {};
  const sky = char.sky || {};
  const contacts = char.contacts || {};
  const launch = char.launch || {};

  // Подписи статов для списка изменений берём из `characterFields.js`: названия уже есть,
  // и второй список с ними со временем разошёлся бы с первым
  const STAT_LABELS = Object.fromEntries(
    ALL_FIELDS.filter(f => f.path.startsWith('stats.'))
      .map(f => [f.path.slice(6), f.label.replace(/\s*\(.*\)$/, '')])
  );

  // Характеристика — плитка: подпись сверху, значение снизу, рядом разница с прошлым.
  // Раньше строка была «подпись …——— значение», и двадцать таких строк подряд превращались
  // в полосу из пунктиров и цифр. Плитки читаются списком, а не таблицей, и подписи
  // больше не приходится обрезать: ширину колонки задаёт сетка, а не длина названия.
  const statRow = (label, key) => {
    const value = Number(stats[key]) || 0;
    const change = statChange(char, key);
    const delta = change && change.delta !== 0
      ? `<span class="pf-stat-delta ${change.delta > 0 ? 'is-up' : 'is-down'}">${change.delta > 0 ? '+' : '−'}${Math.abs(change.delta).toLocaleString('ru-RU')}</span>`
      : '';
    const tip = change
      ? ` title="Прошлое значение: ${change.previous.toLocaleString('ru-RU')}${change.at ? ` · ${formatWhen(change.at)}` : ''}"`
      : '';
    return `
      <div class="pf-stat"${tip}>
        <span class="pf-stat-label">${label}</span>
        <span class="pf-stat-num">
          <b class="pf-stat-value">${value ? value.toLocaleString('ru-RU') : '—'}</b>
          ${delta}
        </span>
      </div>
    `;
  };

  // Последние изменения характеристик: когда и что именно поменялось
  const changeLog = statsChangeLog(char, 6);
  const changeLogHtml = changeLog.length
    ? changeLog.map(entry => {
        const shown = entry.changes.filter(c => STAT_LABELS[c.key]).slice(0, 6);
        const rest = entry.changes.length - shown.length;
        return `
          <div class="pf-changes-row">
            <span class="pf-changes-when">${entry.at ? escapeHtml(formatWhen(entry.at)) : 'дата не известна'}</span>
            <span class="pf-changes-list">${shown.map(c => `<span class="pf-change">
              <span class="pf-change-key">${escapeHtml(STAT_LABELS[c.key])}</span>
              <b class="${c.delta > 0 ? 'is-up' : 'is-down'}">${c.delta > 0 ? '+' : '−'}${Math.abs(c.delta).toLocaleString('ru-RU')}</b>
            </span>`).join('')}${rest > 0 ? `<span class="pf-change-more">и ещё ${rest}</span>` : ''}</span>
          </div>`;
      }).join('')
    : '<p class="pf-hint">Изменений пока не было — история появится, когда характеристики поменяются.</p>';

  const tagsHtml = (char.tags || []).length
    ? `<div class="pf-tags">${char.tags.map(tag => `<button type="button" class="tag-chip pf-tag" data-pf-tag="${escapeHtml(tag)}" title="Показать персонажей с этим тегом">#${escapeHtml(tag)}</button>`).join('')}</div>`
    : '';

  const content = `
    <div class="pf">
      <div class="pf-scroll">
        <!-- Шапка: кто это, главные строки и баланс справа -->
        <div class="pf-head">
          <div class="pf-avatar">
            ${getClassIconSrc(char.class)
              ? `<img src="${getClassIconSrc(char.class)}" alt="" />`
              : `<span>${escapeHtml((char.class || '?')[0])}</span>`}
          </div>
          <div class="pf-head-info">
            <div class="pf-title-row">
              <h2 class="pf-nick">${escapeHtml(char.nick)}</h2>
              <button id="btn-favorite-from-profile" class="pf-favorite${char.favorite ? ' is-active' : ''}" type="button"
                aria-pressed="${char.favorite ? 'true' : 'false'}"
                title="${char.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}">${char.favorite ? '★' : '☆'}</button>
            </div>
            <div class="pf-meta">
              <span>${escapeHtml(char.class || 'Класс не выбран')} · Уровень <b>${char.level}</b>${levelBonusLabel(char) ? ` <span class="char-bu">${levelBonusLabel(char)}</span>` : ''}</span>
              <span>☁️ ${escapeHtml(sky.name || 'Небо не выбрано')}${sky.level ? ` (Ур.${sky.level})` : ''}</span>
              <span>🛡️ Пати: ${escapeHtml(activeMainParty || archivedMainParty?.party.name || NO_PARTY_LABEL)}${!activeMainParty && archivedMainParty ? ' · архив' : ''}</span>
            </div>
            <p class="pf-meta-line muted" id="profile-auth-line">${isArchived ? '📦 Персонаж в архиве · автоматические проверки для него отключены' : authLineHtml(char)}</p>
            ${extraPartiesHtml(char)}
            <p class="pf-meta-line muted" title="Внутренний id: так персонаж называется в журнале задач и в папке профиля браузера">id: <code>${escapeHtml(char.id)}</code></p>
            ${tagsHtml}
          </div>
          <div class="pf-coins" id="profile-coins-block">${coinBlockHtml(char)}</div>
        </div>

        <!-- КОГДА ЧТО ПРОВЕРЕНО (баланс, вход, прогресс марафонов). Свёрнуто: это справка,
             а не то, за чем сюда приходят каждый день. -->
        <details class="pf-checks">
          <summary class="pf-checks-title">🕒 Когда что проверено</summary>
          <div id="profile-checks-block">${checksBlockHtml(char)}</div>
        </details>

        <div class="pf-cols">
          <!-- ЛЕВАЯ КОЛОНКА: чем пользуются часто — контакты, запуск, заметки -->
          <div class="pf-col">
            <details class="pf-panel" open>
              <summary class="pf-panel-title">
                Контактные данные
                <button type="button" class="btn ghost pf-contacts-all" id="pf-contacts-toggle-all" title="Показать или скрыть сразу все контакты">Показать все</button>
              </summary>
              <div class="pf-contacts">
                ${contactRowHtml('email', 'Email', contacts.email)}
                ${contactRowHtml('password', 'Пароль', contacts.password)}
                ${contactRowHtml('recovery', 'Recovery email', contacts.recoveryEmail)}
                ${contactRowHtml('phone', 'Телефон', contacts.phone)}
              </div>
            </details>

            <!-- ЗАПУСК ИГРЫ: свой GameCenter у каждого аккаунта; токен входа хранится в хранилище ОС, не в state.json -->
            <details class="pf-panel pf-launch">
              <summary class="pf-panel-title">🎮 Запуск игры</summary>
              <div class="pf-launch-body">
                <p class="pf-hint">GameCenter этого аккаунта. Запустить игру можно кнопкой «Играть» внизу.</p>
                <div id="pf-gc-list" class="muted">${escapeHtml(gcListText(char))}</div>
                <div><button id="pf-gc-manage" type="button" class="btn secondary" title="Список GameCenter с названиями и привязка персонажей (Настройки → Запуск игры)">⚙ GameCenter и персонажи…</button></div>
                <label class="pf-label" for="pf-gc-path">Свой лаунчер (запасной вариант, если выше ничего не прикреплено)</label>
                <div class="pf-launch-row">
                  <input id="pf-gc-path" class="input" placeholder="Например: C:\\Users\\Имя\\AppData\\Local\\GameCenter1" value="${escapeHtml(launch.gcPath || '')}" />
                  <button id="pf-gc-browse" type="button" class="btn secondary" title="Выбрать GameCenter.exe или AstrumPlay.exe в проводнике">📂 Обзор…</button>
                  <button id="pf-gc-save" type="button" class="btn secondary">Сохранить путь</button>
                </div>
                <div id="pf-gc-account" class="muted">${escapeHtml(loginStatusText(char))}</div>
                <div class="pf-launch-row">
                  <button id="pf-gc-capture" type="button" class="btn secondary" title="Сначала войдите в нужный аккаунт в самом лаунчере, затем нажмите: токен входа сохранится в хранилище ОС">🔑 Запомнить текущий вход</button>
                  <button id="pf-gc-forget" type="button" class="btn ghost">Забыть вход</button>
                </div>
              </div>
            </details>

            <div class="pf-panel">
              <div class="pf-panel-title">Примечания <small id="char-notes-status" class="muted"></small></div>
              <textarea id="char-notes" class="input" rows="4" maxlength="${NOTES_MAX_LENGTH}" placeholder="Заметки о персонаже: что докачать, что купить, особенности аккаунта…">${escapeHtml(char.notes || '')}</textarea>
            </div>

            <!-- Проходки и последние изменения — под примечаниями: это короткие сводки,
                 а характеристики справа занимают всю правую колонку целиком -->
            <div class="pf-panel">
              <div class="pf-panel-title">Проходки в данжи</div>
              <div class="pf-passes">
                <div class="pf-pass"><img src="/assets/icons/dungeons/pass-weapon.webp" alt="" /><strong>${passes.weapon || 0}</strong><small>Оружие</small></div>
                <div class="pf-pass"><img src="/assets/icons/dungeons/pass-armor.webp" alt="" /><strong>${passes.armor || 0}</strong><small>Доспех</small></div>
                <div class="pf-pass"><img src="/assets/icons/dungeons/pass-relic.webp" alt="" /><strong>${passes.relic || 0}</strong><small>Реликвия</small></div>
              </div>
            </div>

            <div class="pf-panel">
              <div class="pf-panel-title">Последние изменения характеристик</div>
              <div class="pf-changes">${changeLogHtml}</div>
            </div>
          </div>

          <!-- ПРАВАЯ КОЛОНКА: справочные характеристики, проходки и история изменений -->
          <div class="pf-col">
            <div class="pf-panel">
              <div class="pf-panel-title">Характеристики</div>
              <div class="pf-stat-group">
                <div class="pf-stat-group-title">Основные</div>
                <div class="pf-stats pf-stats-2x2">
                  ${statRow('Выносливость', 'endurance')}
                  ${statRow('Интеллект', 'intelligence')}
                  ${statRow('Сила', 'strength')}
                  ${statRow('Ловкость', 'agility')}
                </div>
              </div>
              <div class="pf-stat-group">
                <div class="pf-stat-group-title">Бой и защита</div>
                <div class="pf-stats">
                  ${statRow('Здоровье', 'hp')}
                  ${statRow('Маг. энергия', 'mp')}
                  ${statRow('Физ. атака', 'physAttack')}
                  ${statRow('Физ. защита', 'physDefense')}
                  ${statRow('Маг. атака', 'magAttack')}
                  ${statRow('Маг. защита', 'magDefense')}
                </div>
              </div>
              <div class="pf-stat-group">
                <div class="pf-stat-group-title">Показатели боя</div>
                <div class="pf-stats">
                  ${statRow('Шанс крит. удара', 'critChance')}
                  ${statRow('Критический урон', 'critDamage')}
                  ${statRow('Скорость атаки', 'atkSpeed')}
                  ${statRow('Уклонение', 'evasion')}
                  ${statRow('Меткость', 'accuracy')}
                  ${statRow('Показатель атаки (ПА)', 'pa')}
                  ${statRow('Показатель защиты (ПЗ)', 'pz')}
                  ${statRow('Боевой дух', 'morale')}
                  ${statRow('Бонус к уровню', 'levelBonus')}
                  ${statRow('Физ. пробивание', 'physPenetration')}
                  ${statRow('Маг. пробивание', 'magPenetration')}
                </div>
              </div>
              <div class="pf-stat-group">
                <div class="pf-stat-group-title">PvE</div>
                <div class="pf-stats">
                  ${statRow('Урон по монстрам', 'pvePa')}
                  ${statRow('Защита от монстров', 'pvePz')}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ФИКСИРОВАННАЯ НИЖНЯЯ ЧАСТЬ: слева «Удалить», по центру действия с персонажем, справа «Править» и «Закрыть» -->
      <div class="pf-footer">
         <button id="btn-delete-from-profile" class="btn danger pf-delete" type="button" title="Удалить персонажа" aria-label="Удалить персонажа">🗑</button>

         <div class="pf-footer-main">
            <button id="btn-launch-from-profile" class="btn pf-play" type="button" title="Запустить игру для этого персонажа через его GameCenter">
               <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>
               Играть
            </button>
            <button id="btn-open-sync-helper-footer" class="btn secondary" type="button" ${!isArchived && state.ui?.authCheck?.[char.id] === 'checking' ? 'disabled' : ''} title="${!isArchived && state.ui?.authCheck?.[char.id] === 'checking' ? 'Идёт проверка входа — дождитесь окончания' : 'Открыть браузер для входа'}">🌐 Сайт</button>
            <button id="btn-coin-history-footer" class="btn secondary" type="button" title="История изменений баланса Древних монет"><svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> История</button>
            ${isArchived ? '<span class="muted" title="Персонажи архива исключены из проверок">Проверки отключены</span>' : `<div class="pf-menu" id="pf-check-menu">
               <button type="button" class="btn secondary" id="btn-pf-check" aria-haspopup="true" aria-expanded="false" title="Проверить вход или обновить баланс">🔄 Проверить ▾</button>
               <div class="pf-menu-list" hidden>
                  <button type="button" data-pf-check="auth">🔐 Вход на сайт</button>
                  <button type="button" data-pf-check="coins" data-pf-coins>${needsCoinRecheck(char) ? '<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Перепроверить баланс' : '<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Баланс Древних монет'}</button>
               </div>
            </div>`}
         </div>

         <div class="pf-footer-end">
            <button id="btn-edit-from-profile" class="btn primary" type="button">✏️ Править</button>
            <button id="btn-close-profile" class="btn ghost" type="button">Закрыть</button>
         </div>
      </div>
    </div>
  `;

  showModal({
    title: `Профиль: ${char.nick}`,
    content,
    // Две колонки панелей: обычная ширина окна режет характеристики пополам
    wide: true,
    submitText: null,
    cancelText: null,
    onSubmit: () => true,
    onClose: () => {}
  });

  // Привязка событий после рендера
  setTimeout(() => {
    const modalRoot = document.getElementById('modal-root');
    if(!modalRoot) return;

    // Глаз у контакта: показать или скрыть значение.
    // Логика в одной функции, потому что ею пользуются и глаз в строке, и кнопка
    // «Показать все» — раньше это были две копии одного и того же кода
    const setEye = (btn, show) => {
      const row = btn.closest('.contact-row-profile');
      const valueSpan = row?.querySelector('.profile-copy-trigger');
      const original = valueSpan?.dataset.original;
      if (!valueSpan || !original) return;
      valueSpan.textContent = show ? original : maskText(original);
      btn.innerHTML = show ? EYE_SVG_CLOSED : EYE_SVG_OPEN;
      btn.style.opacity = show ? '1' : '0.4';
      btn.title = show ? 'Скрыть' : 'Показать/Скрыть';
    };
    modalRoot.querySelectorAll('.profile-toggle-eye').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const row = btn.closest('.contact-row-profile');
        const valueSpan = row?.querySelector('.profile-copy-trigger');
        if (!valueSpan?.dataset.original) return;
        setEye(btn, !valueSpan.textContent.includes('•'));
      };
    });

    // «Показать все» / «Скрыть все»: один глаз на все контакты вместо четырёх кликов
    const toggleAll = document.getElementById('pf-contacts-toggle-all');
    toggleAll?.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = toggleAll.textContent !== 'Скрыть все';
      modalRoot.querySelectorAll('.profile-toggle-eye').forEach(btn => setEye(btn, show));
      toggleAll.textContent = show ? 'Скрыть все' : 'Показать все';
    });

    // Тег в профиле ведёт к списку персонажей с тем же тегом
    modalRoot.querySelectorAll('.pf-tag').forEach(chip => {
      chip.onclick = () => showCharactersWithTag(chip.dataset.pfTag);
    });

    // Copy Triggers
    modalRoot.querySelectorAll('.profile-copy-trigger').forEach(span => {
      span.onclick = (e) => {
        e.stopPropagation();
        if (span.dataset.original) {
           navigator.clipboard.writeText(span.dataset.original).then(() => {
             toast('Скопировано!', 'success');
             const oldBg = span.style.background;
             span.style.background = 'rgba(76, 175, 80, 0.3)';
             setTimeout(() => span.style.background = oldBg, 300);
           });
        }
      };
    });

    // Примечания: автосохранение с задержкой (текст не пишем в журналы)
    const notesEl = document.getElementById('char-notes');
    const notesStatus = document.getElementById('char-notes-status');
    if (notesEl) {
      let timer = null;
      const saveNotes = async () => {
        clearTimeout(timer); timer = null;
        const next = notesEl.value.slice(0, NOTES_MAX_LENGTH);
        if (next === (char.notes || '')) return;
        char.notes = next;
        char.updatedAt = new Date().toISOString();
        try {
          await persist();
          if (notesStatus) notesStatus.textContent = '— сохранено';
        } catch (e) {
          if (notesStatus) notesStatus.textContent = '— ошибка сохранения';
        }
      };
      notesEl.addEventListener('input', () => {
        if (notesStatus) notesStatus.textContent = '— …';
        clearTimeout(timer);
        timer = setTimeout(saveNotes, 700);
      });
      notesEl.addEventListener('blur', saveNotes); // не теряем текст при закрытии окна
    }

    // Close Button
    const closeBtn = document.getElementById('btn-close-profile');
    if(closeBtn) {
      closeBtn.onclick = () => closeModal();
    }

    const favoriteBtn = document.getElementById('btn-favorite-from-profile');
    favoriteBtn?.addEventListener('click', async () => {
      char.favorite = !char.favorite;
      char.updatedAt = new Date().toISOString();
      favoriteBtn.classList.toggle('is-active', char.favorite);
      favoriteBtn.textContent = char.favorite ? '★' : '☆';
      favoriteBtn.setAttribute('aria-pressed', String(char.favorite));
      favoriteBtn.setAttribute('title', char.favorite ? 'Убрать из избранного' : 'Добавить в избранное');
      await persist();
      toast(char.favorite ? 'Добавлено в избранное' : 'Удалено из избранного', 'success');
    });

    // Edit Button
    const editBtn = document.getElementById('btn-edit-from-profile');
    if(editBtn) {
      editBtn.onclick = () => {
        closeModal();
        openCharacterForm(char);
      };
    }

    // Delete Button
    const delBtn = document.getElementById('btn-delete-from-profile');
    if(delBtn) {
      delBtn.onclick = async () => {
        const ok = await confirmModal({
          title: `Удалить персонажа «${char.nick}»?`,
          text: 'Действие необратимо. Вместе с персонажем удаляются его пароли в хранилище ОС, запомненные входы GameCenter и история монет.',
          okText: 'Удалить персонажа',
          danger: true
        });
        if(ok) {
           // сохранённый вход GameCenter лежит в хранилище ОС: вместе с персонажем удаляем и его
           accountKeysOf(char).forEach(key => import('../launcher/launch.js').then(m => m.forgetAccount(key)).catch(() => {}));
           import('../../core/state.js').then(({ state }) => {
             import('../../core/storage.js').then(({ persist }) => {
               state.characters = state.characters.filter(c => c.id !== char.id);
               state.archivedCharacters = state.archivedCharacters.filter(c => c.id !== char.id);
               state.archivedParties.forEach(party => {
                 party.memberLinks = (party.memberLinks || []).filter(link => link.characterId !== char.id);
               });
               persist().then(() => {
                 closeModal();
                 import('./list.js').then(mod => mod.renderCharacters());
                 import('../parties/index.js').then(mod => mod.renderParties());
                 toast('Персонаж удален', 'success');
               });
             });
           });
        }
      };
    }

    // Запуск игры: путь к GameCenter, запомненный вход, кнопка «Играть»
    const gcInput = document.getElementById('pf-gc-path');
    const redrawGc = () => {
      const el = document.getElementById('pf-gc-account');
      if (el) el.textContent = loginStatusText(char);
      const list = document.getElementById('pf-gc-list');
      if (list) list.textContent = gcListText(char);
    };
    // Путь из поля сохраняется, если его изменили и не нажали «Сохранить путь»
    const ensureGcPathSaved = async () => {
      const typed = String(gcInput?.value || '').trim();
      if (typed === String(char.launch?.gcPath || '')) return true;
      const { saveGameCenterPath } = await import('../launcher/partyLaunch.js');
      return saveGameCenterPath(char, typed);
    };
    document.getElementById('pf-gc-browse')?.addEventListener('click', async () => {
      try {
        const { pickGameCenter } = await import('../launcher/launch.js');
        const picked = await pickGameCenter();
        if (picked && gcInput) gcInput.value = picked;
      } catch (e) { toast(String(e?.message || e), 'error'); }
    });
    document.getElementById('pf-gc-manage')?.addEventListener('click', async () => {
      const { openGameCentersModal } = await import('../launcher/gcSettingsModal.js');
      openGameCentersModal({ onClose: () => openCharacterProfile(char) });
    });
    document.getElementById('pf-gc-save')?.addEventListener('click', async () => {
      const { saveGameCenterPath } = await import('../launcher/partyLaunch.js');
      await saveGameCenterPath(char, gcInput?.value);
    });
    document.getElementById('pf-gc-capture')?.addEventListener('click', async () => {
      if (!(await ensureGcPathSaved())) return;
      const { captureLogin } = await import('../launcher/partyLaunch.js');
      await captureLogin(char);
      redrawGc();
    });
    document.getElementById('pf-gc-forget')?.addEventListener('click', async () => {
      const { forgetLogin } = await import('../launcher/partyLaunch.js');
      await forgetLogin(char);
      redrawGc();
    });
    document.getElementById('btn-launch-from-profile')?.addEventListener('click', async () => {
      if (!(await ensureGcPathSaved())) return;
      if (!hasGameCenterPath(char)) {
        const fold = modalRoot.querySelector('.pf-launch');
        if (fold) fold.open = true;
        gcInput?.focus();
        toast('Укажите лаунчер этого аккаунта', 'error');
        return;
      }
      const { launchGroup } = await import('../launcher/partyLaunch.js');
      launchGroup(`Запуск игры: ${char.nick}`, [char]);
    });

    // История Древних монет (рядом с «Открыть сайт»)
    document.getElementById('btn-coin-history-footer')?.addEventListener('click', () => openCoinHistory(char.id));

    // NEW: Open Site / Sync Helper Button (в футере)
    const syncFooterBtn = document.getElementById('btn-open-sync-helper-footer');
    if(syncFooterBtn) {
      syncFooterBtn.onclick = () => {
        openSyncHelper(char.id); 
      };
    }

    // Меню «🔄 Проверить»: вход и баланс; после проверки строки в шапке обновляются сразу
    const menu = document.getElementById('pf-check-menu');
    const menuBtn = document.getElementById('btn-pf-check');
    const menuList = menu?.querySelector('.pf-menu-list');
    const setMenu = (open) => { if (!menuList) return; menuList.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
    if (menuBtn) menuBtn.onclick = (e) => { e.stopPropagation(); setMenu(menuList.hidden); };
    const redraw = () => {
      const line = document.getElementById('profile-auth-line');
      if (line) line.innerHTML = authLineHtml(char);
      const checks = document.getElementById('profile-checks-block');
      if (checks) checks.innerHTML = checksBlockHtml(char);
      const coins = document.getElementById('profile-coins-block');
      if (coins) coins.innerHTML = coinBlockHtml(char);          // красная пометка исчезает, если баланс перечитан
      const item = document.querySelector('[data-pf-coins]');
      if (item) item.textContent = needsCoinRecheck(char) ? '<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Перепроверить баланс' : '<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Баланс Древних монет';
    };
    menu?.querySelectorAll('[data-pf-check]').forEach(btn => {
      btn.onclick = async () => {
        const kind = btn.dataset.pfCheck;
        setMenu(false);
        menu.querySelectorAll('[data-pf-check]').forEach(b => { b.disabled = true; });
        try {
          if (kind === 'auth') await refreshAuthFor(char);
          else await refreshBalanceFor(char);
        } catch (err) {
          console.error(err);
          toast(kind === 'auth' ? 'Не удалось запустить проверку входа' : 'Ошибка запуска проверки', 'error');
        } finally {
          menu.querySelectorAll('[data-pf-check]').forEach(b => { b.disabled = false; });
          redraw();
        }
      };
    });
    // клик вне меню закрывает его
    const closeOnOutside = (e) => {
      if (!menu || !document.body.contains(menu)) { document.removeEventListener('click', closeOnOutside); return; }   // профиль закрыт
      if (!menuList.hidden && !menu.contains(e.target)) setMenu(false);
    };
    document.addEventListener('click', closeOnOutside);

  }, 100);
}

/** Строка «🔐 🟢 Онлайн · проверено …» (проверка запускается из меню «🔄 Проверить» внизу). */
function authLineHtml(char) {
  const v = getAuthView(char);
  return `🔐 <span style="color:${v.color};">${v.icon} ${escapeHtml(authDetails(char))}</span>`;
}

/**
 * Окно «Когда что проверено»: баланс, вход и прогресс каждого идущего марафона — дата, «N назад»
 * и пометка, если данные устарели (порог — в «Настройки → Свежесть данных»).
 */
function checksBlockHtml(char) {
  const row = (icon, label, item) => `
    <div class="pf-check-row">
      <span class="pf-check-name">${icon} ${escapeHtml(label)}</span>
      <span class="pf-check-when${item.never ? ' muted' : ''}">${escapeHtml(formatWhen(item.at))}</span>
      ${item.never ? '<span class="fresh-chip is-stale">нет данных</span>' : freshnessChipHtml(item, { bare: true })}
    </div>`;
  const marathons = marathonSyncList(char.id, state.marathons);
  const rows = [
    row('<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg>', 'Баланс монет', freshnessOf('balance', char.lastCoinUpdate, state.settings)),
    row('🔐', 'Вход на сайт', freshnessOf('login', char.lastLoginCheck, state.settings)),
    ...marathons.map(({ marathon, at }) => row('🏆', `Марафон «${marathon.title}»`, freshnessOf('marathon', at, state.settings)))
  ];
  const limit = (kind) => formatHoursSpan(thresholdHours(state.settings, kind));
  return `
    ${rows.join('')}
    ${marathons.length ? '' : '<div class="pf-check-note muted">🏆 Идущих марафонов с адресом страницы на сайте нет — прогресс не сверяется.</div>'}
    <div class="pf-check-note muted">Данные считаются устаревшими через: баланс — ${limit('balance')}, вход — ${limit('login')}, марафон — ${limit('marathon')} (Настройки → Свежесть данных).</div>`;
}

/** Баланс Древних монет, время проверки и пометка «записан до исправления» (пока баланс не перечитан). */
function coinBlockHtml(char) {
  let last = '<span class="muted" style="font-size:0.7rem;">Не синхр.</span>';
  const d = char.lastCoinUpdate ? new Date(char.lastCoinUpdate) : null;
  if (d && !isNaN(d.getTime())) {
    last = `<span class="muted" style="font-size:0.7rem;">Проверено: ${mskStamp(d)}</span>`;
  }
  return `
    <div style="font-size:1.5rem; color:gold; font-weight:bold;"><svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> ${formatCoins(char.ancientCoins || 0)}</div>
    <small class="muted" style="display:block; margin-bottom:4px;">Древних монет</small>
    ${last}
    ${needsCoinRecheck(char) ? '<small data-coin-warn style="display:block; margin-top:4px; color:#f7768e; max-width:200px;" title="Раньше баланс с запятой (28,5) мог записаться как 285. Откройте «🔄 Проверить» → «Перепроверить баланс»: значение будет прочитано с сайта заново.">⚠ Баланс записан до исправления — перепроверьте</small>' : ''}`;
}

/** Одна строка «↳ доп. пати: N» под основной; список, в каких ещё пати состоит персонаж, раскрывается по клику. */
function extraPartiesHtml(char) {
  const extra = additionalPartiesOf(char, state.parties);
  const archivedExtra = state.archivedCharacters.some(item => item.id === char.id)
    ? state.archivedParties.flatMap(party => (party.memberLinks || [])
        .filter(link => link.characterId === char.id && !link.isMain)
        .map(() => `${party.name} · архив`))
    : [];
  const labels = [...extra.map(party => party.name), ...archivedExtra];
  if (!labels.length) return '';
  return `
    <details class="pf-extra-parties" data-extra-party style="margin:2px 0 4px 22px; font-size:0.9em;">
      <summary class="muted" style="cursor:pointer;">↳ доп. пати: ${labels.length}</summary>
      <ul class="muted" style="margin:4px 0 0; padding-left:18px;">${labels.map(name => `<li>${escapeHtml(name)}</li>`).join('')}</ul>
    </details>`;
}

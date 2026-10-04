// js/modules/characters/profileView.js

import { state, NOTES_MAX_LENGTH } from '../../core/state.js';
import { mainPartyName, additionalPartiesOf, NO_PARTY_LABEL } from '../parties/membership.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { formatCoins, needsCoinRecheck } from '../../core/coins.js';
import { freshnessOf, freshnessChipHtml, marathonSyncList, formatWhen, formatHoursSpan, thresholdHours } from '../../core/freshness.js';
import { openCoinHistory } from './coinHistory.js';
import { showModal, toast, confirmDialog, closeModal } from '../../core/ui.js';
import { getClassIconSrc } from '../../core/constants.js';
import { openCharacterForm } from './formEditor.js'; 
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

export function openCharacterProfile(char) {
  const stats = char.stats || {};
  const passes = char.dungeonPasses || {};
  const sky = char.sky || {};
  const contacts = char.contacts || {};
  const launch = char.launch || {};
  

  const statRow = (label, val) => `
    <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed rgba(255,255,255,0.05);">
      <span class="muted">${label}</span>
      <strong>${val || '-'}</strong>
    </div>
  `;

  const content = `
    <div class="profile-view-container" style="display:flex; flex-direction:column; max-height: 70vh;">
      
      <!-- Скроллируемая область -->
      <div style="overflow-y: auto; flex-grow: 1; padding-right: 10px; margin-bottom: 15px;">
        
        <!-- Шапка -->
        <div style="display:flex; gap:20px; align-items:center; margin-bottom:20px; padding-bottom:20px; border-bottom:1px solid var(--border);">
          <div style="width:80px; height:80px; background:rgba(255,255,255,0.05); border-radius:12px; display:flex; align-items:center; justify-content:center; overflow:hidden; border:2px solid var(--accent); flex-shrink:0;">
             ${getClassIconSrc(char.class) 
               ? `<img src="${getClassIconSrc(char.class)}" style="width:100%; height:100%; object-fit:contain;" />` 
               : `<span style="font-size:2rem; font-weight:bold; color:var(--muted);">${(char.class || '?')[0]}</span>`}
          </div>
          <div>
            <h2 style="margin:0; color:var(--accent);">${escapeHtml(char.nick)}</h2>
            <small class="muted" title="Внутренний id: так персонаж называется в журнале задач и в папке профиля браузера">id: <code>${escapeHtml(char.id)}</code></small>
            <p class="muted" style="margin:4px 0;">${escapeHtml(char.class)} • Уровень ${char.level}</p>
            <p class="muted" style="margin:4px 0;">☁️ ${escapeHtml(sky.name || 'Небо не выбрано')} ${sky.level ? `(Ур.${sky.level})` : ''}</p>
            <p class="muted" style="margin:4px 0;" id="profile-auth-line">${authLineHtml(char)}</p>
            <p class="muted" style="margin:4px 0;">🛡️ Пати: ${escapeHtml(mainPartyName(char, state.parties) || NO_PARTY_LABEL)}</p>
            ${extraPartiesHtml(char)}
          </div>
          
          <!-- БЛОК МОНЕТ (обновление баланса — в меню «🔄 Проверить» внизу) -->
          <div id="profile-coins-block" style="margin-left:auto; text-align:right; min-width:120px;">${coinBlockHtml(char)}</div>
        </div>

        <!-- КОГДА ЧТО ПРОВЕРЕНО (баланс, вход, прогресс марафонов) -->
        <details class="pf-checks">
          <summary class="pf-checks-title">🕒 Когда что проверено</summary>
          <div id="profile-checks-block">${checksBlockHtml(char)}</div>
        </details>

        <!-- КОНТАКТНЫЕ ДАННЫЕ -->
        <details style="margin-bottom:16px; border:1px solid var(--border); padding:8px; border-radius:4px;" open>
          <summary style="cursor:pointer; font-weight:bold; color:var(--muted);">Контактные данные</summary>
          <div style="margin-top:12px; font-family:monospace; font-size:0.9rem; line-height:1.6; display:flex; flex-direction:column; gap:8px;">
            <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:4px;" class="contact-row-profile">
               <span class="muted" style="font-size:0.7rem;">EMAIL:</span>
               <div style="display:flex; align-items:center; gap:6px;">
                  <span class="contact-value profile-copy-trigger" data-type="email" data-original="${escapeHtml(contacts.email || '')}" style="cursor:pointer; color:var(--text-primary);">${contacts.email ? maskText(contacts.email) : '-'}</span>
                  <button class="icon-btn profile-toggle-eye" data-target="email" style="opacity:0.4; display:flex; align-items:center;" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
               </div>
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:4px;" class="contact-row-profile">
               <span class="muted" style="font-size:0.7rem;">PASSWORD:</span>
               <div style="display:flex; align-items:center; gap:6px;">
                  <span class="contact-value profile-copy-trigger" data-type="password" data-original="${escapeHtml(contacts.password || '')}" style="cursor:pointer; color:var(--text-primary);">${contacts.password ? maskText(contacts.password) : '-'}</span>
                  <button class="icon-btn profile-toggle-eye" data-target="password" style="opacity:0.4; display:flex; align-items:center;" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
               </div>
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:4px;" class="contact-row-profile">
               <span class="muted" style="font-size:0.7rem;">RECOVERY EMAIL:</span>
               <div style="display:flex; align-items:center; gap:6px;">
                  <span class="contact-value profile-copy-trigger" data-type="recovery" data-original="${escapeHtml(contacts.recoveryEmail || '')}" style="cursor:pointer; color:var(--text-primary);">${contacts.recoveryEmail ? maskText(contacts.recoveryEmail) : '-'}</span>
                  <button class="icon-btn profile-toggle-eye" data-target="recovery" style="opacity:0.4; display:flex; align-items:center;" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
               </div>
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:4px;" class="contact-row-profile">
               <span class="muted" style="font-size:0.7rem;">PHONE:</span>
               <div style="display:flex; align-items:center; gap:6px;">
                  <span class="contact-value profile-copy-trigger" data-type="phone" data-original="${escapeHtml(contacts.phone || '')}" style="cursor:pointer; color:var(--text-primary);">${contacts.phone ? maskText(contacts.phone) : '-'}</span>
                  <button class="icon-btn profile-toggle-eye" data-target="phone" style="opacity:0.4; display:flex; align-items:center;" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
               </div>
            </div>
          </div>
        </details>

        <!-- ЗАПУСК ИГРЫ: свой GameCenter у каждого аккаунта; токен входа хранится в хранилище ОС, не в state.json -->
        <details class="pf-launch" style="margin-bottom:16px; border:1px solid var(--border); padding:8px; border-radius:4px;" ${hasGameCenterPath(char) ? 'open' : ''}>
          <summary style="cursor:pointer; font-weight:bold; color:var(--muted);">🎮 Запуск игры</summary>
          <div style="margin-top:12px; display:flex; flex-direction:column; gap:10px;">
            <div id="pf-gc-list" class="muted" style="font-size:0.85rem;">${escapeHtml(gcListText(char))}</div>
            <div><button id="pf-gc-manage" type="button" class="btn secondary" title="Список GameCenter с названиями и привязка персонажей (Настройки → Запуск игры)">⚙ GameCenter и персонажи…</button></div>
            <label class="muted" style="font-size:0.8rem;" for="pf-gc-path">Свой GameCenter (запасной вариант, если выше ничего не прикреплено): папка или файл GameCenter.exe</label>
            <div style="display:flex; gap:8px;">
              <input id="pf-gc-path" class="input" style="flex:1;" placeholder="Например: C:\\Users\\Имя\\AppData\\Local\\GameCenter1" value="${escapeHtml(launch.gcPath || '')}" />
              <button id="pf-gc-browse" type="button" class="btn secondary" title="Выбрать GameCenter.exe в проводнике">📂 Обзор…</button>
              <button id="pf-gc-save" type="button" class="btn secondary">Сохранить путь</button>
            </div>
            <div id="pf-gc-account" class="muted" style="font-size:0.85rem;">${escapeHtml(loginStatusText(char))}</div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button id="pf-gc-capture" type="button" class="btn secondary" title="Сначала войдите в нужный аккаунт в самом GameCenter, затем нажмите: токен входа сохранится в хранилище ОС">🔑 Запомнить текущий вход GameCenter</button>
              <button id="pf-gc-forget" type="button" class="btn ghost">Забыть вход</button>
            </div>
          </div>
        </details>

        <!-- ПРИМЕЧАНИЯ (локально, автосохранение) -->
        <div class="info-block" style="margin-bottom:16px;">
          <h4>Примечания <small id="char-notes-status" class="muted" style="font-weight:normal;"></small></h4>
          <textarea id="char-notes" class="input" rows="4" maxlength="${NOTES_MAX_LENGTH}" style="width:100%; resize:vertical;" placeholder="Заметки о персонаже: что докачать, что купить, особенности аккаунта…">${escapeHtml(char.notes || '')}</textarea>
        </div>

        <!-- Статы -->
        <div class="info-block" style="margin-bottom:16px;">
          <h4>Основные характеристики</h4>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
             ${statRow('Выносливость', stats.endurance)}
             ${statRow('Интеллект', stats.intelligence)}
             ${statRow('Сила', stats.strength)}
             ${statRow('Ловкость', stats.agility)}
          </div>
        </div>

        <div class="info-block" style="margin-bottom:16px;">
          <h4>Бой и Защита</h4>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
             ${statRow('Здоровье', stats.hpMax ? `${stats.hp}/${stats.hpMax}` : stats.hp)}
             ${statRow('Маг. энергия', stats.mpMax ? `${stats.mp}/${stats.mpMax}` : stats.mp)}
             ${statRow('Физ. атака', stats.physAttack)}
             ${statRow('Физ. защита', stats.physDefense)}
             ${statRow('Маг. атака', stats.magAttack)}
             ${statRow('Маг. защита', stats.magDefense)}
          </div>
        </div>

        <div class="info-block" style="margin-bottom:16px;">
          <h4>Показатели боя</h4>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
             ${statRow('Шанс крит. удара', stats.critChance ? `${stats.critChance}%` : '-')}
             ${statRow('Критический урон', stats.critDamage ? `${stats.critDamage}%` : '-')}
             ${statRow('Скорость атаки', stats.atkSpeed)}
             ${statRow('Уклонение', stats.evasion)}
             ${statRow('Меткость', stats.accuracy)}
             ${statRow('Показатель атаки (ПА)', stats.pa)}
             ${statRow('Показатель защиты (ПЗ)', stats.pz)}
             ${statRow('Боевой дух', stats.morale)}
             ${statRow('Сила', stats.power)}
             ${statRow('Скрытность', stats.stealth)}
             ${statRow('Обнаружение', stats.detection)}
          </div>
        </div>

        <div class="info-block" style="margin-bottom:16px;">
          <h4>PvE и Пробивание</h4>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
             ${statRow('Урон по монстрам (PvE PA)', stats.pvePa)}
             ${statRow('Защита от монстров (PvE PZ)', stats.pvePz)}
             ${statRow('Физ. пробивание', stats.physPenetration)}
             ${statRow('Маг. пробивание', stats.magPenetration)}
          </div>
        </div>

        <!-- Проходки -->
        <div class="info-block" style="margin-bottom:16px;">
          <h4>Проходки в данжи</h4>
          <div style="display:flex; gap:20px;">
            <div style="display:flex; align-items:center; gap:8px;"><img src="/assets/icons/dungeons/pass-weapon.png" style="width:24px;height:24px;"/> <strong>${passes.weapon || 0}</strong></div>
            <div style="display:flex; align-items:center; gap:8px;"><img src="/assets/icons/dungeons/pass-armor.png" style="width:24px;height:24px;"/> <strong>${passes.armor || 0}</strong></div>
            <div style="display:flex; align-items:center; gap:8px;"><img src="/assets/icons/dungeons/pass-relic.png" style="width:24px;height:24px;"/> <strong>${passes.relic || 0}</strong></div>
          </div>
        </div>

      </div>
      
      <!-- ФИКСИРОВАННАЯ НИЖНЯЯ ЧАСТЬ: слева «Удалить», по центру действия с персонажем, справа «Редактировать» и «Закрыть» -->
      <div class="pf-footer">
         <button id="btn-delete-from-profile" class="btn danger pf-delete" type="button" title="Удалить персонажа" aria-label="Удалить персонажа">🗑</button>

         <div class="pf-footer-main">
            <button id="btn-launch-from-profile" class="btn pf-play" type="button" title="Запустить игру для этого персонажа через его GameCenter">
               <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>
               Играть
            </button>
            <button id="btn-open-sync-helper-footer" class="btn secondary" type="button" ${state.ui?.authCheck?.[char.id] === 'checking' ? 'disabled' : ''} title="${state.ui?.authCheck?.[char.id] === 'checking' ? 'Идёт проверка входа — дождитесь окончания' : 'Открыть браузер для входа'}">🌐 Сайт</button>
            <button id="btn-coin-history-footer" class="btn secondary" type="button" title="История изменений баланса Древних монет">🪙 История</button>
            <div class="pf-menu" id="pf-check-menu">
               <button type="button" class="btn secondary" id="btn-pf-check" aria-haspopup="true" aria-expanded="false" title="Проверить вход или обновить баланс">🔄 Проверить ▾</button>
               <div class="pf-menu-list" hidden>
                  <button type="button" data-pf-check="auth">🔐 Вход на сайт</button>
                  <button type="button" data-pf-check="coins" data-pf-coins>${needsCoinRecheck(char) ? '🪙 Перепроверить баланс' : '🪙 Баланс Древних монет'}</button>
               </div>
            </div>
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
    submitText: null,
    cancelText: null,
    onSubmit: () => true,
    onClose: () => {}
  });

  // Привязка событий после рендера
  setTimeout(() => {
    const modalRoot = document.getElementById('modal-root');
    if(!modalRoot) return;

    // Toggle Eyes
    modalRoot.querySelectorAll('.profile-toggle-eye').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const row = btn.closest('.contact-row-profile');
        const valueSpan = row.querySelector('.profile-copy-trigger');
        
        if (valueSpan && valueSpan.dataset.original) {
          const originalVal = valueSpan.dataset.original;
          const isCurrentlyMasked = valueSpan.textContent.includes('•');
          
          if (isCurrentlyMasked) {
             valueSpan.textContent = originalVal;
             btn.innerHTML = EYE_SVG_CLOSED;
             btn.style.opacity = '1';
          } else {
             valueSpan.textContent = maskText(originalVal);
             btn.innerHTML = EYE_SVG_OPEN;
             btn.style.opacity = '0.4';
          }
        }
      };
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
      delBtn.onclick = () => {
        if(confirmDialog(`Удалить персонажа "${char.nick}"? Это действие необратимо.`)) {
           // сохранённый вход GameCenter лежит в хранилище ОС: вместе с персонажем удаляем и его
           accountKeysOf(char).forEach(key => import('../launcher/launch.js').then(m => m.forgetAccount(key)).catch(() => {}));
           import('../../core/state.js').then(({ state }) => {
             import('../../core/storage.js').then(({ persist }) => {
               state.characters = state.characters.filter(c => c.id !== char.id);
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
        toast('Укажите GameCenter этого аккаунта', 'error');
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
      if (item) item.textContent = needsCoinRecheck(char) ? '🪙 Перепроверить баланс' : '🪙 Баланс Древних монет';
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
    row('🪙', 'Баланс монет', freshnessOf('balance', char.lastCoinUpdate, state.settings)),
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
    last = `<span class="muted" style="font-size:0.7rem;">Проверено: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  }
  return `
    <div style="font-size:1.5rem; color:gold; font-weight:bold;">🪙 ${formatCoins(char.ancientCoins || 0)}</div>
    <small class="muted" style="display:block; margin-bottom:4px;">Древних монет</small>
    ${last}
    ${needsCoinRecheck(char) ? '<small data-coin-warn style="display:block; margin-top:4px; color:#f7768e; max-width:200px;" title="Раньше баланс с запятой (28,5) мог записаться как 285. Откройте «🔄 Проверить» → «Перепроверить баланс»: значение будет прочитано с сайта заново.">⚠ Баланс записан до исправления — перепроверьте</small>' : ''}`;
}

/** Одна строка «↳ доп. пати: N» под основной; список, в каких ещё пати состоит персонаж, раскрывается по клику. */
function extraPartiesHtml(char) {
  const extra = additionalPartiesOf(char, state.parties);
  if (!extra.length) return '';
  return `
    <details class="pf-extra-parties" data-extra-party style="margin:2px 0 4px 22px; font-size:0.9em;">
      <summary class="muted" style="cursor:pointer;">↳ доп. пати: ${extra.length}</summary>
      <ul class="muted" style="margin:4px 0 0; padding-left:18px;">${extra.map(p => `<li>${escapeHtml(p.name)}</li>`).join('')}</ul>
    </details>`;
}

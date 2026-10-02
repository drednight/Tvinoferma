// js/modules/characters/profileView.js

import { state, NOTES_MAX_LENGTH } from '../../core/state.js';
import { mainPartyName, additionalPartiesOf, NO_PARTY_LABEL } from '../parties/membership.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { formatCoins } from '../../core/coins.js';
import { openCoinHistory } from './coinHistory.js';
import { showModal, toast, confirmDialog, closeModal } from '../../core/ui.js';
import { getClassIconSrc } from '../../core/constants.js';
import { openCharacterForm } from './formEditor.js'; 
import { openSyncHelper, refreshBalanceFor } from '../sync/syncManager.js';

function maskText(text, length = 8) {
  if (!text) return '';
  const str = String(text);
  if (str.length <= 4) return '••••';
  return str.substring(0, 2) + '•'.repeat(Math.min(length, str.length - 4)) + str.substring(str.length - 2);
}

const EYE_SVG_OPEN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_SVG_CLOSED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

export function openCharacterProfile(char) {
  const stats = char.stats || {};
  const passes = char.dungeonPasses || {};
  const sky = char.sky || {};
  const contacts = char.contacts || {};
  
  // Форматирование даты последнего обновления баланса (для шапки)
  let lastUpdateStr = '<span class="muted" style="font-size:0.7rem;">Не синхр.</span>';
  if (char.lastCoinUpdate) {
    try {
      const d = new Date(char.lastCoinUpdate);
      if (!isNaN(d.getTime())) {
        lastUpdateStr = `<span class="muted" style="font-size:0.7rem;">Проверено: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>`;
      }
    } catch(e) {}
  }

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
            <p class="muted" style="margin:4px 0;">🛡️ Пати: ${escapeHtml(mainPartyName(char, state.parties) || NO_PARTY_LABEL)}${additionalPartiesOf(char, state.parties).length ? ` <small>· доп.: ${escapeHtml(additionalPartiesOf(char, state.parties).map(p => p.name).join(', '))}</small>` : ''}</p>
          </div>
          
          <!-- БЛОК МОНЕТ С КНОПКОЙ ОБНОВЛЕНИЯ -->
          <div style="margin-left:auto; text-align:right; min-width:120px;">
            <div style="font-size:1.5rem; color:gold; font-weight:bold;">🪙 ${formatCoins(char.ancientCoins || 0)}</div>
            <small class="muted" style="display:block; margin-bottom:4px;">Древних монет</small>
            
            ${lastUpdateStr}
            
            <button id="btn-refresh-coins-header" 
                    class="btn small ghost" 
                    style="margin-top:6px; font-size:0.75rem; padding:4px 8px; border:1px solid var(--border);"
                    title="Проверить актуальный баланс на сайте">
                🔄 Обновить
            </button>
          </div>
        </div>

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
      
      <!-- ФИКСИРОВАННАЯ НИЖНЯЯ ЧАСТЬ С НОВЫМИ КНОПКАМИ -->
      <div style="flex-shrink: 0; display:flex; gap:10px; justify-content:space-between; align-items:center; border-top:1px solid var(--border); padding-top:15px; background: var(--panel); position: sticky; bottom: 0; z-index: 10;">
         
         <!-- Левая группа: Опасные действия -->
         <div style="display:flex; gap:10px;">
            <button id="btn-delete-from-profile" class="btn danger">🗑 Удалить</button>
         </div>

         <!-- Центральная группа: Синхронизация -->
         <div style="display:flex; gap:10px;">
            <button id="btn-open-sync-helper-footer" class="btn secondary" title="Открыть браузер для входа">
               🔑 Открыть сайт
            </button>
            <button id="btn-coin-history-footer" class="btn secondary" title="История изменений баланса Древних монет">
               🪙 История
            </button>
         </div>

         <!-- Правая группа: Основные действия -->
         <div style="display:flex; gap:10px;">
            <button id="btn-edit-from-profile" class="btn primary">✏️ Редактировать</button>
            <button id="btn-close-profile" class="btn ghost">Закрыть</button>
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

    // История Древних монет (рядом с «Открыть сайт»)
    document.getElementById('btn-coin-history-footer')?.addEventListener('click', () => openCoinHistory(char.id));

    // NEW: Open Site / Sync Helper Button (в футере)
    const syncFooterBtn = document.getElementById('btn-open-sync-helper-footer');
    if(syncFooterBtn) {
      syncFooterBtn.onclick = () => {
        openSyncHelper(char.id); 
      };
    }

    // Refresh Coins Header Button (остается в шапке)
    const refreshHeaderBtn = document.getElementById('btn-refresh-coins-header');
    if(refreshHeaderBtn) {
      refreshHeaderBtn.onclick = async () => {
        const originalText = refreshHeaderBtn.textContent;
        refreshHeaderBtn.disabled = true;
        refreshHeaderBtn.textContent = '⏳...';
        
        try {
            await refreshBalanceFor(char);
        } catch (err) {
            console.error(err);
            toast('Ошибка запуска проверки', 'error');
        } finally {
            setTimeout(() => {
                refreshHeaderBtn.disabled = false;
                refreshHeaderBtn.textContent = originalText;
            }, 3000);
        }
      };
    }

  }, 100);
}
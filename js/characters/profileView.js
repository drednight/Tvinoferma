// js/characters/profileView.js

import { state } from '../state.js';
import { persist } from '../storage.js';
import { escapeHtml } from '../utils.js';
import { showModal, toast, confirmDialog, closeModal } from '../ui.js';
import { getClassIconSrc } from '../constants.js';
import { openCharacterForm } from './formEditor.js'; 
// Импортируем именно ту функцию, которая есть в syncManager.js
import { openSyncHelper } from '../syncManager.js'; 

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
  const recentHistory = (char.coinHistory || []).slice(-5).reverse();

  const statRow = (label, val) => `
    <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed rgba(255,255,255,0.05);">
      <span class="muted">${label}</span>
      <strong>${val || '-'}</strong>
    </div>
  `;

  // Блок синхронизации
  const syncBlock = `
    <div class="info-block" style="margin-top:20px; border:1px solid var(--accent); background:rgba(122, 162, 247, 0.05); padding:15px; border-radius:8px;">
      <h4 style="color:var(--accent); margin-bottom:10px;">🌐 Синхронизация данных PW Online</h4>
      <p class="muted" style="font-size:0.85rem; margin-bottom:10px;">
        Автоматический вход невозможен из-за защиты VK Play.<br/>
        Используйте помощника ниже для быстрого копирования данных и ручного обновления баланса.
      </p>
      
      <button id="btn-open-sync-helper" class="btn primary" style="width:100%;">
        🔑 Открыть помощник синхронизации
      </button>
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
            <p class="muted" style="margin:4px 0;">${escapeHtml(char.class)} • Уровень ${char.level}</p>
            <p class="muted" style="margin:4px 0;">☁️ ${escapeHtml(sky.name || 'Небо не выбрано')} ${sky.level ? `(Ур.${sky.level})` : ''}</p>
            <p class="muted" style="margin:4px 0;">🛡️ Пати: ${escapeHtml(char.party || 'Без пати')}</p>
          </div>
          <div style="margin-left:auto; text-align:right;">
            <div style="font-size:1.5rem; color:gold; font-weight:bold;">🪙 ${char.ancientCoins.toLocaleString('ru-RU')}</div>
            <small class="muted">Древних монет</small>
          </div>
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

        <!-- Контакты -->
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

        <!-- История -->
        <div class="info-block">
          <h4>История транзакций (последние 5)</h4>
          ${recentHistory.length > 0 ? `
            <ul style="list-style:none; padding:0; margin:0; font-size:0.85rem;">
              ${recentHistory.map(h => `
                <li style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed rgba(255,255,255,0.1);">
                  <span>${new Date(h.createdAt).toLocaleDateString()} - ${escapeHtml(h.note || 'Операция')}</span>
                  <strong style="color:${h.delta >= 0 ? 'var(--success)' : 'var(--danger)'}">${h.delta >= 0 ? '+' : ''}${h.delta}</strong>
                </li>
              `).join('')}
            </ul>
          ` : '<p class="muted">История пуста.</p>'}
        </div>
        
        <!-- НОВЫЙ БЛОК СИНХРОНИЗАЦИИ -->
        ${syncBlock}

      </div>
      
      <!-- ФИКСИРОВАННАЯ НИЖНЯЯ ЧАСТЬ С КНОПКАМИ -->
      <div style="flex-shrink: 0; display:flex; gap:10px; justify-content:flex-end; border-top:1px solid var(--border); padding-top:15px; background: var(--panel); position: sticky; bottom: 0; z-index: 10;">
         <button id="btn-close-profile" class="btn ghost">Закрыть</button>
         <button id="btn-edit-from-profile" class="btn primary">✏️ Редактировать</button>
         <button id="btn-delete-from-profile" class="btn danger">🗑 Удалить</button>
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
           import('../state.js').then(({ state }) => {
             import('../storage.js').then(({ persist }) => {
               state.characters = state.characters.filter(c => c.id !== char.id);
               persist().then(() => {
                 closeModal();
                 import('../characters.js').then(mod => mod.renderCharacters());
                 import('../parties.js').then(mod => mod.renderParties());
                 toast('Персонаж удален', 'success');
               });
             });
           });
        }
      };
    }

    // NEW: Sync Helper Button
    const syncBtn = document.getElementById('btn-open-sync-helper');
    if(syncBtn) {
      syncBtn.onclick = () => {
        openSyncHelper(char.id); // <-- Новое имя
      };
    }

  }, 100);
}
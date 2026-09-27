// js/syncManager.js

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { showModal, toast } from './ui.js';

/**
 * Открывает помощник для ручного ввода данных после авторизации во внешнем браузере
 */
export function openSyncHelper(characterId) {
  const char = state.characters.find(c => c.id === characterId);
  if (!char) return;

  const email = char.contacts?.email || '';
  const password = char.contacts?.password || '';

  const content = `
    <div class="sync-helper-container">
      <h3>Синхронизация: ${escapeHtml(char.nick)}</h3>
      
      <div style="background:var(--panel-2); padding:15px; border-radius:8px; margin-bottom:15px;">
        <p><strong>Шаг 1: Скопируйте данные для входа</strong></p>
        
        <div style="margin-top:10px;">
          <label>Email / Логин:</label>
          <div style="display:flex; gap:5px;">
            <input type="text" id="helper-email" value="${escapeHtml(email)}" readonly style="flex-grow:1;" />
            <button class="btn primary small" onclick="copyToClipboard('helper-email')">📋 Копировать</button>
          </div>
        </div>
        
        <div style="margin-top:10px;">
          <label>Пароль:</label>
          <div style="display:flex; gap:5px;">
            <input type="password" id="helper-pass" value="${escapeHtml(password)}" readonly style="flex-grow:1;" />
            <button class="btn warning small" onclick="copyToClipboard('helper-pass')">📋 Копировать</button>
          </div>
        </div>
      </div>

      <div style="background:rgba(122, 162, 247, 0.1); padding:15px; border-radius:8px; margin-bottom:15px;">
        <p><strong>Шаг 2: Войдите на сайт</strong></p>
        <p class="muted" style="font-size:0.9rem;">Нажмите кнопку ниже. Вставьте скопированные данные в форму входа VK Play.</p>
        
        <button id="btn-open-site" class="btn large full-width" style="margin-top:10px; background:var(--accent); color:white;">
          🌐 Открыть pwonline.ru в браузере
        </button>
      </div>

      <div style="background:rgba(255, 215, 0, 0.1); padding:15px; border-radius:8px;">
        <p><strong>Шаг 3: Обновите баланс вручную</strong></p>
        <p class="muted" style="font-size:0.9rem;">
          После входа перейдите на страницу монет (<code>chests2.php</code>).<br/>
          Скопируйте новый баланс и вернитесь сюда, чтобы сохранить его.
        </p>
        
        <div style="margin-top:10px;">
           <label>Новый баланс древних монет:</label>
           <div style="display:flex; gap:5px;">
              <input type="number" id="new-balance-input" placeholder="Например: 5500" style="flex-grow:1;" />
              <button id="btn-save-balance" class="btn success small">💾 Сохранить</button>
           </div>
        </div>
      </div>
    </div>
  `;

  showModal({
    title: 'Помощник синхронизации PW',
    content,
    submitText: null, // Нет кнопки сабмита внизу
    cancelText: 'Закрыть',
    onSubmit: () => true,
    onClose: () => {}
  });

  // Привязка событий
  setTimeout(() => {
    // 1. Функция копирования (глобальная для inline onclick)
    window.copyToClipboard = async (elementId) => {
      const el = document.getElementById(elementId);
      if (el && el.value) {
        try {
          await navigator.clipboard.writeText(el.value);
          toast('Скопировано!', 'success');
        } catch (err) {
          console.error(err);
          toast('Ошибка копирования', 'error');
        }
      }
    };

    // 2. Открытие сайта
    const openSiteBtn = document.getElementById('btn-open-site');
    if (openSiteBtn) {
      openSiteBtn.onclick = async () => {
        try {
          // Используем invoke для вызова команды shell open, 
          // которая точно настроена в нашем lib.rs
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('plugin:shell|open', { path: 'https://pwonline.ru/' });
          toast('Открываю браузер...', 'info');
        } catch (e) {
          console.error(e);
          // Fallback: обычный window.open
          window.open('https://pwonline.ru/', '_blank');
        }
      };
    }

    // 3. Сохранение баланса
    const saveBalanceBtn = document.getElementById('btn-save-balance');
    if (saveBalanceBtn) {
      saveBalanceBtn.onclick = () => {
        const inputEl = document.getElementById('new-balance-input');
        const newVal = parseInt(inputEl?.value, 10);
        
        if (isNaN(newVal)) {
          toast('Введите корректное число', 'error');
          return;
        }

        const oldVal = char.ancientCoins;
        if (newVal !== oldVal) {
          char.ancientCoins = newVal;
          
          // Добавляем запись в историю
          const historyEntry = {
            id: crypto.randomUUID(),
            date: new Date().toISOString(),
            delta: newVal - oldVal,
            note: 'Ручная синхронизация',
            balanceAfter: newVal
          };
          char.coinHistory = [historyEntry, ...(char.coinHistory || [])];
          
          // Сохраняем в стейт
          import('./storage.js').then(({ persist }) => {
            persist().then(() => {
              toast(`Баланс обновлен до ${newVal}`, 'success');
              // Обновляем UI
              import('./characters.js').then(mod => mod.renderCharacters());
              // Закрываем модалку
              const root = document.getElementById('modal-root');
              if(root) root.innerHTML = '';
            });
          });
        } else {
          toast('Баланс не изменился', 'info');
        }
      };
    }
  }, 100);
}
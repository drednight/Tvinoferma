// js/core/ui.js

import { escapeHtml } from './utils.js';

/**
 * Универсальная функция показа модального окна
 * @param {{ title: string, content: string, submitText?: string, cancelText?: string,
 *           onSubmit?: (data: any) => any, onClose?: () => void, hideCloseButton?: boolean }} opts
 */
export function showModal({ 
  title, 
  content, 
  submitText = 'OK', 
  cancelText = 'Cancel', 
  onSubmit, 
  onClose,
  hideCloseButton = false // Игнорируется, крестик удален
}) {
  const root = document.getElementById('modal-root');
  if (!root) return;

  // ОЧИСТКА ПРЕДЫДУЩЕЙ МОДАЛКИ
  root.innerHTML = ''; 

  // Создаем оверлей
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  
  // Создаем контейнер окна
  const container = document.createElement('div');
  container.className = 'modal-container';
  
  // Шапка (БЕЗ КРЕСТИКА)
  const header = document.createElement('div');
  header.className = 'modal-header';
  
  header.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
  `;
  
  // Тело
  const body = document.createElement('div');
  body.className = 'modal-body';
  body.innerHTML = content;

  // ФУТЕР
  let footer = null;
  
  const hasSubmit = submitText !== null && submitText !== false && submitText !== undefined;
  const hasCancel = cancelText !== null && cancelText !== false && cancelText !== undefined;

  if (hasSubmit || hasCancel) {
    footer = document.createElement('div');
    footer.className = 'modal-footer';
    
    // Кнопка Отмены
    if (hasCancel) {
      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn ghost';
      btnCancel.textContent = String(cancelText);
      btnCancel.onclick = () => {
        if (typeof onClose === 'function') onClose();
        closeModal();
      };
      footer.appendChild(btnCancel);
    }

    // Кнопка Саубмита
    if (hasSubmit) {
      const btnSubmit = document.createElement('button');
      btnSubmit.className = 'btn primary';
      btnSubmit.textContent = String(submitText);
      
      btnSubmit.onclick = async () => {
        try {
          const formElement = body.querySelector('form') || body;
          
          let formData;
          if (formElement.tagName === 'FORM') {
             formData = new FormData(formElement);
          } else {
             formData = new FormData();
             const inputs = formElement.querySelectorAll('input[name], select[name], textarea[name]');
             inputs.forEach(input => {
               if (input.type === 'checkbox' && !input.checked) return;
               if (input.type === 'radio' && !input.checked) return;
               formData.append(input.name, input.value);
             });
          }

          const result = await onSubmit(formData, { 
            setError: (msg) => {
              console.error(msg);
              alert(msg); 
            } 
          });
          
          if (result !== false) {
            closeModal();
          }
        } catch (err) {
          console.error('[MODAL SUBMIT ERROR]', err);
          alert(`Ошибка при отправке формы: ${err.message}`);
        }
      };
      footer.appendChild(btnSubmit);
    }
  }

  // Сборка DOM
  container.appendChild(header);
  container.appendChild(body);
  if (footer) container.appendChild(footer); 
  
  overlay.appendChild(container);
  root.appendChild(overlay);

  // ВАЖНО: Запрет выхода по клику на фон убран.
  // Теперь окно можно закрыть ТОЛЬКО через кнопки или Esc.

  // Добавляем поддержку закрытия по клавише Escape
  const handleEsc = (e) => {
    if (e.key === 'Escape') {
       if (typeof onClose === 'function') onClose();
       closeModal();
       document.removeEventListener('keydown', handleEsc); // Удаляем слушатель после закрытия
    }
  };
  document.addEventListener('keydown', handleEsc);
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) {
    root.innerHTML = '';
  }
}

export function toast(message, type = 'info', durationMs = 3000) {
  const root = document.getElementById('toast-root');
  if (!root) return;

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  
  root.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add('show');
  });

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, durationMs);
}

/**
 * Подтверждение в стиле приложения (вместо системного окна «Сообщение с localhost»).
 * Не трогает уже открытые окна. Возвращает Promise<boolean>; Esc и клик по фону — «Отмена».
 * @param {{ title: string, text: string, okText?: string, cancelText?: string, danger?: boolean }} opts
 */
export function confirmModal({ title, text, okText = 'OK', cancelText = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay tf-confirm-overlay';
    overlay.innerHTML = `
      <div class="modal-container tf-confirm" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-header"><h3>${escapeHtml(title)}</h3></div>
        <div class="modal-body"><p style="margin:0; line-height:1.5;">${escapeHtml(text)}</p></div>
        <div class="modal-footer">
          <button type="button" class="btn ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${escapeHtml(okText)}</button>
        </div>
      </div>`;
    const done = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      done(false);
    };
    overlay.addEventListener('click', (e) => {
      const act = /** @type {HTMLElement} */ (e.target).closest?.('[data-act]')?.getAttribute('data-act');
      if (act === 'ok') done(true);
      else if (act === 'cancel' || e.target === overlay) done(false);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    /** @type {HTMLElement | null} */ (overlay.querySelector('[data-act="ok"]'))?.focus();
  });
}

/**
 * Строка подтверждения в стиле приложения. Все подтверждения идут через `confirmModal`:
 * системные окна `alert`/`confirm` выглядят чужеродно и не подчиняются теме приложения.
 * Функция оставлена только как напоминание — использовать её не нужно.
 * @deprecated используйте confirmModal
 */
export function confirmDialog() {
  throw new Error('confirmDialog удалён: используйте confirmModal из core/ui.js');
}
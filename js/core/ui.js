// js/core/ui.js

import { escapeHtml } from './utils.js';

/**
 * Универсальная функция показа модального окна
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

export function toast(message, type = 'info') {
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
  }, 3000);
}

export function confirmDialog(message) {
  return window.confirm(message);
}
// js/modules/marathons/overlay.js
// Лёгкое модальное окно для мастера марафона и карточки ячейки (без жёсткой формы showModal).

import { escapeHtml } from '../../core/utils.js';
import { registerModal, isTopModal } from '../../core/modalLifecycle.js';

export function openOverlay({ title = '', wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root') || document.body;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay tf-overlay';
  overlay.innerHTML = `
    <div class="modal-container tf-dialog ${wide ? 'tf-wide' : ''}">
      <div class="modal-header tf-dialog-head">
        <h3 class="tf-dialog-title">${escapeHtml(title)}</h3>
        <button type="button" class="icon-btn tf-close" title="Закрыть">✕</button>
      </div>
      <div class="tf-dialog-sub"></div>
      <div class="modal-body tf-dialog-body"></div>
      <div class="modal-footer tf-dialog-foot"></div>
    </div>`;
  root.appendChild(overlay);

  let closed = false;
  const api = {
    el: overlay,
    sub: overlay.querySelector('.tf-dialog-sub'),
    body: overlay.querySelector('.tf-dialog-body'),
    foot: overlay.querySelector('.tf-dialog-foot'),
    setTitle(t) { overlay.querySelector('.tf-dialog-title').textContent = t; },
    close() {
      if (closed) return;
      closed = true;
      unregister();
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      onClose?.();
    }
  };
  const onKey = (e) => { if (e.key === 'Escape' && isTopModal(overlay)) api.close(); };
  const unregister = registerModal(overlay, () => api.close());
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.tf-close').onclick = () => api.close();
  return api;
}

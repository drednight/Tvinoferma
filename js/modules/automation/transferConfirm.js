import { openOverlay } from '../marathons/overlay.js';
import { confirmModal } from '../../core/ui.js';
import { loadLimits, clearLimits } from './transferStore.js';

// The acknowledgement is per launch, never a remembered checkbox in the sidebar.
export function confirmTransfer({ parent, plansFor, signal }) {
  return new Promise(resolve => {
    let result = null;
    const wasInert = !!parent.inert;
    const focus = document.activeElement;
    parent.inert = true;
    let dlg;
    const abort = () => dlg?.close();
    dlg = openOverlay({
      title: 'Подтвердить передачу',
      onClose() {
        signal?.removeEventListener('abort', abort);
        parent.inert = wasInert;
        if (parent.isConnected && focus?.isConnected) focus.focus();
        resolve(result);
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    dlg.el.querySelector('.modal-container').classList.add('tr-confirm-dialog');
    dlg.body.innerHTML = `<div class="tr-confirm-controls">
      <label class="tr-ack"><input type="checkbox" id="tr-ack"><span>⚠ Понимаю, что передача необратима: предметы уйдут в игру и вернуть их нельзя.</span></label>
      <label class="tr-force"><input type="checkbox" id="tr-force"><span><b>Обойти ограничения приложения</b> и попытаться передать выбранные предметы на указанных персонажей: запомненные ограничения («только на другой сервер») не применяются. Ограничения самого сайта (например, «награды можно перевести после 20:00…») это не отменяет: сайт может отклонить передачу.</span></label>
      <button type="button" class="btn ghost small" id="tr-forget"></button>
      <p data-confirm-summary role="status"></p></div>`;
    dlg.foot.innerHTML =
      '<button type="button" class="btn ghost" data-confirm-cancel>Отмена</button><button type="button" class="btn danger" data-confirm-transfer disabled>Передать</button>';
    const update = () => {
      const plans = plansFor(dlg.body.querySelector('#tr-force').checked).filter(plan => plan.run);
      const items = plans.flatMap(plan => plan.itemSelection || []);
      dlg.body.querySelector('[data-confirm-summary]').textContent =
        `Аккаунтов: ${plans.length}. Наборов: ${items.length}. Перед отправкой сайт проверяется заново.`;
      dlg.foot.querySelector('[data-confirm-transfer]').disabled =
        !dlg.body.querySelector('#tr-ack').checked || !items.length;
      const n = Object.keys(loadLimits()).length;
      const forget = dlg.body.querySelector('#tr-forget');
      forget.textContent = n ? `🧹 Забыть запомненные ограничения (${n})` : '🧹 Запомненных ограничений нет';
      forget.disabled = !n;
    };
    dlg.body.addEventListener('change', update);
    dlg.body.querySelector('#tr-forget').onclick = async () => {
      if (
        await confirmModal({
          title: 'Забыть запомненные ограничения?',
          text: 'Это очистит только запомненные отказы по серверам. Ограничения сайта сохранятся; приложение запомнит новые отказы заново.',
          okText: 'Забыть',
          danger: true
        })
      )
        clearLimits();
      if (dlg.el.isConnected) update();
    };
    dlg.foot.querySelector('[data-confirm-cancel]').onclick = () => dlg.close();
    dlg.foot.querySelector('[data-confirm-transfer]').onclick = () => {
      if (dlg.foot.querySelector('[data-confirm-transfer]').disabled) return;
      const force = dlg.body.querySelector('#tr-force').checked;
      result = { force, plans: plansFor(force) };
      dlg.close();
    };
    update();
  });
}

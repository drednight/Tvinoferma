import { showModal } from '../../core/ui.js';
import { BACKGROUND_METHODS } from './background.js';
import { escapeHtml as esc } from '../../core/utils.js';
const messages = {
  6: 'WM_ACTIVATE',
  28: 'WM_ACTIVATEAPP',
  7: 'WM_SETFOCUS',
  8: 'WM_KILLFOCUS',
  256: 'WM_KEYDOWN',
  257: 'WM_KEYUP',
  260: 'WM_SYSKEYDOWN',
  261: 'WM_SYSKEYUP'
};
export function receiverReport(report) {
  return JSON.stringify(
    {
      scope: 'own-window-only',
      open: report.open,
      total: report.total,
      gameAccepted: 'unknown',
      delivery: report.delivery,
      events: (report.events || []).map(event => ({ ...event, messageName: messages[event.message] || 'unknown' }))
    },
    null,
    2
  );
}
export function openReceiverTools(control) {
  let pending = false;
  const modal = showModal({
    title: 'Окно-приёмник Windows — не игра',
    wide: true,
    submitText: null,
    cancelText: 'Закрыть',
    beforeClose: () => !pending,
    content: `<div class="gm-dialog"><p>Создаёт отдельное нативное окно нашего процесса. Записывает только поступившие ему сообщения и состояние foreground в этот момент: нет глобального перехвата, доступа к игре и записи текста. Физические клавиши, нажатые в самом приёмнике, тоже видны как VK; не вводите там секреты. Успех здесь не доказывает работу в PW.</p><div class="gm-journal-actions"><button class="btn" data-receiver-open>Открыть окно</button><button class="btn" data-receiver-read>Обновить отчёт</button><button class="btn ghost" data-receiver-clear>Очистить сообщения</button><button class="btn ghost" data-receiver-close>Закрыть окно-приёмник</button></div><label>Клавиша<select data-receiver-key><option>B</option><option>F8</option><option>SHIFT+1</option></select></label><label>Один способ<select data-receiver-method>${Object.entries(
      BACKGROUND_METHODS
    )
      .map(([method, label]) => `<option value="${method}">${esc(label)}</option>`)
      .join(
        ''
      )}</select></label><label><input type="checkbox" data-receiver-consent> Разрешаю одно тестовое сочетание только нашему окну</label><button class="btn primary" data-receiver-send disabled>Отправить один раз в приёмник</button><p role="status" data-receiver-status>Окно открывается без принудительного захвата фокуса. Для неактивного теста оставьте его на фоне и работайте из основного окна Твинофермы. Повтор должен быть выключен.</p><textarea class="input" rows="15" readonly aria-label="Сообщения окна-приёмника"></textarea><p>PostMessage/Notify могут обработаться позже ответа отправителя: нажмите «Обновить отчёт». Порядок строк показывает порядок получения, а не подтверждение обработки игрой. Поле foreground относится к моменту получения сообщения.</p></div>`
  });
  if (!modal) return;
  const q = name => modal.querySelector(`[data-receiver-${name}]`),
    status = q('status'),
    output = modal.querySelector('textarea');
  const invalidate = () => {
    q('consent').checked = false;
    q('send').disabled = true;
  };
  q('key').onchange = invalidate;
  q('method').onchange = invalidate;
  q('consent').onchange = () => {
    q('send').disabled = !q('consent').checked;
  };
  for (const operation of ['open', 'read', 'clear', 'close', 'send'])
    q(operation).onclick = async () => {
      if (pending || (operation === 'send' && !q('consent').checked)) return;
      pending = true;
      modal.querySelectorAll('button,select,input').forEach(node => {
        node.disabled = true;
      });
      status.textContent = 'Ожидаем Windows…';
      try {
        const report = await control(operation, q('key').value, q('method').value);
        output.value = receiverReport(report);
        status.textContent =
          operation === 'send'
            ? 'Запрос завершён. Сравните delivery с полученными сообщениями. Для асинхронного способа обновите отчёт отдельно; автоматического повторения нет.'
            : 'Готово. Это только собственное окно, не проверка PW.';
      } catch (error) {
        status.textContent = error.message || 'Операция не выполнена. Автоматического повтора нет.';
      } finally {
        pending = false;
        modal.querySelectorAll('button,select,input').forEach(node => {
          node.disabled = false;
        });
        invalidate();
      }
    };
}

import { chord } from './keySyntax.js';
import { openOverlay } from '../marathons/overlay.js';
import { keyboardButton } from './keyboardPicker.js';
import { appendBackgroundJournal, openBackgroundJournal } from './backgroundJournal.js';
import { escapeHtml } from '../../core/utils.js';
export const COMPARISON_METHODS = {
  'active-send': 'A · Активное окно + SendInput',
  'active-post': 'B · Активное окно + PostMessage',
  'inactive-post': 'C · Неактивное окно + PostMessage',
  'inactive-activity-window': 'D · Неактивное окно + WM_ACTIVATE',
  'inactive-activity-notify': 'E · Неактивное окно + activity-notify'
};
export function validateComparison({ charId, key, method }, state) {
  const token = chord(key);
  if (!state.characters.some(c => c.id === charId)) throw new Error('Выберите актуального персонажа.');
  if (!Object.hasOwn(COMPARISON_METHODS, method)) throw new Error('Выберите один метод сравнения.');
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(token))
    throw new Error('Только одна буква, цифра или F1–F24, без модификаторов.');
  return { charId, key: token, method };
}
export function openInputComparison({ state, run, stop }) {
  let pending = false,
    closed = false,
    last = null;
  const ov = openOverlay({
    title: 'Сравнение путей ввода — один клиент',
    wide: true,
    onClose: () => {
      closed = true;
      if (pending) stop();
    }
  });
  ov.body.innerHTML = `<p>Сначала вручную проверьте физическую клавишу в игре. Затем запускайте по одному опыту с той же клавишей. Автоматического перебора, возврата фокуса и повтора нет. Для A/B вручную активируйте получателя во время отсчёта; для C–E оставьте его видимым и неактивным. В неактивное окно SendInput не отправляется.</p><fieldset data-fields><label>Один персонаж<select data-char><option value="">Выберите</option>${state.characters.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.nick)}</option>`).join('')}</select></label><label>Одна безопасная клавиша<input class="input" data-key placeholder="Например B или F8"></label><label>Опыт<select data-method>${Object.entries(
    COMPARISON_METHODS
  )
    .map(([id, name]) => `<option value="${id}">${name}</option>`)
    .join(
      ''
    )}</select></label><label>Физическая клавиша в игре<select data-physical><option value="unknown">Ещё не проверил</option><option value="worked">Сработала</option><option value="failed">Не сработала</option></select></label><label>Условия окна<select data-condition><option value="visible">Видимо, не свёрнуто</option><option value="covered">Перекрыто другим окном</option><option value="minimized">Свёрнуто (тест будет отклонён)</option></select></label><label><input type="checkbox" data-consent> Разрешаю одно нерасходное нажатие; чат закрыт, клавиша не запускает покупку/удаление/другое опасное действие</label></fieldset><p><button class="btn primary" data-run>Начать отсчёт 5 секунд</button><button class="btn danger" data-stop disabled>Остановить</button></p><p role="status" data-status>Повтор должен быть выключен. Все результаты попадут в отдельный журнал, включая наблюдение пользователя.</p><pre data-result></pre><fieldset data-observation disabled><label>Фактический результат в игре<select data-verdict><option value="unknown">Не проверено</option><option value="worked">Сработало</option><option value="failed">Не сработало</option><option value="unexpected">Побочное действие / другой результат</option></select></label><button class="btn" data-save>Сохранить наблюдение этой попытки</button></fieldset>`;
  const q = s => ov.body.querySelector(`[data-${s}]`);
  q('key').after(keyboardButton(q('key')));
  q('run').onclick = async () => {
    if (pending) return;
    try {
      const selection = validateComparison(
        { charId: q('char').value, key: q('key').value, method: q('method').value },
        state
      );
      if (!q('consent').checked || q('physical').value !== 'worked')
        throw new Error('Сначала проверьте физическую клавишу и подтвердите безопасное действие.');
      pending = true;
      last = null;
      q('fields').disabled = true;
      q('observation').disabled = true;
      q('run').disabled = true;
      q('stop').disabled = false;
      const context = { physical: q('physical').value, windowMode: q('condition').value };
      const result = await run(selection, left => {
        if (!closed)
          q('status').textContent =
            `До одного нажатия: ${left} с. ${selection.method.startsWith('active-') ? 'Вручную активируйте выбранное игровое окно.' : 'Оставьте выбранную игру неактивной.'}`;
      });
      last = { ...selection, runId: result.runId, ...context };
      appendBackgroundJournal('comparison-conditions', last);
      if (!closed) {
        q('result').textContent = JSON.stringify(result, null, 2);
        q('status').textContent = result.refused
          ? 'Опыт отклонён до отправки: условия окна не выполнены. Подробности ниже.'
          : result.ok
            ? 'Техническая отправка завершена. Это не подтверждает действие игры. Отметьте наблюдение ниже.'
            : 'Отправка не подтверждена или прервана; часть ввода могла быть доставлена. Подробности ниже.';
        q('observation').disabled = false;
      }
    } catch (error) {
      if (!closed) q('status').textContent = error.message || 'Проверка не завершена.';
    } finally {
      pending = false;
      if (!closed) {
        q('fields').disabled = false;
        q('run').disabled = false;
        q('stop').disabled = true;
        q('consent').checked = false;
      }
    }
  };
  q('stop').onclick = () => {
    stop();
    q('status').textContent = 'Остановка запрошена; отправленный ввод отменить нельзя.';
  };
  q('save').onclick = () => {
    if (!last) return;
    appendBackgroundJournal('comparison-user-observation', { ...last, status: q('verdict').value });
    q('status').textContent =
      'Наблюдение сохранено в журнале. Это ручная отметка, не автоматическое определение реакции игры.';
  };
  ov.foot.innerHTML =
    '<button class="btn" data-log>Открыть журнал</button><button class="btn" data-close>Закрыть</button>';
  ov.foot.querySelector('[data-log]').onclick = openBackgroundJournal;
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  return ov;
}

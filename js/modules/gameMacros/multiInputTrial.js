import { chord, steps } from './keySyntax.js';
import { openOverlay } from '../marathons/overlay.js';
import { appendBackgroundJournal, openBackgroundJournal } from './backgroundJournal.js';
import { escapeHtml as esc } from '../../core/utils.js';
export function validateMultiTrial(selection, state) {
  const charIds = [...new Set(selection.charIds || [])];
  if (charIds.length < 2 || charIds.length > 4 || charIds.some(id => !state.characters.some(c => c.id === id)))
    throw new Error('Выберите от 2 до 4 разных актуальных персонажей.');
  const plan = steps(selection.sequence);
  let duration = 0,
    keys = 0;
  for (const row of plan) {
    if (row.wait) {
      if (row.wait > 1500) throw new Error('Пауза — от 50 до 1500 мс.');
      duration += row.wait;
    } else {
      if (!/^(?:(?:CTRL|SHIFT)\+){0,2}(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(chord(row.key)))
        throw new Error('Буквы, цифры, F1–F24; только Ctrl/Shift. Без Alt, Win и служебных клавиш.');
      keys++;
      duration += 30;
    }
  }
  if (!keys || keys > 10 || duration > 10000) throw new Error('Нужно 1–10 нажатий, длительность до 10 секунд.');
  return { charIds, steps: plan, method: 'inactive-activity-notify' };
}
export function openMultiInputTrial({ state, run, stop }) {
  let pending = false,
    closed = false,
    last = null;
  const ov = openOverlay({
    title: 'Несколько окон · последовательность E',
    wide: true,
    onClose: () => {
      closed = true;
      if (pending) stop();
    }
  });
  ov.body.innerHTML = `<p>Одна попытка параллельно на 2–4 клиентах методом E (activity-notify). Общий старт, но без гарантии точной синхронности. Все игровые окна должны быть неактивны, видимы и не свёрнуты. Фокус вручную переведите в пустой Блокнот. Нет SendInput, переключения фокуса, циклов или повторного запуска.</p><fieldset data-fields><legend>Получатели</legend>${state.characters.map(c => `<label class="switch-row"><input type="checkbox" data-char value="${esc(c.id)}">${esc(c.nick)}</label>`).join('')}<label>Последовательность — одна клавиша/сочетание или wait N на строку<textarea class="input" data-sequence rows="7" placeholder="B&#10;wait 500&#10;C"></textarea></label><p class="muted">До 10 нажатий и 20 строк, паузы 50–1500 мс, всего до 10 с. Ctrl/Shift допускаются только после ручной проверки. Каждое сочетание нажимается и отпускается отдельно; удержания между строками нет.</p><label class="switch-row"><input type="checkbox" data-consent> Проверил все клавиши и сочетания вручную на каждом клиенте; чат закрыт, действия безопасны и не расходуют предметы.</label></fieldset><p><button class="btn primary" data-run>Запустить через 5 секунд</button><button class="btn danger" data-stop disabled>Остановить</button><button class="btn" data-log>Журнал</button></p><p role="status" data-status>Повторы должны быть выключены. Ошибка одного клиента останавливает дальнейшие шаги остальных; уже отправленный ввод отменить нельзя.</p><pre data-result></pre><fieldset data-observations disabled><legend>Наблюдения после попытки</legend><div data-verdicts></div><label class="switch-row"><input type="checkbox" data-focus>Заметил смену фокуса</label><label class="switch-row"><input type="checkbox" data-leak>Был ввод в Блокноте или другом приложении</label><button class="btn" data-save>Сохранить наблюдения</button></fieldset>`;
  const q = name => ov.body.querySelector(`[data-${name}]`);
  q('run').onclick = async () => {
    if (pending) return;
    try {
      const selection = validateMultiTrial(
        {
          charIds: [...ov.body.querySelectorAll('[data-char]:checked')].map(n => n.value),
          sequence: q('sequence').value
        },
        state
      );
      if (!q('consent').checked) throw new Error('Подтвердите ручную проверку всех действий на каждом клиенте.');
      pending = true;
      last = null;
      q('fields').disabled = true;
      q('run').disabled = true;
      q('stop').disabled = false;
      q('observations').disabled = true;
      q('result').textContent = '';
      const result = await run(selection, left => {
        if (!closed)
          q('status').textContent = left
            ? `До общего запуска: ${left} с. Оставьте все выбранные игры неактивными, отпустите клавиши и мышь.`
            : 'Выполняется последовательность. Не меняйте фокус; можно запросить остановку.';
      });
      if (closed) return;
      last = { runId: result.runId, charIds: selection.charIds };
      q('result').textContent = JSON.stringify(result, null, 2);
      q('status').textContent = result.ok
        ? 'Отправка завершена. Проверьте каждый клиент: это не подтверждение реакции игры.'
        : 'Опыт прерван/отклонён. Часть шагов могла выполниться; проверьте каждый клиент.';
      q('verdicts').innerHTML = selection.charIds
        .map(
          id =>
            `<label>${esc(state.characters.find(c => c.id === id)?.nick || id)}<select data-verdict="${esc(id)}"><option value="unknown">Не проверено</option><option value="worked">Все шаги сработали в нужном порядке</option><option value="failed">Не сработало / пропущены шаги</option><option value="unexpected">Побочное действие / неверный порядок</option></select></label>`
        )
        .join('');
      q('focus').checked = false;
      q('leak').checked = false;
      q('observations').disabled = false;
    } catch (error) {
      if (!closed) q('status').textContent = error.message || 'Опыт не завершён.';
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
    q('status').textContent = 'Остановка запрошена. Ожидайте завершения очистки; уже отправленный ввод не отменяется.';
  };
  q('save').onclick = () => {
    if (!last) return;
    for (const node of ov.body.querySelectorAll('[data-verdict]'))
      appendBackgroundJournal('multi-user-observation', {
        runId: last.runId,
        charId: node.dataset.verdict,
        status: node.value,
        foregroundChanged: q('focus').checked,
        leak: q('leak').checked
      });
    q('status').textContent =
      'Наблюдения добавлены в журнал. При предупреждении хранилища скачайте журнал до закрытия.';
  };
  q('log').onclick = openBackgroundJournal;
  ov.foot.innerHTML = '<button class="btn" data-close>Закрыть</button>';
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  return ov;
}

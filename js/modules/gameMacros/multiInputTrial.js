import { chord, steps } from './keySyntax.js';
import { openOverlay } from '../marathons/overlay.js';
import { appendBackgroundJournal, openBackgroundJournal } from './backgroundJournal.js';
import { escapeHtml as esc } from '../../core/utils.js';
export function validateMultiTrial(selection, state) {
  const charIds = [...new Set(selection.charIds || [])];
  if (charIds.length < 1 || charIds.length > 4 || charIds.some(id => !state.characters.some(c => c.id === id)))
    throw new Error('Выберите от 1 до 4 разных актуальных персонажей.');
  const timing = {
    timeoutMs: Number(selection.timing?.timeoutMs ?? 25),
    modifierGapMs: Number(selection.timing?.modifierGapMs ?? 0)
  };
  if (![25, 100, 250].includes(timing.timeoutMs) || ![0, 50, 100, 200].includes(timing.modifierGapMs))
    throw new Error('Выберите ожидание 25/100/250 мс и паузу модификатора 0/50/100/200 мс.');
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
      duration += 30 + (row.key.includes('+') ? timing.modifierGapMs : 0);
    }
  }
  if (!keys || keys > 10 || duration > 10000) throw new Error('Нужно 1–10 нажатий, длительность до 10 секунд.');
  return { charIds, steps: plan, timing, method: 'inactive-activity-notify' };
}
export function trialOutcome(result) {
  const reports = (result.recipients || []).flatMap(r => [r, ...(r.steps || []).map(s => s.details || {})]);
  const has = field => !!result[field] || reports.some(r => r[field]);
  if (has('releaseUnconfirmed'))
    return 'Отпускание клавиши/модификатора не подтверждено. Дальнейшие шаги остановлены; проверьте состояние игры. Автоповтора нет.';
  if (has('timedOut') || has('deliveryUncertain'))
    return 'Доставка неопределённа: тайм-аут или неполный отчёт. Действие могло выполниться. Автоповтора нет.';
  return result.ok
    ? 'Вызовы отправки завершены. Это не подтверждение реакции игры — сохраните наблюдение.'
    : 'Опыт прерван/отклонён. Часть шагов могла выполниться; проверьте каждый клиент.';
}
export function openMultiInputTrial({ state, run, stop }) {
  let pending = false,
    closed = false,
    last = null;
  const ov = openOverlay({
    title: 'Клавиши и сочетания E · 1–4 окна',
    wide: true,
    onClose: () => {
      closed = true;
      if (pending) stop();
    }
  });
  ov.body.innerHTML = `<p>Одна попытка на 1–4 клиентах (при нескольких — параллельно) методом E (activity-notify). Общий старт, но без гарантии точной синхронности. Все игровые окна должны быть неактивны, видимы и не свёрнуты. Фокус вручную переведите в пустой Блокнот. Нет SendInput, переключения фокуса, циклов или повторного запуска.</p><p class="gm-trial-error" role="alert" data-error hidden></p><fieldset data-fields><legend>Получатели</legend>${state.characters.map(c => `<label class="switch-row"><input type="checkbox" data-char value="${esc(c.id)}">${esc(c.nick)}</label>`).join('')}<div class="gm-profile-controls"><label>Ожидание обработки сообщения<select data-timeout><option value="25">25 мс · исходное</option><option value="100">100 мс</option><option value="250">250 мс</option></select></label><label>Пауза после Ctrl/Shift перед основной клавишей<select data-gap><option value="0">0 мс · исходное</option><option value="50">50 мс</option><option value="100">100 мс</option><option value="200">200 мс</option></select></label></div><p class="muted">Меняйте один параметр за раз. Ожидание — предел одного синхронного вызова, а не гарантированная доставка. Пауза применяется один раз после всех модификаторов. Увеличение задержек не гарантирует распознавание сочетания.</p><label>Последовательность — одна клавиша/сочетание или wait N на строку<textarea class="input" data-sequence rows="7" placeholder="B&#10;wait 500&#10;C"></textarea></label><p class="muted">До 10 нажатий и 20 строк, паузы 50–1500 мс, всего до 10 с. Ctrl/Shift допускаются только после ручной проверки. Каждое сочетание нажимается и отпускается отдельно; удержания между строками нет.</p><label class="switch-row"><input type="checkbox" data-consent> Проверил все клавиши и сочетания вручную на каждом клиенте; чат закрыт, действия безопасны и не расходуют предметы.</label></fieldset><p><button type="button" class="btn primary" data-run>Запустить через 5 секунд</button><button type="button" class="btn danger" data-stop disabled>Остановить</button><button type="button" class="btn" data-log>Журнал</button></p><p role="status" data-status>Повторы должны быть выключены. Ошибка одного клиента останавливает дальнейшие шаги остальных; уже отправленный ввод отменить нельзя.</p><div data-summary aria-live="polite"></div><details><summary>Технический отчёт</summary><pre data-result></pre></details><fieldset data-observations disabled><legend>Наблюдения после попытки</legend><div data-verdicts></div><label class="switch-row"><input type="checkbox" data-focus>Заметил смену фокуса</label><label class="switch-row"><input type="checkbox" data-leak>Был ввод в Блокноте или другом приложении</label><button type="button" class="btn" data-save>Сохранить наблюдения</button></fieldset>`;
  const q = name => ov.body.querySelector(`[data-${name}]`);
  q('run').onclick = async event => {
    event.preventDefault();
    let armed = false;
    if (pending) return;
    q('error').hidden = true;
    try {
      const selection = validateMultiTrial(
        {
          charIds: [...ov.body.querySelectorAll('[data-char]:checked')].map(n => n.value),
          sequence: q('sequence').value,
          timing: { timeoutMs: q('timeout').value, modifierGapMs: q('gap').value }
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
      q('summary').textContent = '';
      q('status').textContent = 'Проверяю выбранные игровые окна перед отсчётом…';
      const result = await run(selection, left => {
        armed = true;
        if (!closed)
          q('status').textContent = left
            ? `До общего запуска: ${left} с. Оставьте все выбранные игры неактивными, отпустите клавиши и мышь.`
            : 'Выполняется последовательность. Не меняйте фокус; можно запросить остановку.';
      });
      armed = true;
      if (closed) return;
      last = { runId: result.runId, charIds: selection.charIds, timing: selection.timing };
      q('result').textContent = JSON.stringify(result, null, 2);
      q('status').textContent = trialOutcome(result);
      q('summary').innerHTML = (result.recipients || [])
        .map(
          (r, i) =>
            `<p><strong>${esc(state.characters.find(c => c.id === selection.charIds[i])?.nick || selection.charIds[i] || 'Получатель')}</strong>: ${esc(trialOutcome(r))}</p>`
        )
        .join('');
      q('verdicts').innerHTML = selection.charIds
        .map(
          id =>
            `<label>${esc(state.characters.find(c => c.id === id)?.nick || id)}<select data-verdict="${esc(id)}"><option value="unknown">Не проверено</option><option value="worked">Все шаги сработали в нужном порядке</option><option value="failed">Не сработало / пропущены шаги</option><option value="base-only">Сработала только основная клавиша, без Ctrl/Shift</option><option value="unexpected">Побочное действие / неверный порядок</option></select></label>`
        )
        .join('');
      q('focus').checked = false;
      q('leak').checked = false;
      q('observations').disabled = false;
    } catch (error) {
      const message = error.message || 'Опыт не завершён.';
      appendBackgroundJournal('multi-ui-error', { blockedBy: message });
      if (!closed) {
        q('status').textContent = message;
        q('error').textContent = `Проверка не запущена или остановлена: ${message}`;
        q('error').hidden = false;
        q('error').scrollIntoView?.({ block: 'nearest' });
      }
    } finally {
      pending = false;
      if (!closed) {
        q('fields').disabled = false;
        q('run').disabled = false;
        q('stop').disabled = true;
        // Keep the selection and consent when preflight refused before arming.
        if (armed) q('consent').checked = false;
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
        timing: last.timing,
        status: node.value,
        foregroundChanged: q('focus').checked,
        leak: q('leak').checked
      });
    q('status').textContent =
      'Наблюдения добавлены в журнал. При предупреждении хранилища скачайте журнал до закрытия.';
  };
  q('log').onclick = openBackgroundJournal;
  ov.foot.innerHTML = '<button type="button" class="btn" data-close>Закрыть</button>';
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  return ov;
}

import { chord } from './keySyntax.js';
export function eventChord(event) {
  const raw = event.code || '';
  let key = raw.startsWith('Key')
    ? raw.slice(3)
    : raw.startsWith('Digit')
      ? raw.slice(5)
      : ({
          ArrowLeft: 'LEFT',
          ArrowRight: 'RIGHT',
          ArrowUp: 'UP',
          ArrowDown: 'DOWN',
          Space: 'SPACE',
          Enter: 'ENTER',
          Tab: 'TAB',
          Escape: '',
          Home: 'HOME',
          Pause: 'PAUSE'
        }[raw] ?? (/^F\d+$/.test(raw) ? raw : ''));
  if (!key || event.metaKey || (event.altKey && ['TAB', 'F4'].includes(key))) return '';
  return chord(
    [event.ctrlKey ? 'CTRL' : '', event.altKey ? 'ALT' : '', event.shiftKey ? 'SHIFT' : '', key]
      .filter(Boolean)
      .join('+')
  );
}
/** Explicit editor-local recorder. No document/global hooks and no game observation. */
export function mountRecorder(host, { cursor, onRecorded, limit = 60 }) {
  host.innerHTML =
    '<button type="button" class="btn" data-record-start>● Записать кнопки</button><button type="button" class="btn" data-record-stop disabled>■ Завершить запись</button><button type="button" class="btn ghost" data-record-cancel disabled>Отменить запись</button><p data-record-status role="status">Запись только в области ниже. Клавиши/сочетания, клики и интервалы; не текст и не длительное удержание. Перетаскивания и движения мыши не записываются.</p><div tabindex="0" class="gm-record-area" data-record-area>Нажмите «Записать», затем нажимайте клавиши и кнопки мыши здесь. Экранные координаты кликов будут видны в шагах — проверьте их перед запуском.</div>';
  const area = host.querySelector('[data-record-area]'),
    start = host.querySelector('[data-record-start]'),
    stop = host.querySelector('[data-record-stop]'),
    cancel = host.querySelector('[data-record-cancel]'),
    status = host.querySelector('[data-record-status]');
  let active = false,
    accepting = false,
    epoch = 0,
    last = 0,
    result = [],
    queue = Promise.resolve(),
    timer;
  const controls = () => {
    start.disabled = active;
    stop.disabled = cancel.disabled = !active;
    area.classList.toggle('is-recording', active);
  };
  const append = (step, at) => {
    if (!active) return;
    const delta = Math.round(at - last);
    if (result.length + (result.length && delta >= 50 ? 2 : 1) > limit) {
      status.textContent = 'Достигнут предел записи.';
      void finish(true);
      return;
    }
    if (result.length && delta >= 50) result.push({ type: 'wait', ms: Math.min(10000, delta) });
    result.push(step);
    last = at;
    status.textContent = `Записано шагов: ${result.length}. Запись не выполняет дополнительные действия.`;
  };
  start.onclick = () => {
    if (limit <= 0) {
      status.textContent = 'Сначала удалите шаги: блок заполнен.';
      return;
    }
    active = true;
    accepting = true;
    ++epoch;
    result = [];
    last = performance.now();
    queue = Promise.resolve();
    controls();
    area.focus();
    status.textContent = 'Запись: только эта область. Вне её события не собираются.';
    clearTimeout(timer);
    timer = setTimeout(() => void finish(true), 120000);
  };
  const finish = async save => {
    if (!active) return;
    start.disabled = stop.disabled = cancel.disabled = true;
    clearTimeout(timer);
    accepting = false;
    const id = epoch;
    await queue;
    if (id !== epoch) return;
    active = false;
    ++epoch;
    controls();
    if (save && result.length) {
      onRecorded(result);
      status.textContent = `Добавлено ${result.length} шагов. Проверьте координаты и разрешите мышь перед запуском.`;
    } else status.textContent = 'Запись отменена или пуста.';
  };
  stop.onclick = () => void finish(true);
  cancel.onclick = () => {
    active = false;
    ++epoch;
    clearTimeout(timer);
    result = [];
    controls();
    status.textContent = 'Запись отменена.';
  };
  area.addEventListener('keydown', event => {
    if (!active || !accepting || event.repeat) return;
    const value = eventChord(event);
    if (!value) return;
    event.preventDefault();
    const at = performance.now(),
      id = epoch;
    queue = queue.then(() => {
      if (id === epoch) append({ type: 'keys', value }, at);
    });
  });
  area.addEventListener('pointerdown', event => {
    if (!active || !accepting || event.button < 0 || event.button > 4) return;
    event.preventDefault();
    if (event.metaKey) {
      status.textContent = 'Win+клик не записывается.';
      return;
    }
    area.focus();
    const id = epoch,
      at = performance.now(),
      button = ['left', 'middle', 'right', 'x1', 'x2'][event.button];
    const modifiers = [event.ctrlKey ? 'CTRL' : '', event.shiftKey ? 'SHIFT' : '', event.altKey ? 'ALT' : ''].filter(
      Boolean
    );
    const position = Promise.resolve()
      .then(cursor)
      .then(
        p => ({ ok: true, p }),
        () => ({ ok: false })
      );
    queue = queue.then(async () => {
      try {
        const captured = await position;
        if (!captured.ok) throw new Error('pointer');
        const p = captured.p;
        if (active && epoch === id) append({ type: 'screen', button, count: 1, x: p.x, y: p.y, modifiers }, at);
      } catch {
        if (epoch === id) status.textContent = 'Не удалось прочитать физические координаты. Клик не записан.';
      }
    });
  });
  area.addEventListener('contextmenu', event => event.preventDefault());
  return () => {
    active = false;
    ++epoch;
    clearTimeout(timer);
  };
}

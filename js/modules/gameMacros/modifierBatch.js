import { chord, steps } from './keySyntax.js';
import { openOverlay } from '../marathons/overlay.js';
import { keyboardButton } from './keyboardPicker.js';
import { escapeHtml } from '../../core/utils.js';
import { appendBackgroundJournal, openBackgroundJournal } from './backgroundJournal.js';

export function validateModifierBatch(selection, state) {
  const charIds = selection.charIds;
  if (
    !Array.isArray(charIds) ||
    !charIds.length ||
    charIds.length > 4 ||
    new Set(charIds).size !== charIds.length ||
    charIds.some(id => !state.characters.some(c => c.id === id))
  )
    throw new Error('Выберите от 1 до 4 разных актуальных персонажей.');
  if (!['hybrid', 'activate'].includes(selection.method)) throw new Error('Выберите гибридный ввод или активацию.');
  const plan = steps(selection.sequence);
  if (plan.length > 8) throw new Error('Не более 8 шагов, включая паузы.');
  if (!plan.some(step => step.key)) throw new Error('Добавьте хотя бы одну команду.');
  for (const step of plan) {
    if (!step.key) continue;
    const key = chord(step.key);
    if (
      !/^(?:(?:CTRL\+)?(?:ALT\+)?(?:SHIFT\+)?)(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|NUMPAD[0-9]|LEFT|RIGHT|UP|DOWN|HOME|END|PAGEUP|PAGEDOWN)$/.test(
        key
      ) ||
      (key.split('+').includes('ALT') && key.endsWith('+F4'))
    )
      throw new Error(
        'Разрешены Ctrl/Alt/Shift, буквы, цифры, F1–F24, NumPad и навигация. Alt+F4, Win и системные клавиши исключены.'
      );
  }
  if (selection.consent !== true || selection.riskConsent !== true)
    throw new Error('Нужны оба свежих подтверждения безопасности и глобального ввода.');
  return { charIds: [...charIds], steps: plan, method: selection.method, consent: true, riskConsent: true };
}

export function openModifierBatch({ state, run, stop }) {
  let pending = false,
    closed = false,
    blocked = false,
    last = null;
  const ov = openOverlay({
    title: 'Пакетный опыт · Ctrl / Shift / Alt · 1–4 клиента',
    wide: true,
    onClose: () => {
      closed = true;
      if (pending) stop();
    }
  });
  ov.body.innerHTML = `<p>Ручная последовательная проверка, не автоматический повтор. До 4 клиентов и 8 шагов. Сначала вся последовательность выполняется на первом клиенте, затем на следующем. Между командами — 300 мс; модификаторы отпускаются после каждой команды. Любой отказ останавливает весь пакет.</p><p class="gm-trial-error">Глобальные Ctrl/Alt/Shift могут затронуть другое приложение. Гибрид требует пустой Блокнот на переднем плане, а игры — видимыми и не свёрнутыми. Активация последовательно меняет фокус и оставляет последнее игровое окно активным. Не касайтесь клавиатуры и мыши во время опыта. Системные сочетания исключены, но безопасность игровых действий проверяете вы.</p><fieldset data-fields><legend>План проверки</legend>${state.characters.map(c => `<label><input type="checkbox" data-char value="${escapeHtml(c.id)}"> ${escapeHtml(c.nick)}</label>`).join('')}<label>Способ<select data-method><option value="hybrid">Глобальные модификаторы + адресная клавиша</option><option value="activate">Активация каждого клиента + полный SendInput</option></select></label><label>Команды, по одной на строке<textarea class="input" data-sequence rows="8">SHIFT+1
CTRL+2
ALT+3</textarea></label><p>Например: CTRL+SHIFT+4, F8, NUMPAD1, wait 500. Не более 8 шагов. Каждое действие сначала проверьте физически на каждом клиенте.</p><label>Клавиатура-помощник<input class="input" data-key value="CTRL+1"></label><button type="button" class="btn" data-add>Добавить сочетание в план</button><label><input type="checkbox" data-consent> Все действия проверены физически на каждом клиенте; чат закрыт, действия безопасны, повтор выключен.</label><label><input type="checkbox" data-risk> Разрешаю глобальные модификаторы и, для режима активации, смену фокуса. Пустой Блокнот не содержит важных данных.</label></fieldset><button type="button" class="btn primary" data-run>Выполнить пакет через 5 секунд</button><button type="button" class="btn danger" data-stop disabled>Остановить</button><p role="status" data-status>Один пакет без повторов. Результаты Windows и действия игры фиксируются отдельно.</p><pre data-result></pre><fieldset data-observations disabled><legend>Наблюдения по выполненным командам</legend><div data-rows></div><label><input type="checkbox" data-leak> Был нежелательный ввод в другом приложении</label><label><input type="checkbox" data-focus> Была неожиданная смена фокуса (не запрошенная активация)</label><button type="button" class="btn" data-save>Сохранить наблюдения</button></fieldset>`;
  const q = name => ov.body.querySelector(`[data-${name}]`);
  q('key').after(keyboardButton(q('key')));
  q('add').onclick = () => {
    q('sequence').value += `\n${q('key').value}`;
    q('fields').dispatchEvent(new Event('input', { bubbles: true }));
  };
  const reset = () => {
    q('consent').checked = false;
    q('risk').checked = false;
  };
  q('fields').addEventListener('input', e => {
    if (!e.target.matches('[data-consent], [data-risk]')) reset();
  });
  q('run').onclick = async () => {
    if (pending || blocked) return;
    try {
      const selection = validateModifierBatch(
        {
          charIds: [...ov.body.querySelectorAll('[data-char]:checked')].map(c => c.value),
          sequence: q('sequence').value,
          method: q('method').value,
          consent: q('consent').checked,
          riskConsent: q('risk').checked
        },
        state
      );
      pending = true;
      last = null;
      q('fields').disabled = true;
      q('run').disabled = true;
      q('stop').disabled = false;
      q('observations').disabled = true;
      q('result').textContent = '';
      reset();
      const result = await run(selection, message => {
        if (!closed) q('status').textContent = message;
      });
      if (closed) return;
      last = result;
      blocked = result.releaseUnconfirmed === true;
      q('result').textContent = JSON.stringify(result, null, 2);
      q('status').textContent = blocked
        ? 'Отпускание не подтверждено. Прекратите проверки, проверьте клавиатуру и перезапустите приложение.'
        : result.ok
          ? 'Пакет отправлен. Теперь отметьте результат каждой команды в игре.'
          : 'Пакет остановлен. Последующие команды не отправлялись.';
      q('rows').innerHTML = result.results
        .map(
          (row, i) =>
            `<label>${escapeHtml(row.charId)} · шаг ${row.index + 1} · ${escapeHtml(row.key)}<select data-verdict="${i}"><option value="unknown">Не проверено</option><option value="worked">Команда сработала</option><option value="base-only">Только основная клавиша</option><option value="failed">Ничего</option><option value="unexpected">Побочное действие</option></select></label>`
        )
        .join('');
      q('leak').checked = false;
      q('focus').checked = false;
      q('observations').disabled = !result.results.length;
    } catch (error) {
      if (!closed) q('status').textContent = error.message;
    } finally {
      pending = false;
      if (!closed) {
        q('fields').disabled = false;
        q('run').disabled = blocked;
        q('stop').disabled = true;
      }
    }
  };
  q('stop').onclick = () => {
    stop();
    q('status').textContent = 'Остановка запрошена; дождитесь отчёта об отпускании.';
  };
  q('save').onclick = () => {
    if (!last) return;
    for (const select of ov.body.querySelectorAll('[data-verdict]')) {
      const row = last.results[Number(select.dataset.verdict)];
      appendBackgroundJournal('modifier-batch-user-observation', {
        runId: last.runId,
        charId: row.charId,
        key: row.key,
        index: row.index,
        method: last.method,
        status: select.value,
        leak: q('leak').checked,
        foregroundChanged: q('focus').checked
      });
    }
    q('status').textContent = 'Наблюдения сохранены.';
  };
  ov.foot.innerHTML =
    '<button type="button" class="btn" data-log>Журнал</button><button type="button" class="btn" data-close>Закрыть</button>';
  ov.foot.querySelector('[data-log]').onclick = openBackgroundJournal;
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  return ov;
}

import { chord } from './keySyntax.js';
import { openOverlay } from '../marathons/overlay.js';
import { keyboardButton } from './keyboardPicker.js';
import { appendBackgroundJournal, openBackgroundJournal } from './backgroundJournal.js';
import { escapeHtml } from '../../core/utils.js';
import { trialOutcome } from './multiInputTrial.js';
export const MODIFIER_EXPERIMENTS = {
  isolated: 'Контроль · изолированный E, сообщения Shift',
  hybrid: 'Опыт · глобальный Shift + адресная основная клавиша',
  activate: 'Опыт · активация окна + полное сочетание SendInput'
};
export function validateModifierExperiment(selection, state) {
  const key = chord(selection.key);
  if (!state.characters.some(c => c.id === selection.charId)) throw new Error('Выберите одного актуального персонажа.');
  if (!Object.hasOwn(MODIFIER_EXPERIMENTS, selection.method)) throw new Error('Выберите один опыт.');
  if (!/^SHIFT\+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key))
    throw new Error('Только Shift + буква, цифра или F1–F24. Без Ctrl/Alt/Win, пауз и последовательностей.');
  if (selection.consent !== true) throw new Error('Подтвердите безопасную физическую проверку.');
  if (selection.method !== 'isolated' && selection.riskConsent !== true)
    throw new Error('Отдельно подтвердите глобальный ввод или смену фокуса.');
  return {
    charId: selection.charId,
    key,
    method: selection.method,
    consent: true,
    riskConsent: selection.riskConsent === true
  };
}
export function openModifierExperiments({ state, run, stop }) {
  let pending = false,
    closed = false,
    last = null,
    blocked = false;
  const ov = openOverlay({
    title: 'Эксперименты Shift · один клиент',
    wide: true,
    onClose: () => {
      closed = true;
      if (pending) stop();
    }
  });
  ov.body.innerHTML = `<p>Каждый способ запускается отдельно и только вручную. Ни один не подтверждён для PW. Сначала назначьте на основную клавишу и сочетание два различимых безопасных действия и проверьте их физически. Повтор должен быть выключен.</p><p class="gm-trial-error">Гибридный опыт меняет глобальное состояние Shift и может повлиять на активное приложение. Для него нужен пустой Блокнот на переднем плане: проверяется класс окна Notepad. Опыт с активацией намеренно меняет фокус; игровое окно останется активным после попытки. Гонки с ручным вводом полностью исключить нельзя. Во время опыта не нажимайте клавиши/мышь. При неподтверждённом отпускании прекратите проверки.</p><fieldset data-fields><label>Один персонаж<select data-char><option value="">Выберите</option>${state.characters.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.nick)}</option>`).join('')}</select></label><label>Одно сочетание<input class="input" data-key value="SHIFT+1"></label><label>Способ<select data-method>${Object.entries(
    MODIFIER_EXPERIMENTS
  )
    .map(([id, label]) => `<option value="${id}">${label}</option>`)
    .join(
      ''
    )}</select></label><p data-help></p><label class="switch-row"><input type="checkbox" data-consent> Физическое сочетание проверено; чат закрыт, оба действия безопасны и не расходуют предметы.</label><label class="switch-row"><input type="checkbox" data-risk> Для выбранного опыта разрешаю глобальный Shift либо активацию игрового окна и SendInput. Понимаю риск воздействия на другое приложение.</label></fieldset><p><button type="button" class="btn primary" data-run>Один опыт через 5 секунд</button><button type="button" class="btn danger" data-stop disabled>Остановить</button></p><p role="status" data-status>Окно игры должно быть видимым и не свёрнутым. Нет автоматического перебора и повторов.</p><pre data-result></pre><fieldset data-observations disabled><label>Результат в игре<select data-verdict><option value="unknown">Не проверено</option><option value="worked">Выполнилось именно сочетание</option><option value="base-only">Только основная клавиша, без Shift</option><option value="failed">Ничего</option><option value="unexpected">Побочное действие</option></select></label><label><input type="checkbox" data-leak> Был нежелательный ввод в другом приложении</label><label><input type="checkbox" data-focus> Была неожиданная смена фокуса</label><button type="button" class="btn" data-save>Сохранить наблюдение</button></fieldset>`;
  const q = name => ov.body.querySelector(`[data-${name}]`);
  q('key').after(keyboardButton(q('key')));
  const help = () => {
    q('risk').checked = false;
    q('consent').checked = false;
    q('risk').disabled = q('method').value === 'isolated';
    q('help').textContent = {
      isolated:
        'Контроль E: игра неактивна, фокус оставьте в пустом Блокноте. Shift передаётся только сообщениями окна. Известен результат «только 1».',
      hybrid:
        'Игра неактивна; пустой Блокнот должен оставаться активным. Один левый Shift через SendInput, пауза 50 мс, адресная клавиша с удержанием 30 мс. Ожидание сообщения 100 мс. Это НЕ изолированный фон.',
      activate:
        'Можно оставить фокус в Блокноте: после отсчёта приложение один раз запросит активацию игры и отправит сочетание. Фокус обратно не возвращается. Это НЕ фоновый ввод.'
    }[q('method').value];
  };
  for (const name of ['char', 'key'])
    q(name).addEventListener('input', () => {
      q('consent').checked = false;
      q('risk').checked = false;
    });
  q('method').onchange = help;
  help();
  q('run').onclick = async () => {
    if (pending) return;
    let armed = false;
    try {
      const selection = validateModifierExperiment(
        {
          charId: q('char').value,
          key: q('key').value,
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
      const result = await run(selection, left => {
        armed = true;
        if (!closed)
          q('status').textContent = left
            ? `До опыта: ${left} с. Отпустите физические клавиши и мышь.`
            : 'Выполняется один опыт; не меняйте фокус.';
      });
      if (closed) return;
      last = { runId: result.runId, charId: selection.charId, method: selection.method, key: selection.key };
      q('result').textContent = JSON.stringify(result, null, 2);
      if (result.releaseUnconfirmed) blocked = true;
      q('status').textContent =
        (result.refused && result.blockedBy ? result.blockedBy : trialOutcome(result)) +
        (blocked ? ' Новые опыты заблокированы: проверьте клавиатуру и перезапустите приложение.' : '');
      q('verdict').value = 'unknown';
      q('leak').checked = false;
      q('focus').checked = false;
      q('observations').disabled = false;
    } catch (error) {
      appendBackgroundJournal('modifier-ui-error', { blockedBy: error.message });
      if (!closed) q('status').textContent = error.message || 'Опыт не завершён.';
    } finally {
      pending = false;
      if (!closed) {
        q('fields').disabled = false;
        q('run').disabled = blocked;
        q('stop').disabled = true;
        if (armed) {
          q('consent').checked = false;
          q('risk').checked = false;
        }
      }
    }
  };
  q('stop').onclick = () => {
    stop();
    q('status').textContent = 'Остановка запрошена. Дождитесь отчёта об отпускании клавиш.';
  };
  q('save').onclick = () => {
    if (!last) return;
    appendBackgroundJournal('modifier-user-observation', {
      ...last,
      status: q('verdict').value,
      leak: q('leak').checked,
      foregroundChanged: q('focus').checked
    });
    q('status').textContent = 'Ручное наблюдение добавлено в журнал.';
  };
  ov.foot.innerHTML =
    '<button type="button" class="btn" data-log>Журнал</button><button type="button" class="btn" data-close>Закрыть</button>';
  ov.foot.querySelector('[data-log]').onclick = openBackgroundJournal;
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  return ov;
}

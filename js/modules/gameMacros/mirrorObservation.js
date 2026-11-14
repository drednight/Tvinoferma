import { showModal } from '../../core/ui.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { partyMembers, steps } from './model.js';
import { LAB_VERDICTS } from './labResults.js';
import { conditionsFields, readConditions } from './testConditions.js';
// The manual observation keeps the chosen delivery method apart: the recorded verdict
// is a manual observation and never proves a delivery or a game effect.
const OBSERVATION_METHODS = {
  post: 'mirror-post',
  'activity-notify': 'mirror-activity-notify',
  combined: 'mirror-combined',
  'cache-hybrid': 'mirror-cache-hybrid'
};
const METHOD_LABELS = {
  post: 'PostMessage',
  'activity-notify': 'только activity-notify',
  combined: 'PostMessage + activity-notify',
  'cache-hybrid': 'глобальный ввод + WM_KEYDOWN'
};
export function mirrorObservation({ charId, key, verdict, notes, conditions }, c, state) {
  if (!partyMembers(state, c.partyId).some(char => char.id === charId))
    throw new Error('Выберите участника текущей пати.');
  const parsed = steps(key);
  if (parsed.length !== 1 || !parsed[0].key) throw new Error('Укажите одну тестовую клавишу/сочетание, не текст чата.');
  if (!Object.hasOwn(LAB_VERDICTS, verdict)) throw new Error('Выберите наблюдение.');
  return {
    id: crypto.randomUUID(),
    partyId: c.partyId,
    charId,
    key: parsed[0].key,
    method: OBSERVATION_METHODS[c.mirrorKeyboardMethod] || OBSERVATION_METHODS.post,
    verdict,
    notes: String(notes || '').slice(0, 600),
    conditions,
    at: new Date().toISOString(),
    technical: {
      state: 'manual-observation',
      stage: 'manual-observation',
      known:
        'Ручное наблюдение клавиатурного повтора. Технический отчёт конкретной отправки к этой записи не приложен.',
      unknown:
        'Состояние чата и реакция игры не считываются автоматически; запись не подтверждает доставку конкретному окну.',
      next: 'Сопоставьте с журналом повтора и одиночными испытаниями при тех же условиях. Способ записи взят из настроек, не из технической квитанции.',
      runId: '',
      trace: null
    }
  };
}
export function openMirrorObservation({ getConfig, state, save }) {
  const c = getConfig();
  let pending = false;
  const modal = showModal({
    title: 'Наблюдение повтора клавиатуры — без отправки',
    wide: true,
    submitText: 'Сохранить наблюдение',
    cancelText: 'Закрыть',
    beforeClose: () => !pending,
    content: `<form class="gm-dialog"><p>Выбранный способ повтора: ${METHOD_LABELS[c.mirrorKeyboardMethod] || METHOD_LABELS.post}${c.mirrorHoldOnly ? ' · удержание без автоповтора' : ''}. Эта форма ничего не запускает и не нажимает. После отдельного ручного теста запишите результат для одной безопасной клавиши и одного получателя. Для сравнения чата и игрового действия создайте две записи при одинаковых прочих условиях. Ничего не отправляйте в чат: достаточно увидеть букву в поле, не нажимая Enter.</p><label>Получатель<select name="charId"><option value="">Выберите</option>${partyMembers(
      state,
      c.partyId
    )
      .map(char => `<option value="${esc(char.id)}">${esc(char.nick)}</option>`)
      .join(
        ''
      )}</select></label><label>Одна тестовая клавиша<input name="key" maxlength="60" placeholder="B"></label>${conditionsFields()}<label>Наблюдение<select name="verdict">${Object.entries(
      LAB_VERDICTS
    )
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join(
        ''
      )}</select></label><label><input type="checkbox" name="observed"> Проверил непосредственно в игре</label><label>Заметка без текста чата и секретов<textarea name="notes" maxlength="600" rows="3"></textarea></label><p data-mirror-observation-status role="status"></p></form>`,
    onSubmit: async data => {
      if (pending) return false;
      const status = modal.querySelector('[data-mirror-observation-status]');
      try {
        if (getConfig().partyId !== c.partyId) throw new Error('Пати изменилась. Откройте форму заново.');
        if (data.get('verdict') !== 'unverified' && !data.has('observed'))
          throw new Error('Подтвердите наблюдение в игре.');
        const row = mirrorObservation(
          { ...Object.fromEntries(data), conditions: readConditions(modal) },
          getConfig(),
          state
        );
        pending = true;
        await save({ backgroundTrials: [...getConfig().backgroundTrials, row].slice(-40) });
      } catch (error) {
        status.textContent = error.message || 'Не удалось сохранить наблюдение.';
        return false;
      } finally {
        pending = false;
      }
    }
  });
}

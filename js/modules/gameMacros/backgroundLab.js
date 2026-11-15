import { showModal } from '../../core/ui.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import { partyMembers } from './model.js';
import { backgroundExperiments } from './background.js';
/** Prepares independent commands only. No input, focus change or automatic test run. */
export function openBackgroundLab(c, save) {
  const recipients = partyMembers(state, c.partyId).filter(character => character.id !== c.leaders[c.partyId]);
  showModal({
    title: 'Лаборатория фоновой клавиатуры',
    submitText: 'Создать 5 тестов — без запуска',
    cancelText: 'Отмена',
    content: `<form class="gm-dialog gm-background-lab"><p>Подготовьте пять отдельных команд для сравнения на <b>одном твине</b>. Сейчас ничего не отправляется в игру. Позже запускайте каждый тест вручную кнопкой ▶ и записывайте фактическую реакцию игры.</p><label>Получатель, кроме ПЛ<select name="charId" required><option value="">Выберите одного персонажа</option>${recipients.map(char => `<option value="${esc(char.id)}">${esc(char.nick)}</option>`).join('')}</select></label><label>Безопасная тестовая клавиша<input name="key" placeholder="Например B или F8" required maxlength="60"></label><p class="gm-lab-warning">Не используйте расходные действия. При ошибке получателя тест остановится, а не переключится на все окна. Хоткеи тестам не назначаются.</p><ol><li>Обычная очередь PostMessage — базовое сравнение.</li><li>Очередь со scan-code раскладки получателя. При одинаковых раскладках результат может совпасть с базовым.</li><li>Исходные уведомления активности — предыдущий B-тест был неуспешным.</li><li>Только WM_ACTIVATE, без проблемного WM_ACTIVATEAPP.</li><li>Асинхронные уведомления активности, затем ограниченная по времени отправка клавиши. Принятие запроса не подтверждает обработку.</li></ol><p>Ни один способ не объявлен рабочим в PW. Нет внедрения, автоматического перебора или перехода к переключению окон.</p>${recipients.length ? '' : '<p role="alert">Сначала выберите пати и добавьте хотя бы одного получателя кроме ПЛ.</p>'}<p data-lab-error role="alert" hidden></p></form>`,
    onSubmit: async data => {
      try {
        const charId = data.get('charId');
        if (
          !recipients.some(char => char.id === charId) ||
          !partyMembers(state, c.partyId).some(char => char.id === charId)
        )
          throw new Error('Выберите актуального участника выбранной пати.');
        const tests = backgroundExperiments({ key: data.get('key'), charId, partyId: c.partyId }, c.commands);
        await save({ commands: [...c.commands, ...tests] });
      } catch (error) {
        const box = document.querySelector('[data-lab-error]');
        box.hidden = false;
        box.textContent = error.message;
        return false;
      }
    }
  });
}

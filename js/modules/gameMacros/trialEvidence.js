import { backgroundExperiments } from './background.js';
import { partyMembers } from './model.js';
export function buildTrial({ partyId, charId, key, method }, c, state, makeId = () => crypto.randomUUID()) {
  if (
    partyId !== c.partyId ||
    !partyMembers(state, partyId).some(char => char.id === charId) ||
    charId === c.leaders[partyId]
  )
    throw new Error('Выберите одного актуального твина выбранной пати, кроме ПЛ.');
  const command = backgroundExperiments({ partyId, charId, key }, [], makeId).find(
    row => row.backgroundMethod === method
  );
  if (!command) throw new Error('Выберите один способ из лаборатории.');
  return command;
}
export function summarizeExecution(run) {
  if (!run)
    return {
      stage: 'Нет запуска',
      known: 'Технических данных нет.',
      unknown: 'Доставка и действие игры неизвестны.',
      next: 'Выполните отдельный тест после проверки окна.'
    };
  const events = run.events || [];
  const phase = events.find(event => event.stage === 'background-phase' && event.status === 'blocked');
  const failure =
    phase ||
    [...events]
      .reverse()
      .find(event => ['blocked', 'error'].includes(event.status) && event.stage !== 'command-failure') ||
    [...events].reverse().find(event => event.stage === 'command-failure');
  const codes = events.map(event => event.details?.errorCode);
  const foreground = events.some(event => event.details?.foregroundChanged === true);
  let known;
  if (foreground) known = 'По замерам изменилось активное окно. Условие фонового ввода нарушено.';
  else if (codes.includes(1460))
    known = 'Windows не ответила в установленный срок (1460). Таймаут не доказывает недоставку.';
  else if (codes.includes(5)) known = 'Windows сообщила об отказе в доступе (5).';
  else if (failure)
    known = failure.details?.blockedBy || 'На этом этапе зарегистрирован отказ; точная причина не установлена.';
  else if (run.state === 'stopped') known = 'Выполнение остановлено. Ранее отправленный ввод не отменяется.';
  else if (run.state === 'running') known = 'Выполнение ещё идёт.';
  else if (run.state === 'finished')
    known = 'Исполнитель завершился без зарегистрированной ошибки. Это не подтверждение обработки сообщения игрой.';
  else known = 'Запуск не завершён успешно; подробности доступны в диагностике.';
  return {
    stage: failure?.details?.phase || failure?.stage || run.stage || 'Неизвестно',
    known,
    unknown: 'Реакция игры и обработка сообщения клиентом автоматически не определяются.',
    next: foreground
      ? 'Не повторяйте автоматически. Проверьте активное окно и условия одиночного теста.'
      : 'Проверьте реакцию непосредственно в игре и сохраните наблюдение. При отказе сравните диагностику без повторного ввода.'
  };
}

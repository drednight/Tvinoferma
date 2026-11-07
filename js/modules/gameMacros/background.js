// These are transport experiments, not claims about PW compatibility. Never auto-fallback.
export const BACKGROUND_METHODS = {
  post: 'PostMessage · очередь',
  'send-timeout': 'SendMessageTimeout · ожидание до 25 мс на сообщение',
  notify: 'SendNotifyMessage · асинхронное уведомление'
};
export const backgroundMethod = value => (Object.hasOwn(BACKGROUND_METHODS, value) ? value : 'post');
export function backgroundVariants(command, commands, makeId = () => crypto.randomUUID()) {
  if (!['sequence', 'f6f1'].includes(command.action)) throw new Error('Варианты доступны только для клавиш и F6→F1.');
  if (commands.length > 61) throw new Error('Для трёх вариантов нужны три свободных места (максимум 64 команды).');
  return Object.entries(BACKGROUND_METHODS).map(([method, label]) => ({
    ...command,
    id: makeId(),
    name: `${command.name || 'Тест'} · ${label.split(' · ')[0]}`.slice(0, 80),
    delivery: 'background',
    backgroundMethod: method,
    hotkey: ''
  }));
}

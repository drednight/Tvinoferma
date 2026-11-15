import { steps } from './keySyntax.js';
// These are transport experiments, not claims about PW compatibility. Never auto-fallback.
export const BACKGROUND_METHODS = {
  post: 'PostMessage · очередь',
  'send-timeout': 'SendMessageTimeout · ожидание до 25 мс на сообщение',
  notify: 'SendNotifyMessage · асинхронное уведомление',
  activity: 'Активность приложения и окна · исходный тест',
  'post-target-layout': 'Очередь + scan-code раскладки получателя',
  'activity-window': 'Только активность окна + клавиша · эксперимент',
  'activity-notify': 'Асинхронная активность + клавиша · эксперимент'
};
export const backgroundMethod = value =>
  value === 'hybrid-party' || Object.hasOwn(BACKGROUND_METHODS, value) ? value : 'post';
export function backgroundVariants(command, commands, makeId = () => crypto.randomUUID()) {
  if (!['sequence', 'f6f1'].includes(command.action)) throw new Error('Варианты доступны только для клавиш и F6→F1.');
  if (commands.length > 61) throw new Error('Для трёх вариантов нужны три свободных места (максимум 64 команды).');
  return Object.entries(BACKGROUND_METHODS)
    .filter(([method]) => ['post', 'send-timeout', 'notify'].includes(method))
    .map(([method, label]) => ({
      ...command,
      id: makeId(),
      name: `${command.name || 'Тест'} · ${label.split(' · ')[0]}`.slice(0, 80),
      delivery: 'background',
      backgroundMethod: method,
      hotkey: ''
    }));
}

export function validateActivityCommand(command, composing = false) {
  if (command.delivery === 'background' && command.backgroundMethod === 'hybrid-party') {
    if (composing || command.action !== 'sequence' || command.scope === 'managed' || command.hybridConsent !== true)
      throw new Error(
        'Гибрид из ПЛ: только отдельная последовательность выбранной пати с явным разрешением глобальных модификаторов.'
      );
    const plan = steps(command.sequence);
    if (plan.length > 8 || !plan.some(s => s.key))
      throw new Error('Гибрид из ПЛ: от 1 до 8 шагов, хотя бы одна клавиша.');
    for (const s of plan)
      if (
        s.key &&
        (!/^(?:(?:CTRL\+)?(?:ALT\+)?(?:SHIFT\+)?)(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|NUMPAD[0-9]|LEFT|RIGHT|UP|DOWN|HOME|END|PAGEUP|PAGEDOWN)$/.test(
          s.key
        ) ||
          (s.key.split('+').includes('ALT') && s.key.endsWith('+F4')))
      )
        throw new Error('Недопустимая клавиша гибридного режима. Системные сочетания исключены.');
    return;
  }
  if (command.delivery !== 'background' || !isActivityMethod(command.backgroundMethod)) return;
  if ((composing && command.activityBlock !== true) || command.action !== 'sequence')
    throw new Error(
      'Уведомления активности: только отдельная последовательность клавиш. Мышь, непрерывный повтор, F6→F1 и составные блоки не поддерживаются.'
    );
  steps(command.sequence);
}

export const isActivityMethod = method => ['activity', 'activity-window', 'activity-notify'].includes(method);
export const EXPERIMENT_METHODS = ['post', 'post-target-layout', 'activity', 'activity-window', 'activity-notify'];
export function backgroundExperiments({ key, charId, partyId }, commands, makeId = () => crypto.randomUUID()) {
  const parsed = steps(key);
  if (parsed.length !== 1 || !parsed[0].key)
    throw new Error('Для сравнения выберите одну клавишу или сочетание, без задержек.');
  if (!charId || !partyId) throw new Error('Выберите пати и одного тестового получателя.');
  if (commands.length + EXPERIMENT_METHODS.length > 64) throw new Error('Для пяти тестов нужны пять свободных мест.');
  return EXPERIMENT_METHODS.map((method, index) => ({
    id: makeId(),
    name: `Тест ${index + 1}: ${BACKGROUND_METHODS[method]}`.slice(0, 80),
    action: 'sequence',
    sequence: parsed[0].key,
    partyId,
    scope: 'party',
    target: 'subset',
    charIds: [charId],
    delivery: 'background',
    backgroundMethod: method,
    strictTargets: true,
    hotkey: '',
    returnTo: 'last',
    holdMs: 30,
    switchMs: 30,
    resourceAllowed: false
  }));
}

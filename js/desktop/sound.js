// js/desktop/sound.js
// Звук уведомлений.
//
// Своих звуковых файлов в приложении нет и не нужно: звук собирается из колебаний через
// Web Audio (осциллятор). Незачем тащить с собой мегабайты записей — короткий тон, который
// слышно поверх игры, делается двумя строками кода, и ему нечем устареть.
//
// Звук включается только после касания приложения: браузерный движок запрещает звук
// до первого действия пользователя. Поэтому AudioContext создаётся по первому клику
// или нажатию клавиши (`initSound`) и живёт до конца сеанса. До касания `playNotificationSound`
// молча ничего не делает: ругаться на это пользователю нечем — Windows-уведомление всё
// равно уже показано.

/** Виды, которым нужен заметный звук: это «сейчас», а не «когда-нибудь». */
const PROFILE_BY_KIND = {
  behind: 'attention',
  tight: 'attention',
  ending: 'attention',
  event: 'attention',
  launch: 'attention',
  launchError: 'attention'
};

/**
 * Наборы звука на выбор. Своих звуковых файлов по-прежнему нет: это наборы нот.
 * `notes` — частота (Гц), начало (с) от начала звука и длительность (с).
 *
 * Почему наборов несколько: уведомления бывают разные по важности, и один и тот же тон
 * для «напоминание о марафоне» и «ошибка запуска» примелькается. Пользователь выбирает
 * набор в настройках и может его послушать, не гадая, как это будет звучать в игре.
 */
export const SOUND_TONES = [
  {
    id: 'clear',
    title: 'Чёткий',
    hint: 'Два тона: как сейчас по умолчанию',
    notes: [
      { freq: 880, at: 0, dur: 0.12 },
      { freq: 660, at: 0.17, dur: 0.18 }
    ]
  },
  {
    id: 'soft',
    title: 'Мягкий',
    hint: 'Один негромкий тон, не отвлекает от игры',
    notes: [{ freq: 587, at: 0, dur: 0.16 }]
  },
  {
    id: 'signal',
    title: 'Сигнал',
    hint: 'Три коротких тона вверх — хорошо слышно поверх игры',
    notes: [
      { freq: 660, at: 0, dur: 0.1 },
      { freq: 880, at: 0.14, dur: 0.1 },
      { freq: 1174, at: 0.28, dur: 0.22 }
    ]
  },
  {
    id: 'low',
    title: 'Глухой',
    hint: 'Низкий длинный тон: слышно, но не пронзительно',
    notes: [{ freq: 330, at: 0, dur: 0.28 }]
  }
];

/** Набор по умолчанию и поиск по id: настройка приходит из state.json и может быть любой. */
export const DEFAULT_TONE = 'clear';

function toneById(id) {
  return SOUND_TONES.find(t => t.id === id) || SOUND_TONES.find(t => t.id === DEFAULT_TONE);
}

const DEFAULT_VOLUME = 80;

/** Пиковая громкость одной ноты при громкости 100%. */
const PEAK = 0.22;

let ctx = null;

/** Контекст звука или `null`, если движок его не дал (тестовая среда, старый браузер). */
function context() {
  if (ctx) return ctx;
  const Ctor = typeof window === 'undefined' ? null : (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch (_) {
    return null; // звук не критичен: без него уведомление всё равно показывается
  }
  return ctx;
}

/**
 * Настройки звука с приведением к допустимым: громкость — целое от 0 до 100,
 * набор — из списка `SOUND_TONES`.
 * @param {any} [settings] `state.settings`
 * @returns {{ enabled: boolean, volume: number, tone: string }}
 */
export function soundSettings(settings) {
  const raw = settings?.sound || {};
  const volume = Number(raw.volume);
  return {
    enabled: raw.enabled !== false,
    volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : DEFAULT_VOLUME,
    tone: toneById(raw.tone).id
  };
}

/**
 * Набор звука для конкретного вида уведомления.
 *
 * Зачем: виды разные по важности, и один набор на всех примелькается — «напоминание о
 * марафоне» и «ошибка запуска» звучали одинаково. У вида может быть свой набор
 * (`kinds[kind].tone`), а если его не выбрано — общий из настроек звука.
 *
 * @param {string} kind вид уведомления (`NOTIFY_KINDS`)
 * @param {any} [settings] `state.settings.notifications`
 */
export function toneForKind(kind, settings) {
  const own = settings?.kinds?.[kind]?.tone;
  return own ? toneById(own).id : soundSettings(settings).tone;
}

/**
 * Разрешить звук: браузерный движок держит AudioContext в подвешенном состоянии,
 * пока пользователь ни разу ни во что не ткнул. Без этого звук не появится никогда.
 */
export function unlockSound() {
  const c = context();
  if (c && c.state === 'suspended') void c.resume().catch(() => {});
}

/** Слушаем первое действие пользователя: с этого момента звук возможен. */
export function initSound() {
  if (typeof window === 'undefined' || window.__tfSoundWoken) return;
  window.__tfSoundWoken = true;
  window.addEventListener('pointerdown', unlockSound, { once: true, passive: true });
  window.addEventListener('keydown', unlockSound, { once: true, passive: true });
}

/** Что со звуком прямо сейчас — для диагностики в настройках. */
export function soundDiagnostics() {
  const c = context();
  return {
    // «нет звука в движке» — это про тестовую среду, а не про Windows
    available: !!c,
    state: c ? c.state : 'no-audio',
    reason: !c
      ? 'Браузерный движок не поддерживает Web Audio — звуковых уведомлений не будет, всплывающие работают как прежде.'
      : c.state === 'suspended'
        ? 'Звук включится после первого клика по окну приложения: браузерный движок не разрешает звук заранее.'
        : ''
  };
}

/** Одна нота с плавным затуханием: резкий обрыв слышен как щелчок. */
function note(ac, at, freq, dur, gain) {
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.linearRampToValueAtTime(gain, at + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(amp).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/**
 * Сыграть набор нот.
 *
 * Срочные виды играют набор дважды: одиночный сигнал на фоне игры легко пропустить,
 * а повтор всё ещё короткий и не превращается в трель.
 * @returns {boolean} получилось ли
 */
function playNotes(ac, toneId, volume, repeat) {
  const tone = toneById(toneId);
  const gain = PEAK * (Math.min(100, Math.max(0, volume)) / 100);
  const step = tone.notes[tone.notes.length - 1].at + tone.notes[tone.notes.length - 1].dur + 0.16;
  // Небольшой сдвиг от текущего момента: сразу после resume движок переключает состояние
  // не мгновенно, и нота, поставленная «сейчас», может не зазвучать
  const start = ac.currentTime + 0.03;
  for (const offset of repeat ? [0, step] : [0]) {
    for (const n of tone.notes) note(ac, start + offset + n.at, n.freq, n.dur, gain);
  }
  return true;
}

/**
 * Звук уведомления одного вида. Возвращает, получилось ли: `false` — звука не было
 * (выключен настройкой, движок без Web Audio, движок не разрешил звук).
 * @param {string} kind вид уведомления (`notifications.js`)
 * @param {any} [settings] `state.settings`
 * @returns {Promise<boolean>}
 */
export async function playNotificationSound(kind, settings) {
  const conf = soundSettings(settings);
  if (!conf.enabled) return false;
  const ac = context();
  if (!ac) return false;
  if (ac.state === 'suspended') {
    try {
      await ac.resume();
    } catch (_) {
      return false;
    }
  }
  if (ac.state !== 'running') return false;
  // Набор берётся по виду уведомления: иначе всё звенит одинаково и быстро привыкает
  playNotes(ac, toneForKind(kind, settings), conf.volume, PROFILE_BY_KIND[kind] === 'attention');
  return true;
}

/**
 * Проиграть выбранный набор по кнопке «Послушать» в настройках.
 *
 * Отличается от `playNotificationSound` двумя вещами: слушает всегда (иначе кнопка
 * ничего не даст при выключенном звуке) и не повторяет набор — оценивать надо ровно то,
 * что услышат потом.
 *
 * С указанием вида проигрывает набор этого вида: у видов он может быть своим, и кнопка
 * «Послушать» рядом со строкой обязана звучать так же, как услышат потом.
 *
 * @param {any} [settings] `state.settings`
 * @param {string} [kind] вид уведомления; без него — общий набор
 * @returns {Promise<'played'|'no-audio'|'blocked'>}
 */
export async function previewNotificationSound(settings, kind = '') {
  const conf = soundSettings(settings);
  const ac = context();
  if (!ac) return 'no-audio';
  if (ac.state === 'suspended') {
    try {
      await ac.resume();
    } catch (_) {
      return 'blocked';
    }
  }
  if (ac.state !== 'running') return 'blocked';
  playNotes(ac, kind ? toneForKind(kind, settings) : conf.tone, conf.volume, false);
  return 'played';
}

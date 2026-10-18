// @ts-check
// js/core/constants.js


// Базовый путь к иконкам (относительно public/assets/icons/classes/)
const ICON_BASE_PATH = '/assets/icons/classes/';

export const CLASSES = [
  'Оборотень',
  'Друид',
  'Странник',
  'Воин',
  'Маг',
  'Стрелок',
  'Жрец',
  'Лучник',
  'Паладин',
  'Убийца',
  'Шаман',
  'Бард',
  'Мистик',
  'Страж',
  'Дух Крови',
  'Жнец',
  'Призрак',
  'Канглонг'
];

// Маппинг: Название класса -> Имя файла
export const CLASS_ICON_MAP = {
  'Оборотень': 'tank.webp',
  'Друид': 'dru.webp',
  'Странник': 'mk.webp',
  'Воин': 'var.webp',
  'Маг': 'mag.webp',
  'Стрелок': 'gan.webp',
  'Жрец': 'prist.webp',
  'Лучник': 'luk.webp',
  'Паладин': 'pal.webp',
  'Убийца': 'sin.webp',
  'Шаман': 'sham.webp',
  'Бард': 'bard.webp',
  'Мистик': 'mist.webp',
  'Страж': 'sik.webp',
  'Дух Крови': 'dk.webp',
  'Жнец': 'kosa.webp',
  'Призрак': 'gost.webp',
  'Канглонг': 'canglong.webp'
};

// Функция-помощник для получения URL иконки или fallback-буквы
export function getClassIconSrc(className) {
  const fileName = CLASS_ICON_MAP[className];
  if (fileName) {
    return `${ICON_BASE_PATH}${fileName}`;
  }
  return null; // Вернем null, если иконка не найдена, чтобы UI показал букву
}

/**
 * Иконка класса по имени файла без расширения (`luk` → `luk.webp`).
 * Нужен там, где класс приходит числом или именем файла, а не названием:
 * например, со стороннего сайта, где иконка лежит по тому же соглашению об именах.
 * @param {string} stem
 * @returns {string|null}
 */
export function getClassIconSrcByStem(stem) {
  const key = String(stem || '').trim();
  return /^[a-z0-9_-]+$/i.test(key) ? `${ICON_BASE_PATH}${key}.webp` : null;
}

export const SKIES = [
  'Тайное небо',
  'Небо Миражей',
  'Совершенное небо',
  'Призрачное небо',
  'Небо ясности',
  'Небо власти',
  'Небо равенства',
  'Небо идеала',
  'Небо Величия',
  'Небо предела'
];

export const SKY_LEVELS = Array.from({ length: 10 }, (_, i) => i + 1);


export const PASS_TYPES = [
  { key: 'weapon', label: 'Оружие', icon: '⚔️', img: '/assets/icons/dungeons/pass-weapon.webp' },
  { key: 'armor', label: 'Доспех', icon: '🛡️', img: '/assets/icons/dungeons/pass-armor.webp' },
  { key: 'relic', label: 'Реликвия', icon: '💎', img: '/assets/icons/dungeons/pass-relic.webp' }
];

export const DEFAULT_SETTINGS = {
  privacy: {
    maskEmailByDefault: true,
    maskPasswordByDefault: true,
    maskRecoveryEmailByDefault: true,
    maskPhoneByDefault: true
  },
  autosave: {
    enabled: true,
    debounceMs: 800
  },
  backups: {
    enabled: true,
    maxCount: 10,
    createBeforeImport: true,
    createBeforeMarathonCompletion: true
  },
  google: {
    clientId: '',
    driveEnabled: false,
    driveAutoBackup: false,
    driveLastSavedAt: null,
    sheetsEnabled: false,
    sheetsSpreadsheetId: '',
    sheetsFields: {
      nick: true,
      class: true,
      party: true,
      level: true,
      skyName: true,
      skyLevel: true,
      email: false,
      password: false,
      recoveryEmail: false,
      phone: false,
      ancientCoins: true,
      dungeonPasses: true
    }
  },
  ui: {
    theme: 'dark',
    // Вид календаря на странице «Сегодня»: компактная неделя или месяц (js/modules/dashboard/plannerView.js)
    plannerView: 'week',
    // Какие разделы показывать в меню и в каком порядке (js/core/sections.js).
    // Пусто значит «порядок по умолчанию, все видны» — список разделов и так меняется
    // с выходом новой версии, а хранить его копию значило бы забыть об этом.
    sections: { hidden: [], order: [] }
  },
  // Учётные данные — в хранилище ОС (Windows Credential Manager / Keychain), а не в state.json
  security: {
    useVault: true
  },
  // Очередь фоновых скриптов (вход, балансы)
  scripts: {
    concurrency: 3,      // одновременно открытых скрытых окон
    retries: 2,          // повторов при таймауте / «Проверке безопасности»
    retryDelayMs: 2000,
    authIntervalHours: 6 // через сколько часов повторно проверять вход автоматически (0 — только вручную)
  },
  notifications: {
    enabled: true,
    // Звук уведомлений: один выключатель на все виды, громкость — 0..100, набор нот на выбор.
    // Своих звуковых файлов нет: тон собран из колебаний через Web Audio (js/desktop/sound.js),
    // наборы — `SOUND_TONES` там же, здесь только id выбранного
    sound: { enabled: true, volume: 80, tone: 'clear' },
    // По каждому виду — где показывать и чем озвучивать:
    //   popup — всплывающее окно Windows (исчезает само, годится на «сейчас гляну»);
    //   inapp — карточка внутри приложения, стоит, пока её не закроют;
    //   sound — короткий сигнал; `tone` задаёт свой набор, без него берётся общий.
    // Список видов с подписями — `NOTIFY_KINDS` в js/desktop/notifications.js.
    // Записи нет — вид работает целиком: новые виды доступны сразу после обновления.
    kinds: {
      behind: { popup: true, inapp: true, sound: true },     // персонаж не успевает задание марафона
      tight: { popup: true, inapp: true, sound: false },     // запас задания ≤ 1 дня
      ending: { popup: true, inapp: true, sound: true },     // марафон заканчивается
      daily: { popup: true, inapp: true, sound: true },      // ежедневная сводка заданий
      event: { popup: true, inapp: true, sound: true },      // игровой ивент вот-вот начнётся
      task: { popup: true, inapp: true, sound: true },       // запись календаря скоро начнётся
      launch: { popup: true, inapp: true, sound: true },     // запуск окон игры завершён
      launchError: { popup: true, inapp: true, sound: true }, // запуск окон игры не удался
      close: { popup: true, inapp: true, sound: false }      // окна игры закрыты
    },
    dailyHour: 20,
    // Постоянные игровые ивенты: по каждому — напоминать ли и за сколько минут до начала.
    // Ключи совпадают с `id` в js/modules/dashboard/recurringEvents.js
    // (тест tests/recurringEvents.test.js следит, чтобы списки не разошлись).
    events: {
      'dynasty-battle': { enabled: true, leadMinutes: 10 },
      'guild-rhythm': { enabled: true, leadMinutes: 10 },
      'forbidden-teaching': { enabled: true, leadMinutes: 10 },
      'hero-arena': { enabled: true, leadMinutes: 10 }
    }
  },
  // Видимые окна браузера персонажей
  browser: {
    unlimitedGiftItems: true,  // на странице передачи предметов снять лимит сайта «не более 6 предметов» (панель «Типы предметов»)
    collectionPanel: true      // на странице мини-игры «Коллекция» показать панель с запуском по кнопке и статистикой (Issue #72)
  },
  // Клановый сайт (скрытая панель на «Сегодня», включается паролем в разделе промокодов).
  // У всех выключено: пока enabled=false, панели нет на странице.
  guild: {
    enabled: false
  },
  // Запуск игры (Issue: запуск окон)
  launcher: {
    notify: true,   // после запуска показать одну строку «Запущено N окон за M» (ошибки показываются всегда)
    gameCenters: [],   // GameCenter с названиями: [{ id, name, path }] (Настройки → Запуск игры → «GameCenter и персонажи»)
    preferredGcId: '', // какой GameCenter запускать в первую очередь; '' — первый из списка персонажа
    decorateWindows: true,  // после запуска назвать окно клиента «Ник — Класс» и поставить значок класса
    decorateIcons: true,    // ставить значок класса; выключено — окно получает только название «Ник — Класс»
    delaySec: 0,            // пауза между запусками окон игры, секунд (0 — без паузы). По умолчанию 0:
  // замер 10.10.2026 на трёх аккаунтах дал 30.9 с, а прежние 3 с были чистой потерей —
  // окно к этому моменту уже запущено, и ждать нечего. Если на большой пати посыплются
  // ошибки запуска, поднимите здесь до 1–2 с.
    skipRunning: true,      // не запускать персонажа, чьё окно игры уже открыто («Ник — Класс»): сразу переходить к следующему
    preflight: 'issues',    // экран проверок перед запуском: 'issues' — только при проблемах, 'always' — всегда, 'off' — никогда
    layoutDir: '',          // папка Layout игры (Настройки → Запуск игры → «Layout»)
    layoutTemplate: ''      // файл-образец layout, который копируется поверх остальных .ini в папке
  },
  tray: {
    closeToTray: false,
    backgroundAuthMinutes: 0   // 0 — выключено
  },
  // Через сколько часов данные считаются устаревшими (подсветка «3 ч назад» в профиле персонажа и на карточках марафонов)
  freshness: {
    balanceHours: 24,
    loginHours: 24,
    marathonHours: 24,
    serverStatusMinutes: 10   // как часто перечитывать «Статус серверов» (минуты; 0 — только при запуске). Сайт обновляет его раз в 10 минут
  },
  // mode: startup | daily | weekly | never (см. desktop/updateSchedule.js).
  // Если mode не задан, он выводится из checkOnStartup (старые данные).
  updates: {
    checkOnStartup: true,
    lastCheckedAt: null
  }
};

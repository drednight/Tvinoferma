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
  'Оборотень': 'tank.png',
  'Друид': 'dru.png',
  'Странник': 'mk.png',
  'Воин': 'var.png',
  'Маг': 'mag.png',
  'Стрелок': 'gan.png',
  'Жрец': 'prist.png',
  'Лучник': 'luk.png',
  'Паладин': 'pal.png',
  'Убийца': 'sin.png',
  'Шаман': 'sham.png',
  'Бард': 'bard.png',
  'Мистик': 'mist.png',
  'Страж': 'sik.png',
  'Дух Крови': 'dk.png',
  'Жнец': 'kosa.png',
  'Призрак': 'gost.png',
  'Канглонг': 'canglong.png'
};

// Функция-помощник для получения URL иконки или fallback-буквы
export function getClassIconSrc(className) {
  const fileName = CLASS_ICON_MAP[className];
  if (fileName) {
    return `${ICON_BASE_PATH}${fileName}`;
  }
  return null; // Вернем null, если иконка не найдена, чтобы UI показал букву
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
  { key: 'weapon', label: 'Оружие', icon: '⚔️', img: '/assets/icons/dungeons/pass-weapon.png' },
  { key: 'armor', label: 'Доспех', icon: '🛡️', img: '/assets/icons/dungeons/pass-armor.png' },
  { key: 'relic', label: 'Реликвия', icon: '💎', img: '/assets/icons/dungeons/pass-relic.png' }
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
    theme: 'dark'
  },
  // Учётные данные — в хранилище ОС (Windows Credential Manager / Keychain), а не в state.json
  security: {
    useVault: true
  },
  // Очередь фоновых скриптов (вход, балансы)
  scripts: {
    concurrency: 3,      // одновременно открытых скрытых окон
    retries: 2,          // повторов при таймауте / «Проверке безопасности»
    retryDelayMs: 2000
  },
  notifications: {
    enabled: true,
    marathonBehind: true,   // «не успевает» по заданиям марафона
    marathonEnding: true,   // марафон заканчивается через ≤ 2 дня, есть невыполненные задания
    dailyReminder: true,    // ежедневное напоминание о заданиях
    dailyHour: 20
  },
  // Видимые окна браузера персонажей
  browser: {
    unlimitedGiftItems: true   // на странице передачи предметов снять лимит сайта «не более 6 предметов» (панель «Типы предметов»)
  },
  // Запуск игры (Issue: запуск окон)
  launcher: {
    notify: true,   // после запуска показать одну строку «Запущено N окон за M» (ошибки показываются всегда)
    gameCenters: [],   // GameCenter с названиями: [{ id, name, path }] (Настройки → Запуск игры → «GameCenter и персонажи»)
    preferredGcId: '', // какой GameCenter запускать в первую очередь; '' — первый из списка персонажа
    decorateWindows: true,  // после запуска назвать окно клиента «Ник — Класс» и поставить значок класса
    decorateIcons: true     // ставить значок класса; выключено — окно получает только название «Ник — Класс»
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

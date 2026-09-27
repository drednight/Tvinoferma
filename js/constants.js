// js/constants.js

export const STORAGE_KEY = 'characterManagerState';
export const DATA_VERSION = 2;

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
  }
};

// ... существующий код ...

export const MARATHON_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  COMPLETED: 'completed'
};

// Дефолтная структура нового марафона
export const DEFAULT_MARATHON = {
  id: '', // Генерируется при создании
  title: '',
  description: '',
  startDate: new Date().toISOString().slice(0, 10), // Сегодня
  endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), // Через неделю
  status: MARATHON_STATUS.DRAFT,
  
  participantIds: [], 
  
  tasks: [
    // Пример одного задания
    // {
    //   id: '...',
    //   title: 'Задание 1',
    //   description: '',
    //   targetChecks: 10, // Сколько раз нужно выполнить
    //   schedule: { mode: 'everyDay', dates: [] },
    //   stages: [
    //     { id: '...', threshold: 5, rewardText: 'Малая награда', rewardCoins: 50 },
    //     { id: '...', threshold: 10, rewardText: 'Большая награда', rewardCoins: 100 }
    //   ]
    // }
  ],
  
  comboRewards: [],
  records: [], // Лог выполнения
  awards: [],  // Итоговые награды
  
  createdAt: null,
  updatedAt: null,
  completedAt: null
};
// Content widgets keep stable ids; optional items never appear without user choice.
export const WIDGET_GROUPS = [
  ['overview', 'Обзор', 'Новости, дела и показатели'],
  ['mine', 'Мои данные', 'Персонажи, пати, финансы и ближайшие дела'],
  ['actions', 'Действия', 'Быстрые сценарии приложения']
];
export const CONTENT_WIDGETS = [
  ['news', 'Новости Perfect World', 'overview', '📰', 'Последние полученные новости'],
  ['today', 'Календарь и события', 'overview', '📅', 'Данж и записи выбранного дня'],
  ['promos', 'Промокоды', 'overview', '🎁', 'Сохранённые действующие промокоды'],
  ['marathon', 'Марафон', 'overview', '🏆', 'Прогресс и задания марафона'],
  ['launch', 'Быстрый запуск', 'overview', '🚀', 'Выбор и запуск отряда'],
  ['information', 'Информационная панель', 'overview', '📊', 'Сводные показатели приложения'],
  ['clan', 'Клан', 'overview', '🛡️', 'События и состав подключённого клана'],
  ['characters', 'Персонажи', 'mine', '👥', 'Последняя проверка входа и баланса по карточкам'],
  ['parties', 'Пати', 'mine', '🧩', 'Состав пати и последняя проверка входа на сайт'],
  ['finance', 'Финансы', 'mine', '💰', 'Остатки по данным раздела «Банк»'],
  ['upcoming', 'Ближайшие события', 'mine', '🗓️', 'События и невыполненные дела на семь дней']
];
// A curated library: actions open the existing production dialogs, never run silently.
export const ACTION_WIDGETS = [
  ['script-notes', 'Блокнот', 'Личные заметки с названиями и описанием', 'notes', '📝'],
  ['script-auth', 'Проверка входа', 'Проверить авторизацию персонажей', 'check-auth', '🔐'],
  ['script-balance', 'Баланс монет', 'Обновить баланс персонажей', 'update-balance', '🪙'],
  ['script-marathons', 'Обновить марафоны', 'Получить актуальные отметки', 'update-marathons', '🏆'],
  ['script-promo', 'Активация промокодов', 'Выбрать персонажей и промокоды', 'promo', '🎁'],
  ['script-transfer', 'Передача предметов', 'Настроить передачу предметов в игру', 'transfer', '📦'],
  ['script-shop', 'Подарки', 'Открыть выбор подарков', 'shop', '🛍'],
  ['script-caravan', 'Караванщик', 'Настроить открытие сундуков', 'caravan', '🧰'],
  ['script-windows', 'Игровые окна', 'Посмотреть запущенные клиенты', 'windows', '🪟']
];
export const WIDGET_VARIANTS = [
  ['compact', 'Компактный', 300, 240],
  ['wide', 'Широкий', 640, 300],
  ['tall', 'Высокий', 340, 580]
];

export const widgetGroup = id => CONTENT_WIDGETS.find(row => row[0] === id)?.[2] || 'actions';
export const widgetIcon = id =>
  CONTENT_WIDGETS.find(row => row[0] === id)?.[3] || ACTION_WIDGETS.find(row => row[0] === id)?.[4] || '🧩';
export const widgetDescription = id =>
  CONTENT_WIDGETS.find(row => row[0] === id)?.[4] || ACTION_WIDGETS.find(row => row[0] === id)?.[2] || '';

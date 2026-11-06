// A curated library: actions open the existing production dialogs, never run silently.
export const ACTION_WIDGETS = [
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

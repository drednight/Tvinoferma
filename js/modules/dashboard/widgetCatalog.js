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
export function ensureActionWidgets(root, editing = false) {
  const board = root.querySelector('.rt-board');
  if (!board) return;
  for (const [id, title, description, action, icon] of ACTION_WIDGETS) {
    if (root.querySelector(`.rt-${id}`)) continue;
    const panel = document.createElement('section');
    panel.className = `lg-panel rt-${id} rt-action-widget`;
    panel.hidden = true;
    const heading = document.createElement('h3');
    heading.className = 'rt-heading';
    heading.textContent = `${icon} ${title}`;
    const text = document.createElement('p');
    text.textContent = description;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = action.startsWith('check-') || action.startsWith('update-') ? 'Запустить проверку' : 'Открыть';
    button.onclick = async () => {
      if (editing) return;
      button.disabled = true;
      try {
        const { createCommandRunner } = await import('../../core/commandRunner.js');
        await createCommandRunner({ switchTab: tab => document.querySelector(`.tab[data-tab="${tab}"]`)?.click() })(
          action
        );
      } finally {
        button.disabled = false;
      }
    };
    panel.append(heading, text, button);
    board.append(panel);
  }
}

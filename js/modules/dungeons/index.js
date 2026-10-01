// js/modules/dungeons/index.js
// Ежедневные данжи (Roadmap: «3. Ежедневные данжи»)
//
// Запланировано:
//  - Цикл Оружие → Доспех → Реликвия (3 дня), панель «сегодня/завтра» (schedule.js)
//  - Таблица допусков по Sky Level (skyAccess.js, SKY_LEVELS из core/constants.js)
//  - Сравнение статов с рекомендуемыми, только информация (recommendedStats.js)
//  - Уведомление о смене данжа — через js/desktop/notifications.js
//
// Модуль-заготовка: пока не подключён в main.js.

export { dungeonForDate } from './schedule.js';

// js/modules/automation/index.js
// Скрипты автоматизации (Roadmap: «2. Скрипты автоматизации»)
//
// Запланировано:
//  - Промокоды: ввод кода → активация на выбранных персонажах (promo.js)
//  - Перевод предметов: подарки с сайта → персонаж на выбранном сервере (transfer.js)
//  - Активация подарков (покупка за Древние монеты): предметы магазина подарков → выбранные аккаунты (shop.js)
//  - Сундук караванщика: открытие «Сундуков караванщика» в инвентаре выбранных персонажей (caravan.js)
//  - Все запуски — через очередь js/modules/sync/queue.js (лимит окон и ретраи)
//
// Диалоги открываются из меню «⚡ Скрипты» (js/core/uiActions.js) и из панели выбора персонажей.
// Статус и план: Issues #25 (промокоды), #26 (перевод предметов) (ROADMAP.md)

export { openPromoDialog } from './promo.js';
export { openTransferDialog } from './transfer.js';
export { openShopDialog } from './shop.js';
export { openCaravanDialog } from './caravan.js';
export { startCollectionSync, pollCollectionReports } from './collectionSync.js';

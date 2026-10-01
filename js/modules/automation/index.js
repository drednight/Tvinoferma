// js/modules/automation/index.js
// Скрипты автоматизации (Roadmap: «2. Скрипты автоматизации»)
//
// Запланировано:
//  - Промокоды: ввод кода → активация на выбранных персонажах (promo.js)
//  - Перевод предметов: отправитель/получатель + обязательный выбор сервера (transfer.js)
//  - Все запуски — через очередь js/modules/sync/queue.js (лимит окон и ретраи)
//
// Модуль-заготовка: пока не подключён в main.js.

export { openPromoDialog } from './promo.js';
export { openTransferDialog } from './transfer.js';

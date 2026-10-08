// Игра «Коллекция» в памяти: отвечает на те же запросы, что и сайт (doo=info / turn / get_item / get_next).
// Нужна тестам панели src-tauri/src/scripts/collection.js. Формат ответа info: { rows: { row1..row6 }, quantity }.
export const LIMITS = { 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 10 };

/**
 * options:
 *  - quantity: сколько карточек у игрока
 *  - rows: стартовое состояние { 1: n, … }
 *  - drops: заранее заданный порядок выпадения категорий 1–5 (6-я с карточек не падает; после конца берётся категория 1)
 *  - ignore: запросы, которые сайт «проглатывает» без изменений: ['turn', 'get_item', 'get_next']
 *  - info: подмена ответа info (строка) — для «проверки безопасности» и сломанной вёрстки
 */
export function createGameServer(options = {}) {
  const game = {
    quantity: options.quantity ?? 50,
    rows: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, ...(options.rows || {}) },
    rewards: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
    drops: [...(options.drops || [])],
    calls: [],
    ignore: new Set(options.ignore || []),
    info: options.info ?? null
  };

  const snapshot = () => JSON.stringify({
    rows: { row1: game.rows[1], row2: game.rows[2], row3: game.rows[3], row4: game.rows[4], row5: game.rows[5], row6: game.rows[6] },
    quantity: game.quantity
  });

  game.fetch = async (url, init) => {
    const u = new URL(url, window.location.href);
    const doo = u.searchParams.get('doo');
    const category = Number(u.searchParams.get('category')) || 0;
    game.calls.push({ doo, category, origin: u.origin, init });
    let body = '{}';
    if (doo === 'info') {
      body = game.info != null ? game.info : snapshot();
    } else if (doo === 'turn' && !game.ignore.has('turn') && game.quantity > 0) {
      game.quantity -= 1;
      const cat = game.drops.length ? game.drops.shift() : 1;
      if (cat < 1 || cat > 5) throw new Error('С неоткрытых карточек падают только категории 1–5, получено ' + cat);
      game.rows[cat] += 1;
    } else if (doo === 'get_item' && !game.ignore.has('get_item') && game.rows[category] >= LIMITS[category]) {
      game.rows[category] -= LIMITS[category];
      game.rewards[category] += 1;
    } else if (doo === 'get_next' && !game.ignore.has('get_next') && category < 6 && game.rows[category] >= LIMITS[category]) {
      game.rows[category] -= LIMITS[category];
      game.rows[category + 1] += 1;
    }
    return { ok: true, text: async () => body };
  };
  game.count = (doo) => game.calls.filter((c) => c.doo === doo).length;
  return game;
}

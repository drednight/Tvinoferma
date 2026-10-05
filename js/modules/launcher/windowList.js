// js/modules/launcher/windowList.js
// Список запущенных окон игры: сопоставление клиентов с персонажами и порядок строк.
//
// Заголовок окна клиента Твиноферма ставит сама (`launcher_start`: «Ник — Класс»), отдельного канала
// «какой PID какому персонажу» игра не даёт. Поэтому ник восстанавливается из заголовка, а класс — по
// списку персонажей. Если заголовок игровой (окно запущено не из Твинофермы), клиент остаётся безымянным
// и показывается как «PID 1234».
//
// Модуль без DOM и без обращения к Tauri: на вход то, что вернул Rust, и список персонажей, на выходе
// строки для таблицы. Поэтому он целиком покрыт тестами.

/** Сколько времени работает окно: «3 мин», «1 ч 20 мин». */
export function formatUptime(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} с`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${String(m % 60).padStart(2, '0')} мин`;
}

/**
 * Разбирает заголовок окна клиента: «Ник — Класс» → { nick, cls }.
 * Заголовок игры («Perfect World») ником не считается: ник должен быть непустым и осмысленным.
 * @param {string} title
 * @returns {{ nick: string, cls: string } | null}
 */
export function parseWindowTitle(title) {
  const raw = String(title || '').trim();
  if (!raw) return null;
  // Игровые заголовки и наши служебные подписи ником не являются
  if (/^(perfect world|element client|elementclient|pw|игра)/i.test(raw)) return null;
  const parts = raw.split(/\s+[—–-]\s+/);
  const nick = parts[0].trim();
  if (!nick || nick.length > 40) return null;
  return { nick, cls: (parts[1] || '').trim() };
}

/**
 * Строки списка окон: клиенты + сопоставление с персонажами.
 *
 * @param {Array<{pid: number, image?: string, startedAt?: number|null, title?: string, hwnd?: number|null, elevated?: boolean|null}>} clients ответ `launcher_running_details`
 * @param {Array<any>} characters персонажи приложения
 * @param {{ now?: number, partyIds?: string[] | null }} [opts] `partyIds` — ограничить список участниками этих пати
 * @returns {Array<{ pid: number, image: string, nick: string, cls: string, known: boolean, charId: string|null, uptimeMs: number|null, elevated: boolean|null, title: string, partyIds: string[] }>}
 */
export function windowRows(clients, characters, opts = {}) {
  const now = opts.now ?? Date.now();
  const only = opts.partyIds && opts.partyIds.length ? new Set(opts.partyIds) : null;
  const list = (characters || []).filter(c => !only || (c.partyIds || []).some(id => only.has(id)));

  // Персонаж узнаётся по нику из заголовка; класс уточняется по карточке
  const byNick = new Map();
  for (const c of list) {
    const key = String(c.nick || '').trim().toLowerCase();
    if (key && !byNick.has(key)) byNick.set(key, c);
  }

  return (clients || []).map(client => {
    const parsed = parseWindowTitle(client?.title);
    const char = parsed ? byNick.get(parsed.nick.toLowerCase()) : null;
    return {
      pid: Number(client?.pid) || 0,
      image: String(client?.image || ''),
      // Имя берём из карточки (там точный ник), иначе из заголовка; без заголовка — пустая строка
      nick: char ? String(char.nick) : (parsed?.nick || ''),
      cls: char ? String(char.class || '') : (parsed?.cls || ''),
      known: !!char,
      charId: char ? char.id : null,
      uptimeMs: client?.startedAt ? Math.max(0, now - Number(client.startedAt)) : null,
      elevated: client?.elevated ?? null,
      title: String(client?.title || ''),
      partyIds: char ? (char.partyIds || []) : []
    };
  }).sort((a, b) => {
    // Сначала узнанные окна, затем по нику; безымянные — по PID
    if (a.known !== b.known) return a.known ? -1 : 1;
    if (a.known && b.known) return a.nick.localeCompare(b.nick, 'ru');
    return a.pid - b.pid;
  });
}

/** Подпись строки: ник и класс, а для чужого окна — «PID 1234». */
export function rowLabel(row) {
  if (!row) return '';
  if (!row.nick) return `PID ${row.pid}`;
  return row.cls ? `${row.nick} — ${row.cls}` : row.nick;
}

/** Итог закрытия выбранных окон: «Закрыто 3 из 4 окон». */
export function closeSelectedText(report) {
  const found = Number(report?.found) || 0;
  const closed = Number(report?.closed) || 0;
  const failed = Number(report?.failed) || 0;
  if (report?.error) return `Не удалось закрыть окна: ${report.error}`;
  if (!found) return 'Выбранные окна уже закрыты';
  return failed ? `Закрыто ${closed} из ${found}` : `Закрыто окон: ${closed}`;
}

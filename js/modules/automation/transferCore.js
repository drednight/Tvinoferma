// js/modules/automation/transferCore.js
// Передача предметов с сайта в игру (Issue #26): чистая логика без интерфейса — список серверов, выбор получателя,
// статусы, сверка ответа сайта («История передачи») с тем, что отправили.
// Хранилище: transferStore.js. Запуск: transferRunner.js. Диалог: transfer.js.
//
// Как устроена передача: подарки лежат на аккаунте сайта (не на персонаже). «Браузер» приложения — это вход персонажа
// приложения на сайт, у одного аккаунта сайта может быть несколько таких входов. Получатель — игровой персонаж на
// выбранном сервере; серверы и персонажи страница передачи сообщает сама (переменная `shards`).

/** Получатель — значение из списка сайта: `<игровой аккаунт>_<сервер>_<персонаж>`. */
export const RECIPIENT_RE = /^\d{1,14}_\d{1,14}_\d{1,14}$/;
export const SHARD_RE = /^\d{1,8}$/;

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ru');

/** Как показывать каждый итог. */
export const STATUS_INFO = {
  success: { icon: '✅', label: 'Передано', level: 'ok' },
  partial: { icon: '⚠️', label: 'Передано не всё', level: 'warn' },
  nothing: { icon: '📭', label: 'Нечего передавать', level: 'info' },
  no_roster: { icon: '🔄', label: 'Сначала подтяните серверы и персонажей', level: 'warn' },
  no_server: { icon: '🚫', label: 'На этом сервере у аккаунта нет персонажей', level: 'warn' },
  no_recipient: { icon: '❔', label: 'Получатель не выбран — не передавалось', level: 'warn' },
  same_site: { icon: '↪️', label: 'Тот же аккаунт сайта — передаётся один раз', level: 'info' },
  dry_run: { icon: '👁', label: 'Пробный запуск: выбрано, «Передать» не нажато', level: 'info' },
  not_logged_in: { icon: '🔴', label: 'Нет входа', level: 'warn' },
  challenge: { icon: '🛡️', label: 'Нужна проверка безопасности', level: 'warn' },
  unknown: { icon: '❓', label: 'Результат не распознан — проверьте историю на сайте', level: 'warn' },
  error: { icon: '❌', label: 'Ошибка', level: 'error' },
  cancelled: { icon: '⏹', label: 'Остановлено кнопкой «Стоп» — не передавалось', level: 'info' },
  not_run: { icon: '⏭', label: 'Пропущен', level: 'info' }
};
export const statusInfo = (status) => STATUS_INFO[status] || STATUS_INFO.error;
export const rowLabel = (row) => (row?.detail && ['not_run', 'partial', 'unknown', 'success'].includes(row.status) ? `${statusInfo(row.status).label}: ${row.detail}` : statusInfo(row?.status).label);

/** Предметы ушли на сайт (даже если не все или результат неясен): повторять автоматически нельзя. */
export const isSent = (row) => !!row?.clicked;
export const isOk = (status) => status === 'success';
/** Что «Повторить» запустит снова: ничего не нажато и причина не в самом выборе. */
export const isRerunnable = (row) => !!row && !row.clicked && !row.dryRun && ['error', 'not_logged_in', 'challenge', 'cancelled', 'not_run'].includes(row.status);

/* ------------------------------------------------------------------ */
/*  Серверы и персонажи                                                 */
/* ------------------------------------------------------------------ */

/**
 * Ответ `read_transfer_page` → запись для хранилища. Лишнее отбрасывается, строки обрезаются.
 * pending: сколько предметов ждёт передачи (items), сундуков (chests — выбор награды на сайте), строк без галочки (locked).
 */
export function normalizeRoster(data, now = new Date()) {
  const shards = (Array.isArray(data?.shards) ? data.shards : [])
    .filter(s => s && SHARD_RE.test(String(s.id)))
    .map(s => ({
      id: String(s.id),
      name: squash(s.name).slice(0, 40) || `Сервер ${s.id}`,
      chars: (Array.isArray(s.chars) ? s.chars : [])
        .filter(c => c && RECIPIENT_RE.test(String(c.key)) && squash(c.name))
        .map(c => ({ key: String(c.key), name: squash(c.name).slice(0, 60), cls: squash(c.cls).slice(0, 30), level: Number(c.level) || 0 }))
    }))
    .sort(byName);
  const items = (Array.isArray(data?.items) ? data.items : [])
    .filter(i => i && squash(i.name))
    .map(i => ({ id: String(i.id ?? ''), name: squash(i.name).slice(0, 120), qty: Number(i.qty) > 0 ? Number(i.qty) : 1, until: squash(i.until).slice(0, 30), source: squash(i.source).slice(0, 120) }));
  return {
    at: now.toISOString(),
    siteId: String(data?.siteId ?? '').slice(0, 40),
    accountName: squash(data?.accountName).slice(0, 60),
    shards,
    pending: { items, chests: Number(data?.chests) || 0, locked: Number(data?.locked) || 0 }
  };
}

/**
 * Все серверы, известные по сохранённым спискам браузеров: { id, name, chars, browsers }.
 * Серверы появляются и меняются на сайте (слияния, новые), поэтому список всегда строится из того, что прочитано.
 */
export function serverList(rosters) {
  const map = new Map();
  Object.entries(rosters || {}).forEach(([charId, r]) => (r?.shards || []).forEach(s => {
    const cur = map.get(s.id) || { id: s.id, name: s.name, chars: 0, browsers: [] };
    if (String(r.at) >= String(cur.at || '')) { cur.name = s.name; cur.at = r.at; }
    cur.chars += s.chars.length;
    cur.browsers.push(charId);
    map.set(s.id, cur);
  }));
  return [...map.values()].sort(byName).map(({ at, ...s }) => s);
}

export const charsOnServer = (roster, shardId) => (roster?.shards || []).find(s => s.id === String(shardId))?.chars || [];

/**
 * Кому передавать у одного браузера на выбранном сервере.
 * Выбран получатель — ему; не выбран, но на сервере один персонаж — ему; несколько и никто не выбран — не передаём.
 * @returns {{ ok: true, char: object, auto: boolean } | { ok: false, status: 'no_roster'|'no_server'|'no_recipient' }}
 */
export function resolveRecipient(roster, shardId, pickKey) {
  if (!roster) return { ok: false, status: 'no_roster' };
  const list = charsOnServer(roster, shardId);
  if (!list.length) return { ok: false, status: 'no_server' };
  const picked = pickKey && list.find(c => c.key === pickKey);
  if (picked) return { ok: true, char: picked, auto: false };
  if (list.length === 1) return { ok: true, char: list[0], auto: true };
  return { ok: false, status: 'no_recipient' };
}

/** Сводка предметов для людей: одинаковые названия складываются («Великий метеорит ×4»). */
export function itemTotals(items) {
  const map = new Map();
  (items || []).forEach(i => map.set(i.name, (map.get(i.name) || 0) + (Number(i.qty) > 0 ? Number(i.qty) : 1)));
  return [...map.entries()].map(([name, qty]) => ({ name, qty }));
}
export const totalsText = (items, max = 6) => {
  const t = itemTotals(items);
  const line = (x) => `${x.name}${x.qty > 1 ? ` ×${x.qty}` : ''}`;
  return t.slice(0, max).map(line).join('; ') + (t.length > max ? `; … ещё ${t.length - max}` : '');
};

/**
 * План запуска: по каждому выбранному браузеру — кому, куда и сколько. Браузеры одного аккаунта сайта передают предметы
 * общие, поэтому запускается только первый из них, остальные получают `same_site`.
 * @param {Array<{id:string,nick:string}>} chars выбранные браузеры
 * @param {Record<string, object>} rosters сохранённые списки
 * @param {{ shardId: string, picks?: Record<string, Record<string,string>> }} opts
 * @returns {Array<{ char: object, run: boolean, status?: string, detail?: string, shardId: string, serverName: string, recipient?: object, auto?: boolean, pendingCount: number|null }>}
 */
export function planTransfer(chars, rosters, { shardId, picks = {} }) {
  const seenSite = new Map();
  return chars.map(char => {
    const roster = rosters?.[char.id];
    const serverName = (roster?.shards || []).find(s => s.id === String(shardId))?.name || '';
    // Сколько ждёт передачи — по сохранённому списку (может устареть); окончательно это выяснится на странице сайта
    const known = roster?.pending && !roster.pending.stale;
    const base = { char, shardId: String(shardId), serverName, pendingCount: known ? roster.pending.items.length : null };
    const rec = resolveRecipient(roster, shardId, picks?.[char.id]?.[String(shardId)]);
    if (!rec.ok) return { ...base, run: false, status: rec.status };
    const site = roster.siteId;
    if (site && seenSite.has(site)) return { ...base, run: false, status: 'same_site', detail: `как у «${seenSite.get(site)}»`, recipient: rec.char, auto: rec.auto };
    if (site) seenSite.set(site, char.nick);
    return { ...base, run: true, recipient: rec.char, auto: rec.auto };
  });
}

/* ------------------------------------------------------------------ */
/*  Ответ сайта                                                         */
/* ------------------------------------------------------------------ */

/** Строки самой новой передачи: у всех предметов одной отправки в истории одно и то же время. */
export function latestBatch(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.length ? list.filter(r => r.at === list[0].at) : [];
}

/** Время в истории — московское (UTC+3); запись «свежая», если она не старше `maxMin` минут от `now`. */
export function isFresh(at, now = new Date(), maxMin = 15) {
  const t = Date.parse(`${String(at).replace(' ', 'T')}+03:00`);
  return Number.isFinite(t) && Math.abs(now.getTime() - t) <= maxMin * 60000;
}

/**
 * Сверка: что сайт записал в «Историю передачи» и что мы отправляли.
 * Успех — только если самая новая запись свежая, получатель и сервер совпали и записей не меньше, чем предметов.
 * @param {object[]} rows строки истории
 * @param {{ count: number, char: string, server: string }} expect
 * @returns {{ status: 'success'|'partial'|'unknown', detail: string|null, rows: object[] }}
 */
export function verifyHistory(rows, expect, now = new Date()) {
  const batch = latestBatch(rows);
  if (!batch.length) return { status: 'unknown', detail: 'история передачи пуста', rows: [] };
  const at = batch[0].at;
  if (!isFresh(at, now)) return { status: 'unknown', detail: `новой записи в истории нет (последняя: ${at})`, rows: batch };
  const wrong = batch.filter(r => squash(r.char) !== squash(expect.char) || squash(r.server) !== squash(expect.server));
  if (wrong.length) return { status: 'unknown', detail: `в истории другой получатель: ${wrong[0].char || '?'} · ${wrong[0].server || '?'}`, rows: batch };
  const states = [...new Set(batch.map(r => r.status).filter(Boolean))].join(', ');
  if (batch.length < expect.count) return { status: 'partial', detail: `в истории ${batch.length} из ${expect.count} (${states}); остальное осталось на сайте`, rows: batch };
  return { status: 'success', detail: `в истории ${batch.length} зап., статус: ${states || '—'}`, rows: batch };
}

/** Строка результата без запуска (пропущено, остановлено, не выполнялось). */
export const plainRow = (plan, status, detail = null, now = new Date()) => ({
  charId: plan.char.id, nick: plan.char.nick, shardId: plan.shardId, server: plan.serverName,
  recipient: plan.recipient?.name || '', status, error: null, detail, clicked: false, dryRun: false,
  count: 0, items: [], history: [], at: now.toISOString()
});

/**
 * Строка результата из ответа Rust-команды `transfer_items` (или из ошибки вызова).
 * `submitted` превращается в success / partial / unknown сверкой с историей.
 */
export function rowFromPayload(plan, payload, error, now = new Date()) {
  const base = plainRow(plan, 'error', null, now);
  if (error || !payload) return { ...base, error: String(error?.message || error || 'no_response') };
  const row = {
    ...base,
    status: STATUS_INFO[payload.status] ? payload.status : (payload.status === 'submitted' ? 'submitted' : 'error'),
    error: payload.error || null,
    detail: payload.detail || null,
    clicked: !!payload.clicked,
    dryRun: !!payload.dryRun,
    count: Number(payload.count) || 0,
    items: (Array.isArray(payload.items) ? payload.items : []).filter(i => i && i.name).map(i => ({ name: squash(i.name).slice(0, 120), qty: Number(i.qty) > 0 ? Number(i.qty) : 1, source: squash(i.source).slice(0, 120) }))
  };
  if (row.status === 'submitted') {
    const v = verifyHistory(payload.history, { count: row.count, char: plan.recipient?.name, server: plan.serverName }, now);
    return { ...row, status: v.status, detail: v.detail, history: v.rows.slice(0, 30) };
  }
  return row;
}

/** Можно ли повторить САМИ: ничего не нажато, причина временная (сайт не ответил / проверка безопасности). */
export const TRANSIENT_ERRORS = new Set(['timeout', 'form_not_found', 'pending']);
export const isTransient = (code) => !!code && (TRANSIENT_ERRORS.has(code) || String(code).startsWith('exception_'));
export function canAutoRetry(row) {
  if (!row || row.clicked || row.dryRun) return false;
  return row.status === 'challenge' || (row.status === 'error' && isTransient(row.error));
}

/** Общий итог по набору строк. */
export function summarize(rows) {
  const count = (pred) => rows.filter(pred).length;
  const active = rows.filter(r => !r.dryRun && r.status !== 'same_site');
  return {
    total: rows.length,
    ok: count(r => r.status === 'success'),
    partial: count(r => r.status === 'partial'),
    unknown: count(r => r.status === 'unknown'),
    dry: count(r => r.status === 'dry_run'),
    skipped: count(r => ['same_site', 'nothing', 'no_roster', 'no_server', 'no_recipient', 'not_run'].includes(r.status)),
    stopped: count(r => r.status === 'cancelled'),
    failed: count(r => ['error', 'not_logged_in', 'challenge'].includes(r.status)),
    rerun: count(isRerunnable),
    items: active.filter(r => r.status === 'success' || r.status === 'partial').reduce((n, r) => n + (r.status === 'partial' ? (r.history?.length || 0) : r.count), 0)
  };
}

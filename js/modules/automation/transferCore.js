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
/** Как назвать получателя людям: у персонажа без ника на сайте имени нет. */
export const NO_NICK = 'без ника';
export const charTitle = (ch) => squash(ch?.name) || NO_NICK;
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ru');

/** Как показывать каждый итог. */
export const STATUS_INFO = {
  success: { icon: '✅', label: 'Передано', level: 'ok' },
  partial: { icon: '⚠️', label: 'Передано не всё', level: 'warn' },
  nothing: { icon: '📭', label: 'Нечего передавать', level: 'info' },
  no_roster: { icon: '🔄', label: 'Сначала подтяните серверы и персонажей', level: 'warn' },
  no_server_chosen: { icon: '🌐', label: 'Сервер не выбран — не передавалось', level: 'warn' },
  nothing_to_transfer: { icon: '🎁', label: 'Передавать нечего: подарков на аккаунте нет', level: 'info' },
  no_server: { icon: '🚫', label: 'На этом сервере у аккаунта нет персонажей', level: 'warn' },
  no_recipient: { icon: '❔', label: 'Получатель не выбран — не передавалось', level: 'warn' },
  same_site: { icon: '↪️', label: 'Тот же аккаунт сайта — передаётся один раз', level: 'info' },
  dry_run: { icon: '👁', label: 'Пробный запуск: выбрано, «Передать» не нажато', level: 'info' },
  not_logged_in: { icon: '🔴', label: 'Нет входа', level: 'warn' },
  challenge: { icon: '🛡️', label: 'Нужна проверка безопасности', level: 'warn' },
  only_other_server: { icon: '🔒', label: 'Предметы акции принимаются только на другой сервер — не передавалось', level: 'warn' },
  wrong_server: { icon: '🚫', label: 'Сайт не принял предметы: они передаются только на другой сервер', level: 'warn' },
  unknown: { icon: '❓', label: 'Результат не распознан — проверьте историю на сайте', level: 'warn' },
  error: { icon: '❌', label: 'Ошибка', level: 'error' },
  cancelled: { icon: '⏹', label: 'Остановлено кнопкой «Стоп» — не передавалось', level: 'info' },
  not_run: { icon: '⏭', label: 'Пропущен', level: 'info' }
};
export const statusInfo = (status) => STATUS_INFO[status] || STATUS_INFO.error;
export const rowLabel = (row) => (row?.detail && ['not_run', 'partial', 'unknown', 'success', 'wrong_server', 'only_other_server'].includes(row.status) ? `${statusInfo(row.status).label}: ${row.detail}` : statusInfo(row?.status).label);

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
        .filter(c => c && RECIPIENT_RE.test(String(c.key)))      // ник может быть пустым: на сайте такой персонаж показан как «(Класс, уровень:N)»
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

/** Ключ для сравнения названий серверов: регистр, «ё» и лишние пробелы не важны. */
export const serverKey = (name) => squash(name).toLowerCase().replace(/ё/g, 'е');

/**
 * Ответ `read_server_status` (страница «Статус серверов») → запись для хранилища.
 * На странице только названия и «онлайн/оффлайн»: номера серверов знает лишь страница передачи.
 */
export function normalizeStatus(data, now = new Date()) {
  const seen = new Set();
  const servers = (Array.isArray(data?.servers) ? data.servers : [])
    .map(s => ({ name: squash(s?.name).slice(0, 40), online: s?.online === true ? true : s?.online === false ? false : null }))
    .filter(s => s.name && !seen.has(serverKey(s.name)) && seen.add(serverKey(s.name)));
  return { at: now.toISOString(), servers, recommended: squash(data?.recommended).slice(0, 40) };
}

/**
 * Все серверы для выбора: { id, name, chars, browsers, online }.
 * Серверы появляются, переименовываются и сливаются, поэтому список строится из того, что прочитано с сайта:
 *  - со страницы передачи (у браузеров) — серверы с номером (`id`) и персонажами;
 *  - со страницы «Статус серверов» (`status`) — названия ВСЕХ серверов. Если номер такого сервера ещё неизвестен
 *    (ни у одного прочитанного аккаунта там нет персонажей), `id` пустой: выбрать для передачи его нельзя.
 */
export function serverList(rosters, status = null) {
  const map = new Map();
  Object.entries(rosters || {}).forEach(([charId, r]) => (r?.shards || []).forEach(s => {
    const cur = map.get(s.id) || { id: s.id, name: s.name, chars: 0, browsers: [], online: null };
    if (String(r.at) >= String(cur.at || '')) { cur.name = s.name; cur.at = r.at; }
    cur.chars += s.chars.length;
    cur.browsers.push(charId);
    map.set(s.id, cur);
  }));
  const list = [...map.values()].map(({ at, ...s }) => s);
  const extra = [];
  (status?.servers || []).forEach(st => {
    const hit = list.find(s => serverKey(s.name) === serverKey(st.name));
    if (hit) hit.online = st.online;
    else extra.push({ id: '', name: st.name, chars: 0, browsers: [], online: st.online });
  });
  return [...list, ...extra].sort(byName);
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
  // Выбор сохранён, но такого персонажа на сайте больше нет (удалён, перенесён): просим выбрать заново
  return pickKey ? { ok: false, status: 'no_recipient', stale: true } : { ok: false, status: 'no_recipient' };
}

/** Сводка предметов для людей: одинаковые названия складываются («Великий метеорит ×4»). */
export function itemTotals(items) {
  const map = new Map();
  (items || []).forEach(i => map.set(i.name, (map.get(i.name) || 0) + (Number(i.qty) > 0 ? Number(i.qty) : 1)));
  return [...map.entries()].map(([name, qty]) => ({ name, qty }));
}
/** Ключ для сравнения названий (предмета, акции): регистр, «ё» и лишние пробелы не важны. */
export const normKey = (s) => squash(s).toLowerCase().replace(/ё/g, 'е');
const qtyOf = (i) => (Number(i?.qty) > 0 ? Number(i.qty) : 1);

/**
 * Какие из отправленных предметов есть в истории сайта: сравнение по названию и количеству (каждая запись истории
 * засчитывается один раз, поэтому три одинаковых предмета требуют трёх записей).
 * @returns {{ done: object[], missing: object[] }}
 */
export function compareItems(sent, historyRows) {
  const left = new Map();
  (historyRows || []).forEach(r => { const k = `${normKey(r?.name)}|${qtyOf(r)}`; left.set(k, (left.get(k) || 0) + 1); });
  const done = [];
  const missing = [];
  (sent || []).forEach(i => {
    const k = `${normKey(i?.name)}|${qtyOf(i)}`;
    if ((left.get(k) || 0) > 0) { left.set(k, left.get(k) - 1); done.push(i); } else missing.push(i);
  });
  return { done, missing };
}

/** Предметы, которые сайт принимает только на определённый сервер (выяснено по предупреждению сайта): акция → сервер. */
export function splitByLimits(pendingItems, limits, serverName) {
  const skipped = [];
  const keep = [];
  (pendingItems || []).forEach(i => {
    const lim = i?.source ? limits?.[normKey(i.source)] : null;
    if (lim && normKey(lim) !== normKey(serverName)) skipped.push({ ...i, server: lim }); else keep.push(i);
  });
  return { keep, skipped };
}

/** Полный список «Название ×N; …». `max` нужен только там, где места мало (по умолчанию показывается всё). */
export const totalsText = (items, max = Infinity) => {
  const t = itemTotals(items);
  const line = (x) => `${x.name}${x.qty > 1 ? ` ×${x.qty}` : ''}`;
  return t.slice(0, max).map(line).join('; ') + (t.length > max ? `; … ещё ${t.length - max}` : '');
};

/**
 * План запуска: по каждому выбранному браузеру — кому, куда и сколько. Браузеры одного аккаунта сайта передают предметы
 * общие, поэтому запускается только первый из них, остальные получают `same_site`.
 * @param {Array<{id:string,nick:string}>} chars выбранные браузеры
 * @param {Record<string, object>} rosters сохранённые списки
 * @param {{ shards?: Record<string,string>, shardId?: string, picks?: Record<string, Record<string,string>>, limits?: Record<string,string> }} opts shards — сервер каждого браузера; picks — выбранные получатели по браузеру и серверу; limits — акции, которые сайт принимает только на один сервер (ключ `normKey(акция)` → сервер)
 * @returns {Array<{ char: object, run: boolean, status?: string, detail?: string, shardId: string, serverName: string, recipient?: object, auto?: boolean, pendingCount: number|null }>}
 */
export function planTransfer(chars, rosters, { shards = {}, shardId = '', picks = {}, limits = {} }) {
  const seenSite = new Map();
  return chars.map(char => {
    const roster = rosters?.[char.id];
    // Сервер выбирается у каждого браузера отдельно (shards[id браузера]); общий shardId — запасной вариант
    const sid = String(shards?.[char.id] ?? shardId ?? '');
    const serverName = (roster?.shards || []).find(s => s.id === sid)?.name || '';
    // Сколько ждёт передачи — по сохранённому списку (может устареть); окончательно это выяснится на странице сайта
    const known = roster?.pending && !roster.pending.stale;
    const base = { char, shardId: sid, serverName, pendingCount: known ? roster.pending.items.length : null };
    // Передавать нечего (проверено на сайте: подарков нет) — персонаж сразу пропускаем.
    // Серверы и персонажи при этом остаются в сохранённом списке: знание о них не устаревает.
    if (known && !roster.pending.items.length) return { ...base, run: false, status: 'nothing_to_transfer' };
    if (roster && !sid) return { ...base, run: false, status: 'no_server_chosen' };
    const rec = resolveRecipient(roster, sid, picks?.[char.id]?.[sid]);
    if (!rec.ok) return { ...base, run: false, status: rec.status, ...(rec.stale ? { detail: 'сохранённый получатель пропал с сайта — выберите заново' } : {}) };
    // Предметы акций, которые сайт принимает только на другой сервер, не отмечаются: сайт отвечает на них предупреждением
    const lim = splitByLimits(known ? roster.pending.items : [], limits, serverName);
    if (known && roster.pending.items.length && !lim.keep.length) {
      const only = [...new Set(lim.skipped.map(i => i.server))].join(', ');
      return { ...base, run: false, status: 'only_other_server', detail: `только на «${only}»`, skipped: lim.skipped, recipient: rec.char, auto: rec.auto };
    }
    base.pendingCount = known ? lim.keep.length : null;
    // Акции, которые сайт принимает только на другой сервер, не отмечаем, даже если что ждёт передачи, пока неизвестно
    const skipSources = Object.entries(limits || {}).filter(([, srv]) => normKey(srv) !== normKey(serverName)).map(([key]) => key);
    // Один аккаунт сайта в нескольких браузерах передаёт один раз, на сервер и персонажа первого из них
    const site = roster.siteId;
    if (site && seenSite.has(site)) return { ...base, run: false, status: 'same_site', detail: `как у «${seenSite.get(site)}»`, recipient: rec.char, auto: rec.auto };
    if (site) seenSite.set(site, char.nick);
    return { ...base, run: true, recipient: rec.char, auto: rec.auto, skipSources, skipped: lim.skipped };
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
 * Кроме общего вывода сравнивает предметы по названию и количеству (`expect.items`): что передано (`done`) и чего нет (`missing`).
 * @param {object[]} rows строки истории
 * @param {{ count: number, char: string, server: string, items?: object[] }} expect
 * @returns {{ status: 'success'|'partial'|'unknown', reason: 'ok'|'empty'|'stale'|'recipient'|'short', detail: string|null, rows: object[], done: object[], missing: object[] }}
 */
export function verifyHistory(rows, expect, now = new Date()) {
  const sent = expect.items || [];
  const batch = latestBatch(rows);
  if (!batch.length) return { status: 'unknown', reason: 'empty', detail: 'история передачи пуста', rows: [], done: [], missing: sent };
  const at = batch[0].at;
  if (!isFresh(at, now)) return { status: 'unknown', reason: 'stale', detail: `новой записи в истории нет (последняя: ${at})`, rows: batch, done: [], missing: sent };
  // У персонажа без ника в истории имени нет: сверяем только сервер
  const wrong = batch.filter(r => (squash(expect.char) && squash(r.char) !== squash(expect.char)) || squash(r.server) !== squash(expect.server));
  if (wrong.length) return { status: 'unknown', reason: 'recipient', detail: `в истории другой получатель: ${wrong[0].char || '?'} · ${wrong[0].server || '?'}`, rows: batch, done: [], missing: sent };
  const cmp = compareItems(sent, batch);
  const states = [...new Set(batch.map(r => r.status).filter(Boolean))].join(', ');
  if (batch.length < expect.count) {
    const miss = cmp.missing.length ? `; не найдено в истории: ${totalsText(cmp.missing)}` : '';
    return { status: 'partial', reason: 'short', detail: `в истории ${batch.length} из ${expect.count} (${states})${miss}; остальное осталось на сайте`, rows: batch, ...cmp };
  }
  return { status: 'success', reason: 'ok', detail: `в истории ${batch.length} зап., статус: ${states || '—'}`, rows: batch, done: sent, missing: [] };
}

/** Строка результата без запуска (пропущено, остановлено, не выполнялось). */
export const plainRow = (plan, status, detail = null, now = new Date()) => ({
  charId: plan.char.id, nick: plan.char.nick, shardId: plan.shardId, server: plan.serverName,
  recipient: plan.recipient ? charTitle(plan.recipient) : '', status, error: null, detail, clicked: false, dryRun: false,
  count: 0, items: [], history: [], done: [], missing: [], limited: plan.skipped || [], warning: null, limit: null, at: now.toISOString()
});

/**
 * Строка результата из ответа Rust-команды `transfer_items` (или из ошибки вызова).
 * `submitted` превращается в success / partial / unknown сверкой с историей.
 */
export function rowFromPayload(plan, payload, error, now = new Date()) {
  const base = plainRow(plan, 'error', null, now);
  if (error || !payload) return { ...base, error: String(error?.message || error || 'no_response') };
  const warning = payload.warning && typeof payload.warning === 'object' && squash(payload.warning.message)
    ? { message: squash(payload.warning.message).slice(0, 240), onlyServer: squash(payload.warning.onlyServer).slice(0, 40) } : null;
  const row = {
    ...base,
    status: STATUS_INFO[payload.status] ? payload.status : (payload.status === 'submitted' ? 'submitted' : 'error'),
    error: payload.error || null,
    detail: payload.detail || null,
    clicked: !!payload.clicked,
    dryRun: !!payload.dryRun,
    count: Number(payload.count) || 0,
    warning,
    items: (Array.isArray(payload.items) ? payload.items : []).filter(i => i && i.name).map(i => ({ name: squash(i.name).slice(0, 120), qty: qtyOf(i), source: squash(i.source).slice(0, 120) }))
  };
  if (row.status !== 'submitted') return row;

  const v = verifyHistory(payload.history, { count: row.count, char: plan.recipient?.name, server: plan.serverName, items: row.items }, now);
  const out = { ...row, status: v.status, detail: v.detail, history: v.rows.slice(0, 30), done: v.done, missing: v.missing };
  if (!warning) return out;

  // Сайт показал «Предупреждение»: часть предметов могла уйти — по истории видно, какие именно
  const why = warning.onlyServer ? `только на сервер «${warning.onlyServer}»` : warning.message;
  const nothingNew = v.reason === 'empty' || v.reason === 'stale';
  if (v.done.length && v.missing.length) {
    out.status = 'partial';
    out.detail = `передано ${v.done.length} из ${row.items.length}; не передано (${why}): ${totalsText(v.missing)}`;
  } else if (v.done.length) {
    out.status = v.status === 'unknown' ? 'unknown' : 'success';
  } else if (nothingNew && warning.onlyServer) {
    out.status = 'wrong_server';
    out.detail = `предметы можно передать только на сервер «${warning.onlyServer}»; новых записей в истории сайта нет`;
  } else {
    out.status = 'unknown';
    out.detail = warning.message;
  }
  // Запоминаем: эти акции сайт принимает только на указанный сервер (в следующий раз их не отмечаем)
  if (warning.onlyServer && v.missing.length && ['partial', 'wrong_server'].includes(out.status)) {
    const doneSources = new Set(v.done.map(i => normKey(i.source)).filter(Boolean));
    const sources = [...new Set(v.missing.map(i => squash(i.source)).filter(s => s && !doneSources.has(normKey(s))))];
    if (sources.length) out.limit = { server: warning.onlyServer, sources };
  }
  return out;
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
    wrong: count(r => r.status === 'wrong_server'),
    dry: count(r => r.status === 'dry_run'),
    skipped: count(r => ['same_site', 'nothing', 'no_roster', 'no_server', 'no_recipient', 'not_run', 'only_other_server'].includes(r.status)),
    stopped: count(r => r.status === 'cancelled'),
    failed: count(r => ['error', 'not_logged_in', 'challenge'].includes(r.status)),
    rerun: count(isRerunnable),
    items: active.filter(r => r.status === 'success' || r.status === 'partial').reduce((n, r) => n + (r.status === 'partial' ? (r.history?.length || 0) : r.count), 0)
  };
}

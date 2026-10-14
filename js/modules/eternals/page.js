// js/modules/eternals/page.js
// Скрытая панель клана под разделом «Сегодня» (клановый сайт Eternals).
// Отдельной вкладки нет: панель появляется и исчезает по флагу settings.eternals.enabled
// (см. state.js), который по умолчанию выключен у всех и переключается только пасхалкой
// в разделе промокодов.
//
// Берём из сайта только предстоящие события и «Пати в которых вы состоите».
// Обновление работает и без открытого окна, если вход на сайте уже сделан: через минуту
// после старта приложения и потом каждый день в 00:00 по Москве.

import { toast } from '../../core/ui.js';
import { escapeHtml as esc, copyToClipboard } from '../../core/utils.js';
import { isTauri } from '../../core/storage.js';
import { getClassIconSrcByStem } from '../../core/constants.js';
import { eternalsEnabled, readEternalsData, writeEternalsData } from './state.js';
import { syncClanEntries } from './plannerBridge.js';
import {
  summaryText, responseText, partyNicks, allPartyNicks, isSelfNick, RESPONSE_YES, RESPONSE_NO
} from './core.js';
import { openEternals, syncEternalsFromSite, respondToEvent } from './window.js';

/** Первая проверка после старта приложения: через минуту, чтобы не мешать запуску. */
const START_DELAY_MS = 60 * 1000;
/** Сайт применяет отметку не мгновенно: столько ждём перед перечитыванием сводки. */
const APPLY_DELAY_MS = 3000;
/** Москва — UTC+3 круглый год, перехода на летнее время нет. */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Перерисовка всего «Сегодня» — её кладёт todayView.js: нужна, когда меняется календарь. */
let refreshToday = null;

/**
 * todayView.js сообщает, как перерисовать «Сегодня» целиком.
 * Отдельная страница клана убрана, поэтому перерисовать можно только панель, а изменился
 * календарь — нужен весь экран.
 */
export function setEternalsRefresh(fn) {
  refreshToday = typeof fn === 'function' ? fn : null;
}

function renderTodayNow() {
  (refreshToday || renderEternalsToday)();
}

/** Показывает или прячет панель клана на «Сегодня» по флагу. */
export function applyEternalsVisibility() {
  renderEternalsToday();
}

/** Обработчики кнопок клана вешаются один раз на весь документ: блоки перерисовываются (календарь перезадаёт всю страницу). */
export function bindEternals() {
  if (document.body.dataset.eternalsBound) return;
  document.body.dataset.eternalsBound = 'true';
  document.addEventListener('click', onClick);
}

async function onClick(e) {
  const btn = e.target.closest('[data-eternals]');
  if (!btn || btn.disabled || !isTauri()) return;
  const act = btn.dataset.eternals;
  if (act === 'open') {
    await run(btn, async () => {
      await openEternals();
      toast('Окно клана открыто. Войдите на сайте, если ещё не входили.', 'info');
    });
  } else if (act === 'refresh') {
    await run(btn, () => syncEternals());
  } else if (act === 'respond') {
    const { event, response } = btn.dataset;
    await run(btn, () => respond(event, response));
  } else if (act === 'copy-nicks') {
    // Вне run(): перерисовка сразу стёрла бы надпись «✔ Скопировано» на кнопке.
    await copyNicks(btn);
  }
}

async function run(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(`Не удалось: ${err?.message || err}`, 'error');
  } finally {
    btn.disabled = false;
    renderEternalsToday();
  }
}

/** Понятный текст для ошибки обновления. */
function syncErrorText(error) {
  const code = String(error?.message || error);
  if (code === 'login') return 'Вход на сайте клана истёк. Нажмите «Открыть сайт клана» и войдите.';
  if (code === 'timeout') return 'Сайт клана не ответил вовремя. Попробуйте позже.';
  if (code === 'busy') return 'Обновление уже идёт.';
  return `Не удалось обновить сводку: ${code}`;
}

/**
 * Обновляет сводку и сохраняет её. Возвращает true при успехе.
 * `silent` — для проверки по расписанию: без сообщений об ошибке.
 */
async function syncEternals({ silent = false } = {}) {
  let report;
  try {
    report = await syncEternalsFromSite();
  } catch (error) {
    if (!silent) toast(syncErrorText(error), 'warning');
    return false;
  }
  await writeEternalsData(report);
  if (!silent) toast('Сводка обновлена', 'success');
  return true;
}

/** Обновление по расписанию: молча, только при включённой панели клана. */
async function autoSync() {
  if (!isTauri() || !eternalsEnabled()) return;
  if (!(await syncEternals({ silent: true }))) return;
  if (await syncClanEntries(readEternalsData())) renderTodayNow();
  else renderEternalsToday();
}

/** Миллисекунд до ближайшей полуночи по Москве. */
export function msToMskMidnight(now = Date.now()) {
  const shifted = now + MSK_OFFSET_MS;
  return (Math.floor(shifted / DAY_MS) + 1) * DAY_MS - shifted;
}

/** Ключ московских суток: чтобы таймер не сработал дважды на одной и той же полночи. */
function mskDayKey(now = Date.now()) {
  return new Date(now + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

let midnightTimer = null;

/**
 * Ставит таймер на ближайшую полночь по Москве, а после срабатывания перезаряжает на
 * следующую: проверка приходится ровно на 00:00 МСК, а не «раз в сутки от момента запуска».
 * Если сработал с опозданием (компьютер спал) или на миллисекунду раньше, ключ суток
 * не даёт обновиться дважды за одну полночь.
 */
function scheduleMidnightSync() {
  if (midnightTimer) clearTimeout(midnightTimer);
  const day = mskDayKey();
  midnightTimer = setTimeout(async () => {
    if (mskDayKey() !== day) await autoSync();
    scheduleMidnightSync();
  }, Math.max(msToMskMidnight(), 1000));
}

/** Обновление по расписанию: один раз через минуту после старта и потом каждый день в 00:00 МСК. */
export function startEternalsDailySync() {
  setTimeout(autoSync, START_DELAY_MS);
  scheduleMidnightSync();
}

/** Понятный текст для ошибки отметки на событии. */
function respondErrorText(error) {
  const code = String(error?.message || error);
  if (code === 'login') return 'Нужно авторизоваться: откройте сайт клана и войдите.';
  if (code === 'timeout') return 'Сайт клана не ответил вовремя. Попробуйте ещё раз.';
  if (code === 'busy') return 'Сейчас идёт обновление сводки — попробуйте через пару секунд.';
  return `Не удалось отметиться на событие: ${code}`;
}

/**
 * Отмечает ивент на сайте и молча обновляет всё, что из этого следует.
 *
 * Надписи об успехе нет: ответ виден по самому событию — «Пойду» станет синим, «Не пойду»
 * красным, а отмеченное событие — записью в календаре. Говорим только когда что-то сломалось
 * или понадобился вход на сайт.
 */
async function respond(eventId, response) {
  let result;
  try {
    result = await respondToEvent(eventId, response);
  } catch (error) {
    toast(respondErrorText(error), 'warning');
    return;
  }
  if (!result?.ok) {
    toast(result?.message || 'Сайт не принял отметку', 'error');
    return;
  }
  // Сайт применяет отметку не мгновенно: ждём и перечитываем сводку по-настоящему,
  // чтобы календарь и панель показали то, что реально записалось.
  await new Promise((resolve) => setTimeout(resolve, APPLY_DELAY_MS));
  const fresh = await syncEternals({ silent: true });
  const data = readEternalsData();
  if (!fresh) {
    // Перечитать не вышло: показываем то, что подтвердил сайт, чтобы отметка не «откатилась».
    data.events = data.events.map(ev => (ev.id === String(eventId) ? { ...ev, response } : ev));
    await writeEternalsData(data);
  }
  if (await syncClanEntries(data)) renderTodayNow();
  else renderEternalsToday();
}

/**
 * Копирует ники одной строкой через пробел — ровно так же, как кнопка «Копировать» на сайте:
 * с решёткой и в его порядке. Без `data-party` копируются ники всех пати, иначе — указанной.
 * Свой ник с сайта в список не попадает.
 */
async function copyNicks(btn) {
  const data = readEternalsData();
  const only = btn.dataset.party;
  const party = only ? data.parties.find(p => p.name === only) : null;
  if (only && !party) {
    toast('Пати не найдена в свежей сводке', 'warning');
    return;
  }
  const nicks = party ? partyNicks(party, data.selfNick) : allPartyNicks(data);
  if (!nicks.length) {
    toast('Копировать нечего', 'warning');
    return;
  }
  const ok = await copyToClipboard(nicks.join(' '));
  toast(ok ? `Скопировано ников: ${nicks.length}` : 'Не удалось скопировать ники', ok ? 'success' : 'error');
}

/**
 * Список ивентов с кнопками отметки. Показываем все: ответивший ивент не исчезает, а меняет
 * вид — «Пойду» подсвечивается синим градиентом, «Не пойду» приглушается.
 */
function eventsHtml(data) {
  const list = data.events || [];
  if (!list.length) return '<p class="muted">Предстоящих событий нет.</p>';
  const rows = list.map(ev => {
    const going = ev.response === RESPONSE_YES;
    const out = ev.response === RESPONSE_NO;
    return `
    <div class="eternals-event${going ? ' is-going' : ''}${out ? ' is-out' : ''}">
      <div class="eternals-event-main">
        <b>${esc(ev.title)}</b> <span class="muted">${esc(ev.when)}</span>
        ${ev.comment ? `<div class="muted">${esc(ev.comment)}</div>` : ''}
      </div>
      <div class="eternals-event-actions">
        <span class="eternals-state">${esc(responseText(ev.response))}</span>
        <button class="btn small ${going ? 'primary' : 'secondary'}" type="button"
                data-eternals="respond" data-event="${esc(ev.id)}" data-response="yes">Пойду</button>
        <button class="btn small ${out ? 'danger' : 'ghost'}" type="button"
                data-eternals="respond" data-event="${esc(ev.id)}" data-response="no">Не пойду</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="eternals-events">${rows}</div>`;
}

/** Один участник пати: иконка класса и ник. Свой ник помечен — в копирование он не идёт. */
function memberHtml(member, selfNick) {
  const icon = getClassIconSrcByStem(member.cls);
  const ico = icon ? `<img class="eternals-member-ico" src="${esc(icon)}" alt="" loading="lazy">` : '';
  const self = isSelfNick(member.nick, selfNick) ? ' is-self' : '';
  return `<span class="eternals-member${self}" title="${esc(member.title || member.nick)}">${ico}<span>${esc(member.nick)}</span></span>`;
}

function partyHtml(party, selfNick) {
  const nicks = partyNicks(party, selfNick);
  return `
    <div class="eternals-party">
      <div class="eternals-party-head">
        <b>${esc(party.name)}</b>
        <span class="muted">${party.members.length}</span>
        <button class="btn ghost small" type="button" data-eternals="copy-nicks" data-party="${esc(party.name)}"
                title="Скопировать ники пати"${nicks.length ? '' : ' disabled'}>📋</button>
      </div>
      <div class="eternals-members">${party.members.map(m => memberHtml(m, selfNick)).join('')}</div>
    </div>`;
}

/** Пати с составом: у каждой своя кнопка копирования ников. */
function partiesHtml(data) {
  if (!data.parties.length) return '<p class="muted">Пати нет.</p>';
  return `
    <div class="eternals-parties-head">
      <b>Пати</b>
      <span class="muted">${data.parties.length} пати</span>
    </div>
    <div class="eternals-parties">${data.parties.map(p => partyHtml(p, data.selfNick)).join('')}</div>`;
}

/** Блок под «Сегодня»: сводка и две колонки — события слева, пати справа. */
export function renderEternalsToday() {
  const box = document.getElementById('eternals-today');
  if (!box) return;
  if (!eternalsEnabled()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const data = readEternalsData();
  const summary = summaryText(data);
  const events = data.syncedAt
    ? eventsHtml(data)
    : '<p class="muted">Сводки ещё нет. Нажмите «Обновить»; если сайт попросит вход, откройте его и войдите.</p>';
  box.innerHTML = `
    <section class="eternals-card">
      <header class="eternals-card-head">
        <b>Клан Eternals</b>
        <span class="muted">${summary ? esc(summary) : 'сводка ещё не получена'}</span>
        <button class="btn ghost small" type="button" data-eternals="refresh">↻ Обновить</button>
        <button class="btn ghost small" type="button" data-eternals="open">Открыть сайт</button>
      </header>
      <div class="eternals-cols">
        <div class="eternals-col">${events}</div>
        <div class="eternals-col eternals-col--parties">${partiesHtml(data)}</div>
      </div>
    </section>`;
}

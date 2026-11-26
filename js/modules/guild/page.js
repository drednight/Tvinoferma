import { backgroundTask } from '../../core/backgroundTask.js';
import { openWebLink } from '../../core/linkBrowser.js';
// js/modules/guild/page.js
// Скрытая панель клана под разделом «Сегодня» (клановый сайт Guild).
// Отдельной вкладки нет: панель появляется и исчезает по флагу settings.guild.enabled
// (см. state.js), который по умолчанию выключен у всех и переключается только пасхалкой
// в разделе промокодов.
//
// Берём с сайта предстоящие события, «Пати в которых вы состоите» и активный опрос.
// Обновление работает и без открытого окна, если вход на сайте уже сделан: через минуту
// после старта приложения и потом каждый день в 00:00 по Москве.

import { toast } from '../../core/ui.js';
import { escapeHtml as esc, copyToClipboard } from '../../core/utils.js';
import { isTauri, assertStateWriteAvailable } from '../../core/storage.js';
import { getClassIconSrcByStem, getClassIconSrc, CLASSES } from '../../core/constants.js';
import { createResponseQueue } from './responseQueue.js';
import { createPollVoteQueue } from './pollVoteQueue.js';
import {
  setGuildLeaderOverride,
  readPendingResponses,
  writePendingResponses,
  readPendingPollVotes,
  writePendingPollVotes,
  guildEnabled,
  readGuildData,
  writeGuildData
} from './state.js';
import { syncClanEntries } from './plannerBridge.js';
import { summaryText, responseText, partyNicks, allPartyNicks, isSelfNick, RESPONSE_YES, RESPONSE_NO } from './core.js';
import { openGuild, syncGuildFromSite, respondToEvent, respondToEvents, voteInGuildPoll } from './window.js';
import { guildPollHtml, safePollLink, withPendingPollState } from './poll.js';

/** Первая проверка после старта приложения: через минуту, чтобы не мешать запуску. */
const START_DELAY_MS = 60 * 1000;
/** Москва — UTC+3 круглый год, перехода на летнее время нет. */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Перерисовка всего «Сегодня» — её кладёт todayView.js: нужна, когда меняется календарь. */
let refreshToday = null;
let backgroundStarted = false;
/** Окно клана было поднято приложением ради входа — после успешного входа его стоит спрятать. */
let loginPromptShown = false;
function writesAvailable() {
  try {
    assertStateWriteAvailable();
    return true;
  } catch {
    return false;
  }
}

/**
 * todayView.js сообщает, как перерисовать «Сегодня» целиком.
 * Отдельная страница клана убрана, поэтому перерисовать можно только панель, а изменился
 * календарь — нужен весь экран.
 */
export function setGuildRefresh(fn) {
  refreshToday = typeof fn === 'function' ? fn : null;
}

function renderTodayNow() {
  (refreshToday || renderGuildToday)();
}

/** Показывает или прячет панель клана на «Сегодня» по флагу. */
export function applyGuildVisibility() {
  if (backgroundStarted) {
    responses.resume();
    pollVotes.resume();
  }
  renderTodayNow();
}

/** Обработчики кнопок клана вешаются один раз на весь документ: блоки перерисовываются (календарь перезадаёт всю страницу). */
export function bindGuild() {
  if (document.body.dataset.guildBound) return;
  document.body.dataset.guildBound = 'true';
  document.addEventListener('click', onClick);
  document.addEventListener('change', onLeaderChange);
}

async function onLeaderChange(e) {
  const select = e.target.closest?.('[data-guild-leader]');
  if (!select || !writesAvailable()) return;
  select.disabled = true;
  try {
    await setGuildLeaderOverride(select.dataset.guildLeader, select.value);
    renderTodayNow();
  } catch {
    toast('Не удалось сохранить ПЛ для подсветки', 'error');
    renderTodayNow();
  }
}

async function onClick(e) {
  const link = e.target.closest?.('a[data-guild-poll-link]');
  if (link && isTauri()) {
    e.preventDefault();
    const url = safePollLink(link.href);
    if (!url) return;
    try {
      await openWebLink(url);
    } catch {
      toast('Не удалось открыть ссылку в браузере', 'error');
    }
    return;
  }
  const btn = e.target.closest('[data-guild]');
  if (!btn || btn.disabled || !isTauri()) return;
  touchGuildResponses();
  const act = btn.dataset.guild;
  if (act === 'open') {
    await run(btn, async () => {
      await openGuild();
      toast('Окно клана открыто. Войдите на сайте, если ещё не входили.', 'info');
      // Не блокируем кнопку: синхронизируем в фоне с повтором — чтобы после входа
      // сводка и опросы обновились сразу, без ручного нажатия «Обновить».
      syncGuild({ retries: 3 }).catch(() => {});
    });
  } else if (act === 'refresh') {
    await run(btn, () => syncGuild());
  } else if (act === 'respond') {
    const { event, response } = btn.dataset;
    await run(btn, () => respond(event, response));
  } else if (act === 'poll-toggle') {
    // Многовариантный опрос: кнопка варианта переключает выбор локально,
    // голос уходит кнопкой «Голосовать выбранными».
    togglePollOption(btn);
  } else if (act === 'poll-vote') {
    // Нажатие на вариант — выбор ставится сразу локально (оптимизм), а голос
    // отправляется через паузу фоновым шагом очереди, как у ответов на события.
    const pollId = btn.dataset.poll;
    const data = readGuildData();
    const poll = data.polls.find(p => p.id === String(pollId));
    if (poll?.type === 'multiple' && !btn.dataset.option) {
      await run(btn, () => enqueuePollVote(pollId, selectedPollOptions(btn), poll));
    } else {
      await run(btn, () => enqueuePollVote(pollId, [btn.dataset.option], poll));
    }
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
    renderTodayNow();
  }
}

/**
 * Переключивает вариант многовариантного опроса в локальном контексте кнопки.
 * Перерисовка не нужна: кнопки переключают aria-pressed и класс, а статус
 * читается из кнопок при отправке.
 */
function togglePollOption(btn) {
  const pollId = btn.dataset.poll;
  const optionId = btn.dataset.option;
  if (!pollId || !optionId) return;
  const pressed = btn.getAttribute('aria-pressed') === 'true';
  btn.setAttribute('aria-pressed', String(!pressed));
  btn.classList.toggle('primary', !pressed);
  btn.classList.toggle('secondary', pressed);
  const submit = btn.closest('.guild-poll')?.querySelector('.guild-poll-submit button');
  if (submit) submit.disabled = !selectedPollOptions(btn);
}

/** Варианты, переключённые внутри кнопки-опроса (multiple). */
function selectedPollOptions(btn) {
  const poll = btn.closest('.guild-poll');
  if (!poll) return [];
  return [...poll.querySelectorAll('.guild-poll-options button[data-guild="poll-toggle"][aria-pressed="true"]')]
    .map(option => option.dataset.option)
    .filter(Boolean);
}

/**
 * Валидирует выбор по кэшу сводки (только список polls.php) и отдаёт голос в
 * очередь: выбор показывается сразу, отправка на сайт — фоновый шаг после паузы,
 * как у ответов на события. Опрос и варианты перепроверяет сам сайт при отправке.
 */
async function enqueuePollVote(pollId, optionIds, poll) {
  const data = readGuildData();
  const current = poll || data.polls.find(p => p.id === String(pollId));
  if (!current || current.loadError) {
    toast('Опрос изменился. Обновите сводку клана.', 'warning');
    return;
  }
  const selected = (optionIds || []).map(String).filter(Boolean);
  if (!selected.length) {
    toast('Выберите вариант ответа.', 'warning');
    return;
  }
  const available = new Set(current.options.map(option => option.id));
  if (selected.some(id => !available.has(id)) || (current.type !== 'multiple' && selected.length !== 1)) {
    toast('Варианты опроса изменились. Обновите сводку клана.', 'warning');
    return;
  }
  try {
    await pollVotes.enqueue(pollId, selected);
    toast('Голос записан, отправка через пару секунд.', 'info');
  } catch {
    toast('Не удалось сохранить голос. Нажмите вариант для повтора.', 'warning');
  }
}

/** Понятный текст для ошибки обновления. */
function syncErrorText(error) {
  const code = String(error?.message || error);
  if (code === 'login')
    return 'Сессия окна клана в приложении не активна. Откройте сайт клана через приложение и войдите на нём.';
  if (code === 'timeout') return 'Сайт клана не ответил вовремя. Попробуйте позже.';
  if (code === 'busy') return 'Обновление уже идёт.';
  return `Не удалось обновить сводку: ${code}`;
}

/**
 * Обновляет сводку и сохраняет её. Возвращает true при успехе.
 * `silent` — для проверки по расписанию: без сообщений об ошибке.
 * При `login`/`page` повторяет попытку: сессия окна клана может ещё не установиться,
 * пока пользователь входит — тогда сводка и опросы появятся сразу, без ручного «Обновить».
 */
export async function syncGuild({ silent = false, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let report;
    try {
      report = await syncGuildFromSite();
    } catch (error) {
      const code = String(error?.message || error);
      if ((code === 'login' || code === 'page') && attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 4000));
        continue;
      }
      if (code === 'login' && !loginPromptShown) {
        // Сессия окна клана не активна: поднимаем видимое окно, чтобы пользователь
        // вошёл один раз. После входа окно остаётся открытым, скрытое для обмена
        // делит с ним профиль и получает сессию.
        loginPromptShown = true;
        await openGuild().catch(() => {});
      }
      if (!silent) toast(syncErrorText(error), 'warning');
      return false;
    }
    if (!writesAvailable()) return false;
    await writeGuildData(report);
    await responses.reconcile(report);
    await pollVotes.reconcile(report);
    // Вход выполнен: сбросим отметку, чтобы при истёкшей сессии снова поднять окно.
    loginPromptShown = false;
    if (!silent) toast('Сводка обновлена', 'success');
    return true;
  }
}

/** Обновление по расписанию: молча, только при включённой панели клана. */
export async function autoSync() {
  if (!isTauri() || !guildEnabled() || !writesAvailable()) return;
  const journal = backgroundTask('Обновление клана');
  try {
    if (!(await syncGuild({ silent: true }))) {
      journal.finish('Сводка клана не обновлена.', 'warn');
      return;
    }
    await syncClanEntries(readGuildData());
    renderTodayNow();
    journal.finish('Сводка и события клана обновлены.');
  } catch (error) {
    journal.finish('Не удалось обновить клан.', 'error');
    throw error;
  }
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
  midnightTimer = setTimeout(
    async () => {
      if (mskDayKey() !== day) await autoSync();
      scheduleMidnightSync();
    },
    Math.max(msToMskMidnight(), 1000)
  );
}

/** Обновление по расписанию: один раз через минуту после старта и потом каждый день в 00:00 МСК. */
export function startGuildDailySync() {
  backgroundStarted = true;
  responses.resume();
  pollVotes.resume();
  setTimeout(autoSync, START_DELAY_MS);
  scheduleMidnightSync();
}

/** Поднимает окно клана один раз, чтобы пользователь вошёл. После входа окно скроется
 *  (но останется живым), и отметки уйдут автоматически. */
function promptGuildLogin() {
  if (loginPromptShown) return;
  loginPromptShown = true;
  openGuild().catch(() => {});
}

const responses = createResponseQueue({
  getEntries: readPendingResponses,
  saveEntries: writePendingResponses,
  enabled: () => isTauri() && guildEnabled() && writesAvailable(),
  changed: renderTodayNow,
  send: respondToEvent,
  sendBatch: respondToEvents,
  read: async () => {
    const report = await syncGuildFromSite();
    if (!writesAvailable()) throw new Error('protected');
    await writeGuildData(report);
    await syncClanEntries(readGuildData());
    renderTodayNow();
    return report;
  },
  onLogin: promptGuildLogin,
  begin: async () => {
    const { startTask } = await import('../../core/taskLog.js');
    return startTask('Переносятся ответы в кланер');
  }
});

/** Очередь голосов в опросы: выбор показывается сразу, отправка — фоновый шаг. */
const pollVotes = createPollVoteQueue({
  getEntries: readPendingPollVotes,
  saveEntries: writePendingPollVotes,
  enabled: () => isTauri() && guildEnabled() && writesAvailable(),
  changed: renderTodayNow,
  send: voteInGuildPoll,
  read: async () => {
    const report = await syncGuildFromSite();
    if (!writesAvailable()) throw new Error('protected');
    await writeGuildData(report);
    await syncClanEntries(readGuildData());
    renderTodayNow();
    return report;
  },
  onLogin: promptGuildLogin,
  begin: async () => {
    const { startTask } = await import('../../core/taskLog.js');
    return startTask('Переносятся голоса в опросы');
  }
});

/** Immediate local choice. Confirmation is deliberately a separate background step. */
export async function respond(eventId, response) {
  try {
    return await responses.enqueue(eventId, response);
  } catch {
    toast('Не удалось сохранить ответы. Нажмите выбранный ответ для повтора.', 'warning');
    return false;
  }
}
export const touchGuildResponses = () => {
  responses.touch();
  pollVotes.touch();
};

/**
 * Копирует ники одной строкой через пробел — ровно так же, как кнопка «Копировать» на сайте:
 * с решёткой и в его порядке. Без `data-party` копируются ники всех пати, иначе — указанной.
 * Свой ник с сайта в список не попадает.
 */
async function copyNicks(btn) {
  const data = readGuildData();
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
  const rows = list
    .map(ev => {
      // Сайт — источник истины: при определённом ответе с сайта (yes/no) показываем его,
      // а не локальное pending-намерение. Pending переживает только при отсутствии
      // ответа на сайте, пока идёт перенос на сайт.
      const siteDefinite = ev.response === RESPONSE_YES || ev.response === RESPONSE_NO;
      const pending = siteDefinite ? null : readPendingResponses().find(row => row.eventId === ev.id);
      const response = pending?.response || ev.response;
      const going = response === RESPONSE_YES;
      const out = response === RESPONSE_NO;
      return `
    <div class="guild-event${going ? ' is-going' : ''}${out ? ' is-out' : ''}">
      <div class="guild-event-main">
        <b>${esc(ev.title)}</b> <span class="muted">${esc(ev.when)}</span>
        ${ev.comment ? `<div class="muted">${esc(ev.comment)}</div>` : ''}
      </div>
      <div class="guild-event-actions">
        <span class="guild-state">${esc(pending ? (pending.failed ? 'Не подтверждено · нажмите ответ для повтора' : 'Ожидает переноса на сайт') : responseText(ev.response))}</span>
        <button class="btn small ${going ? 'primary' : 'secondary'}" type="button"
                data-guild="respond" data-event="${esc(ev.id)}" data-response="yes">Пойду</button>
        <button class="btn small ${out ? 'danger' : 'ghost'}" type="button"
                data-guild="respond" data-event="${esc(ev.id)}" data-response="no">Не пойду</button>
      </div>
    </div>`;
    })
    .join('');
  return `<div class="guild-events">${rows}</div>`;
}

/** Один участник пати: иконка класса и ник. Свой ник помечен — в копирование он не идёт. */
function memberHtml(member, selfNick) {
  const className = CLASSES.find(
    name =>
      name.toLowerCase() ===
      String(member.title || '')
        .trim()
        .toLowerCase()
  );
  const icon = (className && getClassIconSrc(className)) || getClassIconSrcByStem(member.cls);
  const ico = icon ? `<img class="guild-member-ico" src="${esc(icon)}" alt="" loading="lazy">` : '';
  const self = isSelfNick(member.nick, selfNick) ? ' is-self' : '';
  return `<span class="guild-member${self}${member.leader ? ' is-leader' : ''}" title="${esc((member.title || member.nick) + (member.leader ? (member.localLeader ? ' · ПЛ для подсветки: выбран вручную' : ' · ПЛ пати: отметка сайта') : ''))}">${ico}<span>${esc(member.nick)}</span>${member.leader ? '<span class="guild-leader-label" aria-label="ПЛ пати">ПЛ</span>' : ''}</span>`;
}

function partyHtml(party, selfNick, overrides = [], unique = true) {
  const override = unique
    ? overrides.find(row => row.party === party.name && party.members.some(member => member.nick === row.nick))?.nick
    : '';
  const hasSiteLeader = party.members.some(member => member.leader);
  const nicks = partyNicks(party, selfNick);
  return `
    <div class="guild-party">
      <div class="guild-party-head">
        <b>${esc(party.name)}</b>
        <span class="muted">${party.members.length}</span>
        <button class="btn ghost small" type="button" data-guild="copy-nicks" data-party="${esc(party.name)}"
                title="Скопировать ники пати"${nicks.length ? '' : ' disabled'}>📋</button>
      </div>
      <div class="guild-members">${party.members.map(m => memberHtml(override ? { ...m, leader: m.nick === override, localLeader: m.nick === override } : m, selfNick)).join('')}</div>
      ${unique ? `<details class="guild-leader-settings"><summary>${override ? 'ПЛ для подсветки выбран вручную' : hasSiteLeader ? 'ПЛ получен с сайта' : 'Сайт не передал отметку ПЛ — указать вручную'}</summary><label>ПЛ для подсветки<select data-guild-leader="${esc(party.name)}"><option value="">По отметке сайта</option>${party.members.map(member => `<option value="${esc(member.nick)}" ${member.nick === override ? 'selected' : ''}>${esc(member.nick)}</option>`).join('')}</select></label><small>Только отображение в приложении. Не меняет сайт, игровые команды или ПЛ в настройках повтора.</small></details>` : ''}
    </div>`;
}

/** Пати с составом: у каждой своя кнопка копирования ников. */
function partiesHtml(data) {
  if (!data.parties.length) return '<p class="muted">Пати нет.</p>';
  return `
    <div class="guild-parties-head">
      <b>Пати</b>
      <span class="muted">${data.parties.length} пати</span>
    </div>
    <div class="guild-parties">${data.parties.map(p => partyHtml(p, data.selfNick, data.leaderOverrides, data.parties.filter(other => other.name === p.name).length === 1)).join('')}</div>`;
}

/** Список открытых опросов со страницы polls.php: все, в которые можно проголосовать. */
function pollsHtml(data) {
  const polls = withPendingPollState(data.polls || [], readPendingPollVotes());
  if (!polls.length) return '';
  return `
    <section class="guild-polls" aria-labelledby="guild-polls-title">
      <h3 id="guild-polls-title">Опросы</h3>
      <p class="muted guild-polls-hint">Только открытые опросы с сайта клана.</p>
      ${polls.map(poll => guildPollHtml(poll)).join('')}
    </section>`;
}

/** Блок под «Сегодня»: сводка и две колонки — события слева, пати справа. */
export function renderGuildToday() {
  const box = document.getElementById('guild-today');
  if (!box) return;
  if (!guildEnabled()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const data = readGuildData();
  const summary = summaryText(data);
  const events = data.syncedAt
    ? eventsHtml(data)
    : '<p class="muted">Сводки ещё нет. Нажмите «Обновить»; если сайт попросит вход, откройте его и войдите.</p>';
  box.innerHTML = `
    <section class="guild-card">
      <header class="guild-card-head">
        <b>Клан Eternals</b>
        <span class="muted">${summary ? esc(summary) : 'сводка ещё не получена'}</span>
        <button class="btn ghost small" type="button" data-guild="refresh">↻ Обновить</button>
        <button class="btn ghost small" type="button" data-guild="open">Открыть сайт</button>
      </header>
      <div class="guild-cols">
        <div class="guild-col">${events}</div>
        <div class="guild-col guild-col--parties">${partiesHtml(data)}</div>
      </div>
      ${pollsHtml(data)}
    </section>`;
}

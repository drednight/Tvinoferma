// js/modules/marathons/siteSync.js
// Связь марафонов с сайтом pwonline.ru: поиск марафонов, разбор страницы, сверка прогресса.
// События Rust оборачиваются в Promise, чтобы с ними было удобно работать из интерфейса.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { applySiteQuests } from './model.js';
import { startTask, errorText } from '../../core/taskLog.js';
import { recordParserResult, classifyErrors } from '../../core/parserHealth.js';
import { parseNewsHtml } from './newsParser.js';
import { parseNewsList, mergeNewsPages, newsListUrl, NEWS_LIST_PAGES } from './newsList.js';
import { runQueue, browserSlots, isRetryableCode } from '../sync/queue.js';

export const SITE_PAGES = [
  { url: 'https://pwonline.ru/supermarathon.php', label: 'supermarathon.php' },
  { url: 'https://pwonline.ru/supermarathon2.php', label: 'supermarathon2.php' }
];

const CHAR_TIMEOUT_MS = 45000;

let listenersReady = false;
let titlesWaiter = null;
let detailWaiter = null;
let progressHandler = null;
let newsWaiter = null;
const charWaiters = new Map(); // charId -> resolve

export async function initSiteListeners() {
  if (listenersReady || !window.__TAURI_INTERNALS__) return;
  listenersReady = true;

  await listen('scan-progress-update', (e) => progressHandler?.(e.payload));
  await listen('marathon-titles-scanned-global', (e) => {
    const w = titlesWaiter; titlesWaiter = null; w?.(e.payload);
  });
  await listen('single-marathon-parsed-global', (e) => {
    const w = detailWaiter; detailWaiter = null; w?.(e.payload);
  });
  await listen('marathon-news-parsed-global', (e) => {
    const w = newsWaiter; newsWaiter = null; w?.(e.payload);
  });
}

/** Персонаж, чей профиль используется для поиска (нужна авторизация на сайте). */
export function pickScannerCharacter() {
  return state.characters.find(c => c.isLoggedIn === true) || null;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms))]);
}

/** Свои страницы марафонов, добавленные пользователем (ищутся вместе со стандартными). */
export function customPages() {
  return (state.settings?.customMarathonPages || []).filter(u => typeof u === 'string' && u.startsWith('http'));
}
export function rememberCustomPage(url) {
  if (!url || SITE_PAGES.some(p => p.url === url)) return;
  if (!state.settings) state.settings = {};
  const list = state.settings.customMarathonPages || [];
  if (!list.includes(url)) state.settings.customMarathonPages = [...list, url];
}

/** Ищет марафоны на стандартных и своих страницах. → { titles: [{name,url}], errors: [], task } */
export async function scanTitles(onProgress, { dock = false, onTask } = {}) {
  const scanner = pickScannerCharacter();
  const extra = customPages();
  const task = startTask('🔍 Поиск марафонов на сайте', { dock, total: 100 }).watch('scan');
  await task.waitTurn();      // в доке — ждём очереди, вне дока (мастер) ждать нечего
  onTask?.(task);
  task.log(scanner ? `Профиль для поиска: ${scanner.nick} (вход выполнен)` : 'Нет персонажа со входом — сайт может не показать марафон', scanner ? 'info' : 'warn');
  task.log(`Страницы: ${[...SITE_PAGES.map(p => p.label), ...extra].join(', ')}`);
  progressHandler = (p) => { task.progress(p.percent ?? task.done, 100, p.message); onProgress?.(p); };
  const wait = new Promise(r => { titlesWaiter = r; });
  try {
    await invoke('get_available_marathon_titles', { charId: scanner?.id || null, extraUrls: extra });
  } catch (e) {
    titlesWaiter = null; progressHandler = null;
    task.finish(`Ошибка запуска: ${e}`, 'error');
    return { titles: [], errors: [String(e)], scanner, task };
  }
  const res = await withTimeout(wait, 90000, { titles: [], errors: ['timeout'] });
  progressHandler = null;
  const titles = res.titles || [], errors = res.errors || [];
  if (titles.length) recordParserResult('titles', null);
  else { const worst = classifyErrors(errors); recordParserResult('titles', worst.error, { status: worst.status }); }
  titles.forEach(t => task.log(`Найден: «${t.name}» — ${t.url}`, 'ok'));
  errors.forEach(e => task.log(`Ошибка: ${errorText(e)}`, 'warn'));
  task.finish(titles.length ? `Найдено марафонов: ${titles.length}` : 'Марафоны не найдены', titles.length ? (errors.length ? 'warn' : 'done') : 'error');
  return { titles, errors, scanner, task };
}

/** Разбирает страницу марафона. → { marathon: {name, sourceUrl, stages, quests, debug}, error, task } */
export async function parseMarathonPage(url, { dock = false, onTask } = {}) {
  const scanner = pickScannerCharacter();
  const task = startTask('📥 Загрузка заданий марафона', { dock }).watch('detail');
  await task.waitTurn();      // в доке — ждём очереди, вне дока (мастер) ждать нечего
  onTask?.(task);
  task.log(`Страница: ${url}`);
  task.log(scanner ? `Профиль: ${scanner.nick}` : 'Без профиля со входом', scanner ? 'info' : 'warn');
  task.setStep('Открываю страницу…');
  const wait = new Promise(r => { detailWaiter = r; });
  try {
    await invoke('parse_specific_marathon_page', { url, charId: scanner?.id || null });
  } catch (e) {
    detailWaiter = null;
    task.finish(`Ошибка запуска: ${e}`, 'error');
    return { marathon: null, error: String(e), task };
  }
  const res = await withTimeout(wait, 60000, { marathon: null, error: 'timeout' });
  const m = res.marathon;
  recordParserResult('detail', res.error || (m ? null : 'no_marathon'), { empty: !!m && !m.quests?.length });
  if (res.error || !m) {
    task.finish(`Не удалось разобрать страницу: ${errorText(res.error)}`, 'error');
    return { ...res, task };
  }
  (m.debug || []).forEach(line => task.log(line, /не распозн|не найд/i.test(line) ? 'warn' : 'info'));
  task.log(`Марафон «${m.name}»: этапов ${m.stages?.length || 0}, заданий ${m.quests?.length || 0}`, 'ok');
  (m.stages || []).forEach(st => task.log(`Этап «${st.name}»: ${st.startDate} — ${st.endDate}, заданий ${(m.quests || []).filter(q => q.stageKey === st.key).length}`));
  return { ...res, task };
}

/** Ссылка похожа на новость pwonline.ru (news.php?article=…). */
export const isNewsUrl = (url) => /news\.php\?.*article=\d+/i.test(String(url || ''));

/**
 * Загружает новость о марафоне и разбирает этапы, задания, награды.
 * → { marathon: {name, sourceUrl, newsUrl, stages, quests, debug}, error, task }
 */
export async function loadNewsPage(url, { dock = false, onTask } = {}) {
  const task = startTask('📰 Разбор новости о марафоне', { dock }).watch('news');
  await task.waitTurn();      // в доке — ждём очереди, вне дока (мастер) ждать нечего
  onTask?.(task);
  task.log(`Новость: ${url}`);
  const wait = new Promise(r => { newsWaiter = r; });
  try {
    await invoke('fetch_marathon_news', { url, charId: pickScannerCharacter()?.id || null });
  } catch (e) {
    newsWaiter = null;
    task.finish(`Ошибка запуска: ${e}`, 'error');
    return { marathon: null, error: String(e), task };
  }
  const res = await withTimeout(wait, 60000, { news: null, error: 'timeout' });
  recordParserResult('news', res.error || (res.news?.html ? null : 'no_article'));
  if (res.error || !res.news?.html) {
    task.finish(`Не удалось открыть новость: ${errorText(res.error || 'no_article')}`, 'error');
    return { marathon: null, error: res.error || 'no_article', task };
  }
  task.log(`Заголовок: «${res.news.title}», опубликовано ${res.news.publishedAt || '—'}`);
  let parsed;
  try {
    parsed = parseNewsHtml(res.news.html, { title: res.news.title, publishedAt: res.news.publishedAt, newsUrl: res.news.url || url });
  } catch (e) {
    task.finish(`Ошибка разбора: ${e.message}`, 'error');
    return { marathon: null, error: e.message, task };
  }
  parsed.debug.forEach(line => task.log(line, /не найден|вручную|проверьте/i.test(line) ? 'warn' : 'info'));
  parsed.stages.forEach(st => task.log(`Этап «${st.name}»: ${st.startDate || '?'} — ${st.endDate || '?'}, заданий ${parsed.quests.filter(q => q.stageKey === st.key).length}`));
  parsed.quests.forEach(q => task.log(`  ${q.title}: цель ${q.goal}${q.weekly ? ' (еженедельно)' : ''}, награды ${q.rewards.map(r => `${r.threshold}→🪙${r.rewardCoins}`).join(', ') || '—'}`));
  if (!parsed.quests.length) {
    task.finish('В новости не найдена таблица заданий', 'error');
    return { marathon: null, error: 'no_quests', task };
  }
  return { marathon: parsed, error: null, task };
}

/**
 * Поиск новостей в архиве событий pwonline.ru (первые NEWS_LIST_PAGES страниц).
 * Страницы грузятся тем же механизмом, что и новость (fetch_marathon_news: скрытое окно + очистка HTML),
 * поэтому отдельной команды в Rust не нужно.
 * → { items: [{id,url,title,date,isoDate}], error, task }; ошибка на одной странице не отменяет найденное на других.
 */
export async function searchNewsList({ pages = NEWS_LIST_PAGES, dock = false, onTask } = {}) {
  const task = startTask('🔎 Поиск новости о марафоне', { dock }).watch('news');
  await task.waitTurn();      // в доке — ждём очереди, вне дока (мастер) ждать нечего
  onTask?.(task);
  const loaded = [];
  let firstError = null;
  for (let page = 1; page <= pages; page++) {
    const url = newsListUrl(page);
    task.log(`Страница ${page} из ${pages}: ${url}`);
    const wait = new Promise(r => { newsWaiter = r; });
    try {
      await invoke('fetch_marathon_news', { url, charId: pickScannerCharacter()?.id || null });
    } catch (e) {
      newsWaiter = null;
      firstError = firstError || String(e);
      task.log(`Не удалось открыть страницу ${page}: ${e}`, 'warn');
      continue;
    }
    const res = await withTimeout(wait, 60000, { news: null, error: 'timeout' });
    if (res.error || !res.news?.html) {
      firstError = firstError || res.error || 'no_article';
      task.log(`Страница ${page}: ${errorText(res.error || 'no_article')}`, 'warn');
      continue;
    }
    const items = parseNewsList(res.news.html);
    task.log(`Страница ${page}: новостей ${items.length}`);
    loaded.push(items);
  }
  const items = mergeNewsPages(loaded);
  // Страницы архива открылись, а новостей в них не нашлось — признак изменившейся вёрстки списка
  recordParserResult('news', items.length ? null : (firstError || 'no_news_list'));
  if (!items.length) {
    task.finish(`Список новостей не получен: ${errorText(firstError || 'пусто')}`, 'error');
    return { items: [], error: firstError || 'empty', task };
  }
  task.finish(`Загружено новостей: ${items.length}`, loaded.length < pages ? 'warn' : 'done');
  return { items, error: null, task };
}

/* ------------------------------------------------------------------ */
/*  Прогресс персонажей                                                */
/* ------------------------------------------------------------------ */

/** Вызывается из syncManager при событии marathon-progress-result-global. */
export function onCharMarathonData(charId, quests, error) {
  const resolve = charWaiters.get(charId);
  if (resolve) { charWaiters.delete(charId); resolve({ quests, error }); }
}

function marathonUrlOf(m) {
  if (m.source?.url) return m.source.url;
  const series = m.seriesId ? state.marathons.find(s => s.id === m.seriesId) : null;
  return series?.source?.url || null;
}

async function fetchChar(charId, url) {
  const wait = new Promise(r => charWaiters.set(charId, r));
  try {
    await invoke('fetch_marathon_progress_v1', { charId, marathonUrl: url, closeAfter: true });
  } catch (e) {
    charWaiters.delete(charId);
    return { quests: null, error: String(e) };
  }
  return withTimeout(wait, CHAR_TIMEOUT_MS, { quests: null, error: 'timeout' });
}

/** Применяет данные персонажа ко всем незавершённым марафонам этой страницы. */
function applyToMarathons(charId, quests, url, at) {
  const result = {};
  const char = state.characters.find(c => c.id === charId);
  state.marathons
    .filter(m => m.kind !== 'series' && m.status !== 'completed' && marathonUrlOf(m) === url)
    .forEach(m => {
      const changes = applySiteQuests(m, charId, quests, at);
      if (m.participantIds.includes(charId) && char && !m.balance.start[charId] && char.lastCoinUpdate) {
        m.balance.start[charId] = { coins: Number(char.ancientCoins) || 0, at };
      }
      result[m.id] = changes;
    });
  return result;
}

/**
 * Сверяет с сайтом набор марафонов (одна страница = один запрос на персонажа).
 * callbacks: onStart(charId), onDone(charId, {error, changes}), onProgress(done,total)
 */
export async function syncMarathons(marathons, callbacks = {}) {
  const at = new Date().toISOString();
  const nick = (id) => state.characters.find(c => c.id === id)?.nick || id;
  const task = startTask(marathons.length === 1 ? `🔄 Сверка: ${marathons[0].title}` : `🔄 Сверка марафонов (${marathons.length})`, { cancelable: true });
  const signal = { cancelled: false };
  task.onCancel(() => { signal.cancelled = true; });
  // Ждём своей очереди: пока идёт другой скрипт, запросы не отправляем
  await task.waitTurn();
  callbacks.onTask?.(task);
  const byUrl = new Map();
  const noUrl = [];
  marathons.forEach(m => {
    const url = marathonUrlOf(m);
    if (!url) { noUrl.push(m); return; }
    if (!byUrl.has(url)) byUrl.set(url, new Set());
    m.participantIds.forEach(id => byUrl.get(url).add(id));
  });

  const jobs = [];
  byUrl.forEach((ids, url) => ids.forEach(charId => jobs.push({ charId, url })));
  const total = jobs.length;
  task.cancelable = total > 1;      // «Отмена» нужна, только если запросов несколько
  let done = 0;
  task.progress(0, total, `В очереди ${total} запросов, по ${browserSlots.max} одновременно`);
  noUrl.forEach(m => task.log(`«${m.title}»: не указана страница на сайте — пропущен`, 'warn'));
  byUrl.forEach((ids, url) => task.log(`${url}: ${ids.size} перс.`));
  task.watch(...jobs.map(j => `char:${j.charId}`));

  const report = {};             // marathonId -> { changes: [], errors: [] }
  marathons.forEach(m => { report[m.id] = { changes: [], errors: [] }; });

  const retries = Number(state.settings?.scripts?.retries ?? 2);
  await runQueue(jobs, async ({ charId, url }, attempt) => {
    if (signal.cancelled) return { skipped: true };      // отмена: запрос не отправляется
    callbacks.onStart?.(charId);
    task.log(`${nick(charId)}: открываю ${url.replace('https://', '')}${attempt ? ` (повтор ${attempt}/${retries})` : ''}`, 'step');
    return await fetchChar(charId, url);
  }, {
    retries,
    retryDelayMs: Number(state.settings?.scripts?.retryDelayMs ?? 2000),
    signal,
    shouldRetry: (res, err) => !!err || isRetryableCode(res?.error),
    onDone: ({ item, result, error: thrown }) => {
      const { charId, url } = item;
      if (result?.skipped) { callbacks.onDone?.(charId, { error: null, changes: {}, skipped: true }); return; }
      const quests = result?.quests;
      const error = result?.error || (thrown ? String(thrown) : null);
      let changesForChar = {};
      recordParserResult('progress', error, { empty: !error && Array.isArray(quests) && !quests.length });
      if (!error && Array.isArray(quests)) {
        changesForChar = applyToMarathons(charId, quests, url, at);
        if (!quests.length) {
          marathons.filter(m => marathonUrlOf(m) === url && m.participantIds.includes(charId))
            .forEach(m => report[m.id].errors.push({ charId, error: 'no_quests' }));
        }
      } else {
        const char = state.characters.find(c => c.id === charId);
        if (error === 'not_logged_in' && char) char.isLoggedIn = false;
      }
      marathons.forEach(m => {
        if (!m.participantIds.includes(charId) || marathonUrlOf(m) !== url) return;
        if (error) report[m.id].errors.push({ charId, error });
        (changesForChar[m.id] || []).forEach(ch => report[m.id].changes.push({ charId, ...ch }));
      });
      done++;
      const nChanges = Object.values(changesForChar).reduce((a, l) => a + l.length, 0);
      if (error) task.log(`${nick(charId)}: ${errorText(error)}`, error === 'not_logged_in' ? 'warn' : 'error');
      else task.log(`${nick(charId)}: заданий на сайте ${quests.length}, изменений ${nChanges}`, quests.length ? 'ok' : 'warn');
      task.progress(done, total, nick(charId));
      callbacks.onDone?.(charId, { error, changes: changesForChar });
      callbacks.onProgress?.(done, total);
    }
  });

  marathons.forEach(m => {
    if (!marathonUrlOf(m)) return;
    m.lastSync = { at, changes: report[m.id].changes, errors: report[m.id].errors };
    m.updatedAt = at;
  });
  await persist();
  const allChanges = Object.values(report).reduce((a, r) => a + r.changes.length, 0);
  const allErrors = Object.values(report).reduce((a, r) => a + r.errors.length, 0);
  if (signal.cancelled) task.finish(`Отменено: сверено ${done} из ${total}, изменений ${allChanges}${allErrors ? `, ошибок ${allErrors}` : ''}`, 'warn');
  else task.finish(`Изменений ${allChanges}${allErrors ? `, ошибок ${allErrors}` : ''}`, allErrors ? 'warn' : 'done');
  return { report, noUrl, total, task, cancelled: signal.cancelled };
}

/** Для меню скриптов: сверить все идущие марафоны. */
export async function syncAllActiveMarathons(callbacks) {
  const active = state.marathons.filter(m => m.kind !== 'series' && m.status !== 'completed' && m.participantIds.length);
  if (!active.length) return { report: {}, noUrl: [], total: 0 };
  return syncMarathons(active, callbacks);
}

export { marathonUrlOf };

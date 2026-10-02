// js/modules/marathons/mergeSources.js
// Объединение двух источников марафона в один набор данных для мастера:
//   • новость (news.php?article=…) — основной: этапы, сроки, цели, награды, бонусы, полные описания;
//   • страница отметок (supermarathon.php / supermarathon2.php) — названия заданий «как на сайте»
//     (например, «Испытание снов (июль)»), по которым идёт сверка, и проверка новости.
// Чистые функции без DOM и Tauri, поэтому легко тестируются.

import { normTitle, baseTitle } from './model.js';

const ALL_STAGES = 'весь марафон';

/** Ищет на странице отметок задание, соответствующее заданию из новости. */
export function findSiteQuest(newsQuest, siteQuests, used = new Set()) {
  const free = siteQuests.filter(q => !used.has(q));
  const exact = free.find(q => normTitle(q.title) === normTitle(newsQuest.title));
  if (exact) return exact;
  const base = baseTitle(newsQuest.title);
  const sameBase = free.filter(q => baseTitle(q.title) === base);
  if (!sameBase.length) return null;
  const byStage = sameBase.find(q => q.stageKey && q.stageKey === newsQuest.stageKey);
  if (byStage) return byStage;
  // этап не указан в названии на сайте / в новости один этап — совпадение однозначно, если оно единственное
  if (sameBase.length === 1 && (!sameBase[0].stageKey || newsQuest.stageKey === ALL_STAGES || !newsQuest.stageKey)) return sameBase[0];
  return null;
}

const sameText = (a, b) => normTitle(a) === normTitle(b);
const range = (st) => `${st.startDate || '?'} — ${st.endDate || '?'}`;

/**
 * @param {{ news?: object|null, site?: object|null }} src  результаты разбора (оба — вида { name, sourceUrl, newsUrl, stages, quests })
 * @returns {{ raw: object|null, notes: {level:'info'|'warn', text:string}[] }}
 *   raw.origin: 'news' | 'site' | 'merged'
 */
export function mergeSiteAndNews({ news = null, site = null } = {}) {
  const notes = [];
  if (!news && !site) return { raw: null, notes };
  if (!site) return { raw: { ...news, origin: 'news' }, notes };
  if (!news) return { raw: { ...site, origin: 'site' }, notes };

  const used = new Set();
  let descDiff = 0;
  const stageName = (key) => (news.stages.find(s => s.key === key) || site.stages.find(s => s.key === key))?.name || key;

  // --- задания: основа — новость, названия — со страницы отметок ---
  const quests = news.quests.map(nq => {
    const sq = findSiteQuest(nq, site.quests, used);
    if (!sq) {
      notes.push({ level: 'info', text: `«${nq.title}»${nq.stageKey && nq.stageKey !== ALL_STAGES ? ` (${stageName(nq.stageKey)})` : ''}: нет на странице отметок — этап ещё не начался или уже закрыт` });
      return { ...nq, descriptionSource: nq.description ? 'news' : '' };
    }
    used.add(sq);
    if (sq.goal && nq.goal && sq.goal !== nq.goal) {
      notes.push({ level: 'warn', text: `«${sq.title}»: цель в новости ${nq.goal}, на странице отметок ${sq.goal} — взята цифра из новости, проверьте` });
    }
    if (nq.description && sq.description && !sameText(nq.description, sq.description)) descDiff++;
    return {
      ...nq,
      title: sq.title,
      siteTitle: sq.title,
      description: nq.description || sq.description || '',
      descriptionSource: nq.description ? 'news' : (sq.description ? 'site' : '')
    };
  });
  site.quests.filter(sq => !used.has(sq)).forEach(sq => {
    notes.push({ level: 'warn', text: `«${sq.title}»: есть на странице отметок, но не найдено в новости — добавлено без наград` });
    quests.push({ ...sq, siteTitle: sq.title, rewards: [], descriptionSource: sq.description ? 'site' : '' });
  });
  if (descDiff) notes.push({ level: 'info', text: `Описания различаются у заданий: ${descDiff}. Взяты из новости (в ней полнее).` });

  // --- этапы: сроки и бонусы из новости, названия и недостающие этапы — со страницы ---
  const stages = news.stages.map(ns => {
    const ss = site.stages.find(s => s.key === ns.key);
    if (!ss) return { ...ns };
    if (!ns.guessed && !ss.guessed && (ns.startDate !== ss.startDate || ns.endDate !== ss.endDate)) {
      notes.push({ level: 'warn', text: `Сроки этапа «${ss.name}»: в новости ${range(ns)}, на странице ${range(ss)} — взяты из новости, проверьте` });
    }
    if (ns.guessed && !ss.guessed) return { ...ns, name: ss.name, startDate: ss.startDate, endDate: ss.endDate, guessed: false };
    return { ...ns, name: ss.name };
  });
  site.stages.filter(ss => !stages.some(s => s.key === ss.key)).forEach(ss => {
    notes.push({ level: 'info', text: `Этап «${ss.name}» есть только на странице отметок — добавлен без бонуса` });
    stages.push({ ...ss });
  });
  stages.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));

  if (news.name && site.name && !sameText(news.name, site.name)) {
    notes.push({ level: 'info', text: `Название марафона: в новости «${news.name}», на странице «${site.name}» — оставлено название со страницы.` });
  }

  return {
    raw: {
      origin: 'merged',
      name: site.name || news.name,
      sourceUrl: site.sourceUrl || news.sourceUrl || null,
      newsUrl: news.newsUrl || null,
      stages, quests,
      debug: [...(news.debug || []), ...(site.debug || [])]
    },
    notes
  };
}

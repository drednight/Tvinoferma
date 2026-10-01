// js/modules/marathons/newsParser.js
// Разбор новости pwonline.ru о марафоне (news.php?article=…):
// этапы (спойлеры «Летний марафон: июнь» и т.п.), сроки, задания с целями «10/15/20 раз»,
// награды «25/35/40 монет», бонус «за 4 испытания — Летний ларец», ссылка на страницу отметок.

const MONTH_GEN = { 'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6,
  'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12 };
const MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const NUM_WORDS = { 'одного': 1, 'одно': 1, 'двух': 2, 'два': 2, 'трех': 3, 'трёх': 3, 'три': 3, 'четырех': 4, 'четырёх': 4, 'четыре': 4,
  'пяти': 5, 'пять': 5, 'шести': 6, 'шесть': 6, 'семи': 7, 'семь': 7, 'всех': 0 };

const G = Object.keys(MONTH_GEN).join('|');
const T = '(?:\\d{1,2}[:.]\\d{2}\\s*(?:мск|msk)?\\s*)?';
const RE_RANGE = new RegExp('(?:^|[\\s(,.—-])с\\s+' + T + '(\\d{1,2})\\s+(' + G + ')(?:\\s+(\\d{4}))?[\\s\\S]{0,80}?(?:до|по)\\s+' + T + '(\\d{1,2})\\s+(' + G + ')(?:\\s+(\\d{4}))?', 'i');

const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const nums = (s) => String(s).split('/').map(x => parseInt(x, 10)).filter(n => Number.isFinite(n));

function parsePubDate(s) {
  const m = String(s || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : new Date();
}

function parseRange(text, pub) {
  const mt = norm(text).match(RE_RANGE);
  if (!mt) return null;
  const sMon = MONTH_GEN[mt[2].toLowerCase()], eMon = MONTH_GEN[mt[5].toLowerCase()];
  let sYear = mt[3] ? Number(mt[3]) : pub.getFullYear();
  if (!mt[3] && sMon < pub.getMonth() + 1 - 6) sYear += 1;           // новость в декабре о январском этапе
  const eYear = mt[6] ? Number(mt[6]) : (eMon < sMon ? sYear + 1 : sYear);
  return { startDate: iso(sYear, sMon, Number(mt[1])), endDate: iso(eYear, eMon, Number(mt[4])) };
}

/** «Успешное выполнение четырех испытаний позволит вам завладеть Летним ларцом июня» */
function parseBonus(text) {
  const t = norm(text);
  const m = t.match(/(?:выполнени[а-яё]*|пройдя|завершив|выполнив)\s+(\d+|[а-яё]+)\s+(?:из\s+\S+\s+)?(?:испытани|задани|поручени)[а-яё]*[^.]*?(?:завладеть|получить|получите|достанется|вознагра[а-яё]*)\s+([^,.:;]+)/i);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1].toLowerCase()];
  if (!n) return null;
  return { needTasks: n, text: cap(toNominative(m[2].trim())) };
}

/** «Летним ларцом июня» → «Летний ларец июня» (для типичных названий наград). */
const NOUNS = { 'ларцом': 'ларец', 'сундуком': 'сундук', 'сундучком': 'сундучок', 'шкатулкой': 'шкатулка', 'ларцами': 'ларцы', 'сундуками': 'сундуки', 'наградой': 'награда', 'призом': 'приз', 'подарком': 'подарок', 'набором': 'набор' };
function toNominative(text) {
  const words = text.split(' ');
  const ni = words.findIndex(w => NOUNS[w.toLowerCase()]);
  if (ni === -1) return text;
  return words.map((w, i) => {
    if (i === ni) return NOUNS[w.toLowerCase()];
    if (i < ni) {
      const fem = /а$/.test(NOUNS[words[ni].toLowerCase()]);
      if (/[нк]им$/i.test(w)) return w.replace(/им$/i, fem ? 'яя' : 'ий').replace(/кяя$/, 'кая');
      if (/ым$/i.test(w)) return w.replace(/ым$/i, 'ый');
      if (/ой$/i.test(w) && fem) return w.replace(/ой$/i, 'ая');
    }
    return w;
  }).join(' ');
}

function cellsOf(tr) { return [...tr.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH'); }
function isHeaderRow(tr) {
  const c = cellsOf(tr).map(x => norm(x.textContent).toLowerCase());
  return c.length >= 3 && c.some(x => x.startsWith('задача') || x.startsWith('задание')) && c.some(x => x.startsWith('награда'));
}
function isTaskTable(t) {
  return [...t.rows].some(r => r.closest('table') === t && isHeaderRow(r));
}

function parseTaskRow(tr) {
  const cells = cellsOf(tr);
  if (cells.length < 3) return null;
  const name = norm(cells[0].textContent);
  const task = norm(cells[1].textContent);
  const reward = norm(cells[cells.length - 1].textContent);
  if (!name || isHeaderRow(tr)) return null;
  const goalsAll = [...task.matchAll(/(\d+(?:\s*\/\s*\d+)*)\s*раз/gi)];
  const goals = goalsAll.length ? nums(goalsAll[goalsAll.length - 1][1].replace(/\s/g, '')) : [];
  const coinM = reward.match(/(\d+(?:\s*\/\s*\d+)*)\s*(?:древн[а-яё]*\s*)?(?:монет|дм)/i);
  const coins = coinM ? nums(coinM[1].replace(/\s/g, '')) : [];
  const extraText = coinM ? norm(reward.replace(coinM[0], '').replace(/^[+,;и\s]+|[+,;\s]+$/g, '')) : reward;
  const thresholds = goals.length ? goals : [1];
  const rewards = thresholds.map((g, i) => ({
    threshold: g,
    rewardCoins: coins.length === thresholds.length ? coins[i] : (i === thresholds.length - 1 ? (coins[coins.length - 1] || 0) : 0),
    rewardText: extraText || (coins.length ? 'Монеты' : '')
  })).filter(r => r.rewardCoins || r.rewardText);
  return {
    title: name,
    description: task,
    goal: Math.max(...thresholds),
    goalFound: goals.length > 0,
    weekly: /еженедельн|раз в неделю/i.test(task),
    rewards
  };
}

/**
 * @param {string} html  HTML текста новости
 * @param {object} meta  { title, publishedAt: 'дд.мм.гггг', newsUrl }
 * @returns {{ name, sourceUrl, newsUrl, stages, quests, debug }}
 */
export function parseNewsHtml(html, meta = {}) {
  const doc = new DOMParser().parseFromString(`<div id="tf-news-root">${html}</div>`, 'text/html');
  const root = doc.getElementById('tf-news-root');
  const pub = parsePubDate(meta.publishedAt);
  const debug = [];
  const title = norm(meta.title || root.querySelector('h1')?.textContent || 'Марафон из новости');

  // Ссылка на страницу с отметками (FAQ: «Где я могу проследить…? — Здесь»)
  const link = [...root.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).find(h => /supermarathon\d*\.php/i.test(h));
  const sourceUrl = link ? new URL(link, 'https://pwonline.ru/news.php').href.replace(/^http:/, 'https:') : null;
  debug.push(sourceUrl ? `Страница отметок: ${sourceUrl}` : 'Ссылка на страницу отметок в новости не найдена — укажите её вручную');

  // Обход в порядке документа: заголовки, абзацы, таблицы заданий
  const sections = [];
  let ctx = { heading: null, range: null, bonus: null };
  let introRange = null;
  const els = root.querySelectorAll('h2, h3, h4, .click_spoiler, p, li, table');
  for (const el of els) {
    if (el.closest('table') && el.tagName !== 'TABLE' && el.closest('table') !== el) {
      // текст внутри таблиц: таблицы заданий обрабатываются целиком, но бонус бывает в обычных таблицах-раскладках
      if (!isTaskTable(el.closest('table'))) {
        if (el.tagName === 'P' || el.tagName === 'LI') {
          const b = parseBonus(el.textContent); if (b) ctx.bonus = b;
          const r = parseRange(el.textContent, pub); if (r && !ctx.range) ctx.range = r;
        }
      }
      continue;
    }
    if (/^H[2-4]$/.test(el.tagName) || el.classList.contains('click_spoiler')) {
      const h = norm(el.textContent);
      if (h && h !== ctx.heading) ctx = { heading: h, range: null, bonus: null };
      continue;
    }
    if (el.tagName === 'P' || el.tagName === 'LI') {
      const r = parseRange(el.textContent, pub);
      if (r && !ctx.range) ctx.range = r;
      if (r && !introRange) introRange = r;
      const b = parseBonus(el.textContent); if (b) ctx.bonus = b;
      continue;
    }
    if (el.tagName === 'TABLE' && isTaskTable(el) && ![...el.querySelectorAll('table')].some(isTaskTable)) {
      const quests = [...el.rows].filter(r => r.closest('table') === el).map(parseTaskRow).filter(Boolean);
      if (!quests.length) continue;
      sections.push({ heading: ctx.heading, range: ctx.range || introRange, bonus: ctx.bonus, quests });
    }
  }
  debug.push(`Таблиц заданий: ${sections.length}`);

  const stages = [];
  const allQuests = [];
  sections.forEach((s, i) => {
    const h = s.heading || '';
    const monthInHead = MONTH_NOM.find(m => h.toLowerCase().includes(m));
    const monthOfEnd = s.range ? MONTH_NOM[Number(s.range.endDate.slice(5, 7)) - 1] : null;
    const key = monthInHead || (sections.length > 1 ? (monthOfEnd || `этап ${i + 1}`) : 'весь марафон');
    const name = sections.length > 1 ? cap(h.includes(':') ? h.split(':').pop().trim() : (monthInHead || h || `Этап ${i + 1}`)) : title;
    if (!s.range) debug.push(`Сроки для «${name}» не найдены — укажите даты вручную`);
    stages.push({
      name, key,
      startDate: s.range?.startDate || null,
      endDate: s.range?.endDate || null,
      guessed: !s.range,
      bonus: s.bonus
    });
    if (s.bonus) debug.push(`«${name}»: бонус за ${s.bonus.needTasks} заданий — ${s.bonus.text}`);
    s.quests.forEach(q => {
      if (!q.goalFound) debug.push(`«${q.title}»: не найдено «N раз» в описании — цель поставлена 1, проверьте`);
      allQuests.push({ ...q, stageKey: key });
    });
  });

  // Даты для этапов без сроков: по месяцу из заголовка
  stages.forEach(st => {
    if (st.startDate) return;
    const mi = MONTH_NOM.indexOf(st.key);
    if (mi === -1) return;
    let y = pub.getFullYear(); if (mi + 1 < pub.getMonth() + 1 - 6) y += 1;
    st.startDate = iso(y, mi + 1, 1);
    st.endDate = iso(y, mi + 1, new Date(y, mi + 1, 0).getDate());
  });

  return { name: title, sourceUrl, newsUrl: meta.newsUrl || null, stages, quests: allQuests, debug };
}

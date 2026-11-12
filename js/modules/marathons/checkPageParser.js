import { normalizeMarathonUrl } from './sourceUrl.js';
const norm = value =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
const months = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря'
];

/** Read saved HTML as inert text. Never execute scripts or import account/progress data. */
export function parseCheckPageHtml(html, { sourceUrl = null, year = new Date().getFullYear() } = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const container = doc.querySelector('.season_marathon');
  if (!container) throw new Error('Не найден блок заданий страницы сверки (.season_marathon).');
  const name =
    norm(doc.querySelector('#media_tabs > h2')?.textContent || doc.querySelector('h2')?.textContent) ||
    'Марафон со страницы сверки';
  const info = norm(doc.querySelector('.status_legend')?.textContent);
  const range = info.match(
    new RegExp(
      `с\\s+(?:\\d{1,2}:\\d{2}\\s*(?:мск)?\\s*)?(\\d{1,2})\\s+(${months.join('|')})(?:\\s+(\\d{4}))?[\\s\\S]{0,80}?(?:до|по)\\s+(?:\\d{1,2}:\\d{2}\\s*(?:мск)?\\s*)?(\\d{1,2})\\s+(${months.join('|')})(?:\\s+(\\d{4}))?`,
      'i'
    )
  );
  const date = (y, month, day) => {
    const d = new Date(Date.UTC(y, month, Number(day)));
    if (d.getUTCMonth() !== month) throw new Error('Некорректная дата на странице сверки.');
    return d.toISOString().slice(0, 10);
  };
  const stages = [];
  if (range) {
    const startMonth = months.indexOf(range[2].toLowerCase());
    const endMonth = months.indexOf(range[5].toLowerCase());
    const startYear = Number(range[3] || year);
    stages.push({
      key: 'весь марафон',
      name,
      startDate: date(startYear, startMonth, range[1]),
      endDate: date(Number(range[6] || startYear + Number(endMonth < startMonth)), endMonth, range[4])
    });
  }
  const quests = [...container.children].flatMap(block => {
    const title = norm(block.querySelector('.info b, b')?.textContent);
    const progress = norm(block.querySelector('.progress span')?.textContent).match(/^\d+\s*\/\s*(\d+)$/);
    if (!title || !progress || Number(progress[1]) < 1) return [];
    return [
      {
        title,
        siteTitle: title,
        description: [...block.querySelectorAll('.info p, :scope > p')]
          .map(p => norm(p.textContent))
          .filter(Boolean)
          .join('\n'),
        goal: Number(progress[1]),
        stageKey: stages[0]?.key || null,
        rewards: [],
        descriptionSource: 'site'
      }
    ];
  });
  if (!quests.length) throw new Error('Не найдены названия заданий с целями на странице сверки.');
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  const pageUrl = normalizeMarathonUrl(sourceUrl || canonical);
  return {
    name,
    description: info,
    sourceUrl: pageUrl && new URL(pageUrl).hostname === 'pwonline.ru' ? pageUrl : null,
    stages,
    quests,
    debug: [
      'Задания и описания извлечены из страницы сверки. Личные отметки не импортированы.',
      ...(!range
        ? ['Сроки не найдены — укажите вручную.']
        : ['Год сроков без года взят из текущего года — проверьте перед сохранением.'])
    ]
  };
}

/** Follow only explicit same-site links; no arbitrary URLs or executable redirects. */
export function checkPageLinks(html, newsUrl = 'https://pwonline.ru/news.php', customUrls = []) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const custom = new Set(customUrls.map(normalizeMarathonUrl));
  return [
    ...new Set(
      [...doc.querySelectorAll('a[href]')].flatMap(a => {
        try {
          const url = new URL(a.getAttribute('href'), newsUrl);
          if (url.hostname !== 'pwonline.ru' || url.port || url.username || url.password) return [];
          const normalized = normalizeMarathonUrl(url.href);
          return normalized && (/^\/supermarathon\d*\.php\/?$/i.test(url.pathname) || custom.has(normalized))
            ? [normalized]
            : [];
        } catch {
          return [];
        }
      })
    )
  ];
}

export async function readSavedSiteHtml(file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('HTML-файл должен быть не больше 5 МБ.');
  const bytes = await file.arrayBuffer();
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 4096));
  return new TextDecoder(/charset\s*=\s*["']?(?:windows-1251|cp1251)/i.test(head) ? 'windows-1251' : 'utf-8').decode(
    bytes
  );
}

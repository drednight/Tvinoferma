import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixture, parseSitePage } from './helpers/pageScript.js';
import { parseNewsHtml } from '../js/modules/marathons/newsParser.js';
import { mergeSiteAndNews, findSiteQuest } from '../js/modules/marathons/mergeSources.js';
import { migrateMarathon, createTask, applySiteQuests, createMarathon, setTaskDescription, editTaskDescription, shortDescription, ensureCell } from '../js/modules/marathons/model.js';

// Фикстуры — реальные страницы pwonline.ru, сохранённые в UTF-8 (issue #3).
const fx = fixture;
const news = (name, meta) => parseNewsHtml(fx(name), { newsUrl: 'https://pwonline.ru/news.php?article=1', ...meta });
const detail = parseSitePage;

describe('новость: описания заданий', () => {
  const summer = news('news-summer-2026.html', { title: 'Летний марафон', publishedAt: '29.05.2026' });

  it('летний марафон: 3 этапа, 15 заданий, у каждого есть описание', () => {
    expect(summer.stages.map(s => s.key)).toEqual(['июнь', 'июль', 'август']);
    expect(summer.quests).toHaveLength(15);
    summer.quests.forEach(q => expect(q.description.length).toBeGreaterThan(15));
  });

  it('абзацы в ячейке сохраняются переводами строк', () => {
    const q = summer.quests.find(x => x.title === 'Покоритель подземелий');
    expect(q.description).toMatch(/25 раз\.\nСписок подземелий:/);
  });

  it('осенний марафон: цели «10/12/15» без слова «раз» и награды «20/26/34 монеты»', () => {
    const autumn = news('news-autumn-2023.html', { title: 'Осенний марафон', publishedAt: '26.10.2023' });
    expect(autumn.sourceUrl).toBe('https://pwonline.ru/supermarathon.php');   // без завершающего «/»
    const beasts = autumn.quests.find(q => q.title === 'Хищные звери');
    expect(beasts).toMatchObject({ goal: 15, goalFound: true });
    expect(beasts.rewards.map(r => [r.threshold, r.rewardCoins])).toEqual([[10, 10], [12, 12], [15, 15]]);
    const dreams = autumn.quests.find(q => q.title === 'Испытания грез');
    expect(dreams.rewards.map(r => [r.threshold, r.rewardCoins, r.rewardText])).toEqual([[10, 20, 'Монеты'], [12, 26, 'Монеты'], [15, 34, 'Монеты']]);
    expect(autumn.debug.join('\n')).not.toMatch(/не найдено «N раз»/);
  });

  it('весенний марафон: 4 задания по 3 порога', () => {
    const spring = news('news-spring-2025.html', { title: 'Весенний марафон', publishedAt: '25.04.2025' });
    expect(spring.quests).toHaveLength(4);
    spring.quests.forEach(q => { expect(q.rewards).toHaveLength(3); expect(q.description).toBeTruthy(); });
  });
});

describe('страница отметок: скрипт marathon_detail.js', () => {
  it('supermarathon2.php: 10 заданий с описаниями, этапы из легенды', () => {
    const { data, error } = detail('site-supermarathon2.html');
    expect(error).toBeNull();
    expect(data.name).toBe('Летний марафон');
    expect(data.stages.map(s => s.key)).toEqual(['июнь', 'июль', 'август']);
    expect(data.quests).toHaveLength(10);
    data.quests.forEach(q => expect(q.description).toBeTruthy());
    expect(data.quests[0]).toMatchObject({ title: 'Испытание снов (июль)', goal: 25, stageKey: 'июль' });
  });

  it('несколько абзацев описания не теряются', () => {
    const { data } = detail('site-supermarathon2.html');
    const q = data.quests.find(x => x.title.startsWith('Покоритель подземелий'));
    expect(q.description).toBe('Пройти одно из подземелий ★★★★ уровня сложности и получить за него сундук(и) 25 раз.\nСписок подземелий: Остров рыцарей, Гробница шепотов и сложный режим Террасы снов.');
  });

  it('supermarathon.php: «Ликвидатор зла», 2 задания с описаниями и целями 2 и 10', () => {
    const { data, error } = detail('site-supermarathon.html');
    expect(error).toBeNull();
    expect(data.name).toBe('Ликвидатор зла');
    expect(data.quests.map(q => [q.title, q.goal])).toEqual([['Ночные легенды Кленового моста', 2], ['Меч, полный сомнений', 10]]);
    expect(data.quests[0].description).toMatch(/^Пройти в регионе Города Тяньюй/);
  });

  it('скрипт отдаёт описание и при сверке прогресса (marathon_progress.js)', () => {
    const src = readFileSync('src-tauri/src/scripts/marathon_progress.js', 'utf8');
    expect(src).toMatch(/description: description/);
  });
});

describe('объединение новости и страницы отметок', () => {
  const newsRaw = news('news-summer-2026.html', { title: 'Летний марафон', publishedAt: '29.05.2026' });
  const siteRaw = () => ({ ...detail('site-supermarathon2.html').data, sourceUrl: 'https://pwonline.ru/supermarathon2.php' });
  let merged;
  beforeAll(() => { merged = mergeSiteAndNews({ news: newsRaw, site: siteRaw() }); });

  it('только один источник — отдаётся как есть', () => {
    expect(mergeSiteAndNews({ news: newsRaw }).raw.origin).toBe('news');
    expect(mergeSiteAndNews({ site: siteRaw() }).raw.origin).toBe('site');
    expect(mergeSiteAndNews({}).raw).toBeNull();
  });

  it('названия заданий — со страницы отметок (с месяцем), награды — из новости', () => {
    const r = merged.raw;
    expect(r.origin).toBe('merged');
    const dreams = r.quests.find(q => q.title === 'Испытание снов (июль)');
    expect(dreams).toMatchObject({ siteTitle: 'Испытание снов (июль)', stageKey: 'июль', goal: 25 });
    expect(dreams.rewards.map(x => x.rewardCoins)).toEqual([60]);
    const aug = r.quests.find(q => q.title === 'Испытание снов (август)');
    expect(aug.rewards.map(x => x.rewardCoins)).toEqual([80]);
  });

  it('задания июня есть только в новости: остаются без привязки к странице, с пометкой', () => {
    const june = merged.raw.quests.filter(q => q.stageKey === 'июнь');
    expect(june).toHaveLength(5);
    june.forEach(q => expect(q.siteTitle).toBeUndefined());
    expect(merged.notes.filter(n => /нет на странице отметок/.test(n.text))).toHaveLength(5);
  });

  it('описание берётся из новости (в ней полнее), источник помечен', () => {
    const q = merged.raw.quests.find(x => x.title.startsWith('Последователь Пань Гу'));
    expect(q.descriptionSource).toBe('news');
    expect(q.description).toMatch(/Цзинсюань/);
    expect(merged.notes.some(n => /Описания различаются/.test(n.text))).toBe(true);
  });

  it('этапы: сроки и бонусы из новости, предупреждений о сроках нет', () => {
    expect(merged.raw.stages.map(s => s.key)).toEqual(['июнь', 'июль', 'август']);
    expect(merged.raw.stages[1].bonus).toMatchObject({ needTasks: 4 });
    expect(merged.notes.filter(n => n.level === 'warn')).toEqual([]);
    expect(merged.raw.sourceUrl).toBe('https://pwonline.ru/supermarathon2.php');
    expect(merged.raw.newsUrl).toBe('https://pwonline.ru/news.php?article=1');
  });

  it('расхождения целей и лишние задания попадают в предупреждения', () => {
    const site = siteRaw();
    site.quests[0] = { ...site.quests[0], goal: 20 };
    site.quests.push({ title: 'Новое задание (июль)', description: 'Что-то новое', goal: 5, stageKey: 'июль' });
    const { raw, notes } = mergeSiteAndNews({ news: newsRaw, site });
    const warns = notes.filter(n => n.level === 'warn').map(n => n.text);
    expect(warns.some(t => /цель в новости 25, на странице отметок 20/.test(t))).toBe(true);
    expect(warns.some(t => /Новое задание \(июль\)».*нет.*в новости|не найдено в новости/.test(t))).toBe(true);
    expect(raw.quests.find(q => q.title === 'Новое задание (июль)').rewards).toEqual([]);
  });

  it('findSiteQuest: «Испытание ада» в июне и августе не путаются', () => {
    const site = [{ title: 'Испытание ада (август)', stageKey: 'август' }];
    expect(findSiteQuest({ title: 'Испытание ада', stageKey: 'июнь' }, site)).toBeNull();
    expect(findSiteQuest({ title: 'Испытание ада', stageKey: 'август' }, site)).toBe(site[0]);
  });
});

describe('описание задания в модели: приоритеты и защита ручной правки', () => {
  it('createTask: источник описания по умолчанию', () => {
    expect(createTask({ title: 'A' })).toMatchObject({ description: '', descriptionSource: '' });
    expect(createTask({ title: 'A', description: 'Текст' }).descriptionSource).toBe('site');   // старые данные
    expect(createTask({ title: 'A', description: 'Текст', descriptionSource: 'news' }).descriptionSource).toBe('news');
  });

  it('setTaskDescription: ручное > новость > сайт', () => {
    const t = createTask({ title: 'A' });
    expect(setTaskDescription(t, 'С сайта', 'site')).toBe(true);
    expect(setTaskDescription(t, 'Из новости, полнее', 'news')).toBe(true);
    expect(setTaskDescription(t, 'Снова с сайта', 'site')).toBe(false);
    expect(t).toMatchObject({ description: 'Из новости, полнее', descriptionSource: 'news' });
    editTaskDescription(t, 'Моя правка');
    expect(setTaskDescription(t, 'Из новости', 'news')).toBe(false);
    expect(t).toMatchObject({ description: 'Моя правка', descriptionSource: 'manual' });
    editTaskDescription(t, '');
    expect(t).toMatchObject({ description: '', descriptionSource: '' });
  });

  it('сверка с сайтом обновляет только описания из сайта и пустые', () => {
    const m = createMarathon({
      title: 'M', participantIds: ['c1'],
      tasks: [
        createTask({ id: 'a', title: 'Первое', description: 'старое с сайта', descriptionSource: 'site' }),
        createTask({ id: 'b', title: 'Второе', description: 'из новости', descriptionSource: 'news' }),
        createTask({ id: 'c', title: 'Третье', description: 'моё', descriptionSource: 'manual' }),
        createTask({ id: 'd', title: 'Четвёртое' })
      ]
    });
    ['a', 'b', 'c', 'd'].forEach(id => ensureCell(m.progress, 'c1', id));
    const q = (title) => ({ title, description: 'новое с сайта', completed: 1, total: 5 });
    applySiteQuests(m, 'c1', [q('Первое'), q('Второе'), q('Третье'), q('Четвёртое')]);
    const d = Object.fromEntries(m.tasks.map(t => [t.id, t.description]));
    expect(d).toEqual({ a: 'новое с сайта', b: 'из новости', c: 'моё', d: 'новое с сайта' });
  });

  it('shortDescription обрезает по слову', () => {
    expect(shortDescription('коротко')).toEqual(['коротко', false]);
    const [t, cut] = shortDescription('слово '.repeat(40), 50);
    expect(cut).toBe(true);
    expect(t.length).toBeLessThanOrEqual(51);
    expect(t.endsWith('…')).toBe(true);
  });

  it('экспорт/импорт и миграция сохраняют описание и его источник', () => {
    const m = createMarathon({ title: 'M', tasks: [createTask({ title: 'A', description: 'Описание\nвторая строка', descriptionSource: 'manual' })] });
    const copy = migrateMarathon(JSON.parse(JSON.stringify(m)));   // как после экспорта в файл и импорта
    expect(copy.tasks[0]).toMatchObject({ description: 'Описание\nвторая строка', descriptionSource: 'manual' });
  });

  it('старые данные (схема v1) без описаний получают пустое описание', () => {
    const old = migrateMarathon({ id: 'x', title: 'Старый', tasks: [{ id: 't', title: 'Задание', targetChecks: 3 }], participantIds: [] });
    expect(old.tasks[0]).toMatchObject({ description: '', descriptionSource: '' });
  });
});

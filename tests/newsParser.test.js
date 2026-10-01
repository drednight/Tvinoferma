import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNewsHtml } from '../js/modules/marathons/newsParser.js';

const html = readFileSync('tests/fixtures/news-marathon.html', 'utf8');
const parsed = parseNewsHtml(html, { title: 'Летний марафон', publishedAt: '25.05.2026', newsUrl: 'https://pwonline.ru/news.php?article=1' });

describe('parseNewsHtml', () => {
  it('находит ссылку на страницу отметок', () => {
    expect(parsed.sourceUrl).toBe('https://pwonline.ru/supermarathon2.php');
    expect(parsed.newsUrl).toBe('https://pwonline.ru/news.php?article=1');
  });

  it('разбирает этапы со сроками', () => {
    expect(parsed.stages).toHaveLength(2);
    const [june, july] = parsed.stages;
    expect(june).toMatchObject({ key: 'июнь', startDate: '2026-05-30', endDate: '2026-06-28', guessed: false });
    expect(july).toMatchObject({ key: 'июль', startDate: '2026-06-29', endDate: '2026-07-26' });
  });

  it('разбирает бонус этапа в именительном падеже', () => {
    expect(parsed.stages[0].bonus).toEqual({ needTasks: 4, text: 'Летний ларец июня' });
  });

  it('разбирает задания, пороги и монеты', () => {
    expect(parsed.quests).toHaveLength(3);
    const dreams = parsed.quests[0];
    expect(dreams).toMatchObject({ title: 'Испытание снов (июнь)', goal: 15, goalFound: true, stageKey: 'июнь', weekly: false });
    expect(dreams.rewards.map(r => [r.threshold, r.rewardCoins])).toEqual([[5, 10], [10, 20], [15, 30]]);
  });

  it('распознаёт еженедельные задания и награды без монет', () => {
    const hunt = parsed.quests[1];
    expect(hunt.weekly).toBe(true);
    expect(hunt.goal).toBe(3);
    expect(hunt.rewards).toEqual([{ threshold: 3, rewardCoins: 0, rewardText: 'Сундук охотника' }]);
  });

  it('сообщает, если ссылки на страницу нет', () => {
    const r = parseNewsHtml('<p>Нет ссылок</p>', { publishedAt: '01.06.2026' });
    expect(r.sourceUrl).toBeNull();
    expect(r.debug.join(' ')).toMatch(/не найдена/);
  });
});

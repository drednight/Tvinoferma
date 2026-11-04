import { describe, it, expect, vi } from 'vitest';
import { normalizeMarathonUrl } from '../js/modules/marathons/sourceUrl.js';
import { parseNewsHtml } from '../js/modules/marathons/newsParser.js';
import { mergeSiteAndNews } from '../js/modules/marathons/mergeSources.js';
import { marathonUrlOf } from '../js/modules/marathons/siteSync.js';
import { state } from '../js/core/state.js';
vi.mock('../js/core/taskLog.js', () => ({ startTask: vi.fn(), errorText: value => value }));
const page = 'https://pwonline.ru/supermarathon2.php';
describe('marathon source identity', () => {
  it.each(['TF_READY_interactive', 'TF_READY_loading', 'TF_READY_complete', 'TF_DETAIL_V4_old'])(
    'strips %s from existing links and inherited series links at read time',
    marker => {
      expect(normalizeMarathonUrl(`${page}#${marker}`)).toBe(page);
      expect(marathonUrlOf({ source: { url: `${page}#${marker}` } })).toBe(page);
      state.marathons = [{ id: 'series', source: { url: `${page}#${marker}` } }];
      expect(marathonUrlOf({ seriesId: 'series' })).toBe(page);
    }
  );
  it('preserves query parameters but rejects invalid and credential-bearing links', () => {
    expect(normalizeMarathonUrl(`${page}/?event=2#TF_READY_interactive`)).toBe(`${page}?event=2`);
    expect(normalizeMarathonUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeMarathonUrl('https://name:secret@pwonline.ru/supermarathon.php')).toBeNull();
    expect(normalizeMarathonUrl('not a link')).toBeNull();
  });
  it('uses the article headline if its body has no title, and prefers an actual title in the body', () => {
    expect(parseNewsHtml('<p>Задания марафона</p>', { title: 'Ноябрьские испытания' }).name).toBe(
      'Ноябрьские испытания'
    );
    expect(parseNewsHtml('<h1>Особый марафон</h1>', { title: 'Новость' }).name).toBe('Особый марафон');
    expect(parseNewsHtml('<h1> </h1>', { title: 'Ноябрьские испытания' }).name).toBe('Ноябрьские испытания');
  });
  it('cleans the marks link extracted from an article', () => {
    expect(parseNewsHtml(`<a href="${page}#TF_READY_interactive">Календарь</a>`).sourceUrl).toBe(page);
  });
  it('does not let a placeholder site title override the headline', () => {
    const common = {
      stages: [{ key: 'ноябрь', startDate: '2026-11-01', endDate: '2026-11-10' }],
      quests: [],
      debug: []
    };
    const result = mergeSiteAndNews({
      news: { ...common, name: 'Ноябрьские испытания' },
      site: { ...common, name: 'Неизвестный Марафон' }
    });
    expect(result.raw.name).toBe('Ноябрьские испытания');
  });
});

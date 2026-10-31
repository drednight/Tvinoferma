// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state/normalize.js';
import { createMarathon, createSeries } from '../js/modules/marathons/model.js';
import { inspectStateFile } from '../js/modules/cloudSync/inspectStateFile.js';
import { bindStateFileCheck } from '../js/modules/cloudSync/ui/stateFileCheck.js';

function data(
  marathons = [createMarathon({ id: 'm', title: 'FAKE_PRIVATE_TITLE', tasks: [{ id: 't', title: 'Задача' }] })]
) {
  const { ui: _ui, ...snapshot } = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero', nick: 'FAKE_PRIVATE_NICK', contacts: { password: 'FAKE_PRIVATE_PASSWORD' } }],
    marathons
  });
  return snapshot;
}
function mount() {
  document.body.innerHTML =
    '<input id="state-file" type="file"><textarea id="report"></textarea><p id="check-status"></p><button id="select-report"></button><button id="clear-file"></button>';
  bindStateFileCheck();
  return { input: document.getElementById('state-file'), output: document.getElementById('report') };
}
function select(input, file) {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change'));
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('локальная проверка state.json без новых exe и отправки файла', () => {
  it.each(['#TF_READY_complete', '#TF_DETAIL_V4_FAKE_PRIVATE_REPORT'])(
    'проверяет старые служебные %s без изменения файла и вывода payload',
    fragment => {
      const snapshot = data();
      snapshot.marathons[0].source.url = 'https://pwonline.ru/supermarathon.php' + fragment;
      snapshot.marathons[0].source.newsUrl = 'https://pwonline.ru/news.php?article=42' + fragment;
      snapshot.marathonTemplates = [
        { id: 'template', name: 'Шаблон', tasks: [], sourceUrl: 'https://pwonline.ru/supermarathon.php' + fragment }
      ];
      const text = JSON.stringify(snapshot);
      const original = structuredClone(snapshot);
      expect(inspectStateFile(text).codes).toEqual(['file/structure_ok']);
      expect(snapshot).toEqual(original);
      expect(JSON.stringify(snapshot)).toBe(text);
    }
  );
  it.each([
    [
      'http URL',
      m => {
        m.source.url = 'http://pwonline.ru/supermarathon.php';
      },
      'source.url/url_scheme'
    ],
    [
      'foreign host',
      m => {
        m.source.url = 'https://FAKE_PRIVATE_HOST.invalid/';
      },
      'source.url/url_host'
    ],
    [
      'URL with token',
      m => {
        m.source.url = 'https://pwonline.ru/supermarathon.php?token=FAKE_PRIVATE_SECRET';
      },
      'source.url/url_query'
    ],
    [
      'URL with hash',
      m => {
        m.source.url = 'https://pwonline.ru/supermarathon.php#FAKE_PRIVATE_SECRET';
      },
      'source.url/url_fragment'
    ],
    [
      'duplicate URL parameter',
      m => {
        m.source.newsUrl = 'https://pwonline.ru/news.php?article=1&article=2';
      },
      'source.newsUrl/url_query_duplicate'
    ],
    [
      'bad start date',
      m => {
        m.startDate = '31.10.2026';
      },
      'startDate/date_format'
    ],
    [
      'bad end date',
      m => {
        m.endDate = '31.10.2026';
      },
      'endDate/date_format'
    ],
    [
      'fractional target',
      m => {
        m.tasks[0].targetChecks = 1.5;
      },
      'tasks.schedule/integer_range'
    ],
    [
      'bad weekday',
      m => {
        m.tasks[0].schedule.weekStartDay = 7;
      },
      'tasks.schedule/integer_range'
    ],
    [
      'bad schedule date',
      m => {
        m.tasks[0].schedule.dates = ['FAKE_PRIVATE_DATE'];
      },
      'tasks.schedule.dates/date_format'
    ],
    [
      'duplicate participants',
      m => {
        m.participantIds = ['hero', 'hero'];
      },
      'participantIds/duplicate'
    ],
    [
      'dangling participant',
      m => {
        m.participantIds = ['FAKE_PRIVATE_REMOVED'];
      },
      'participantIds/reference'
    ],
    [
      'dangling task',
      m => {
        m.assignments = { hero: ['FAKE_PRIVATE_REMOVED'] };
      },
      'assignments/reference'
    ],
    [
      'dangling progress',
      m => {
        m.progress = { hero: { FAKE_PRIVATE_REMOVED: {} } };
      },
      'progress/reference'
    ],
    [
      'dangling balance',
      m => {
        m.balance.start.FAKE_PRIVATE_REMOVED = { coins: 1, at: '2026-10-31' };
      },
      'balance/reference'
    ],
    [
      'dangling template',
      m => {
        m.source.templateId = 'FAKE_PRIVATE_REMOVED';
      },
      'source.templateId/reference'
    ],
    [
      'bad threshold',
      m => {
        m.tasks[0].rewards = [{ id: 'r', threshold: 1.5, rewardText: '', rewardCoins: 0 }];
      },
      'tasks.rewards/integer_range'
    ],
    [
      'dangling award',
      m => {
        m.awards = [
          { characterId: 'FAKE_PRIVATE_REMOVED', charNick: '', taskId: null, taskTitle: '', rewardText: '', coins: 0 }
        ];
      },
      'awards/reference'
    ]
  ])('%s: точный статический код, валидация не ослаблена', (_label, change, expected) => {
    const snapshot = data();
    change(snapshot.marathons[0]);
    const text = JSON.stringify(snapshot);
    expect(inspectStateFile(text, webcrypto).codes).toEqual([`setup/identities/public.marathons.${expected}`]);
    expect(JSON.stringify(snapshot)).toBe(text);
    expect(JSON.stringify(inspectStateFile(text, webcrypto))).not.toContain('FAKE_PRIVATE');
  });

  it('собирает независимые проблемы разных записей/разделов за одну проверку', () => {
    const snapshot = data([
      createMarathon({ id: 'one', source: { url: 'http://pwonline.ru/supermarathon.php' } }),
      createMarathon({ id: 'two', startDate: '31.10.2026' }),
      createMarathon({ id: 'three', startDate: '31.10.2026' })
    ]);
    snapshot.characters[0].stats.FAKE_PRIVATE_FIELD = 1;
    snapshot.finance = normalizeState({
      schemaVersion: 10,
      finance: {
        operations: [{ id: 'op', amount: 1, source: 'shop', ref: 'FAKE_PRIVATE_REMOVED' }]
      }
    }).finance;
    const codes = inspectStateFile(JSON.stringify(snapshot), webcrypto).codes;
    expect(codes).toEqual([
      'setup/identities/public.characters.stats/unknown_field',
      'setup/identities/public.marathons.source.url/url_scheme',
      'setup/identities/public.marathons.startDate/date_format',
      'setup/identities/public.finance.operations/reference'
    ]);
  });

  it('свои/архивные персонажи, старые статы и корректная серия проходят, без изменения исходника', () => {
    const snapshot = data([
      createSeries({ id: 'folder', childIds: ['m'] }),
      createMarathon({ id: 'm', seriesId: 'folder' })
    ]);
    snapshot.characters[0].stats.power = 0;
    const text = JSON.stringify(snapshot);
    const fetch = vi.fn();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal('fetch', fetch);
    expect(inspectStateFile(text, webcrypto).codes).toEqual(['file/structure_ok']);
    expect(JSON.stringify(snapshot)).toBe(text);
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(snapshot.characters[0]).not.toHaveProperty('syncId');
  });

  it.each([
    ['{FAKE_PRIVATE_SECRET', 'file/json'],
    ['{}', 'file/state_required'],
    ['[]', 'file/state_required'],
    [JSON.stringify({ schemaVersion: 999, characters: [], marathons: [] }), 'file/state_required']
  ])('не показывает фрагмент некорректного файла', (text, code) => {
    expect(inspectStateFile(text, webcrypto).codes).toEqual([code]);
  });

  it('не читает слишком большой File и не показывает исходное сообщение ошибки чтения', async () => {
    const f = mount();
    const read = vi.fn();
    select(f.input, { size: 33 * 1024 * 1024, text: read });
    expect(f.output.value).toBe('file/size');
    expect(read).not.toHaveBeenCalled();
    select(f.input, { size: 1, text: vi.fn().mockRejectedValue(new Error('FAKE_PRIVATE_PATH')) });
    await vi.waitFor(() => expect(f.output.value).toBe('file/read'));
    expect(document.body.textContent).not.toContain('FAKE_PRIVATE_PATH');
  });

  it('UI показывает только коды, без имени файла/контактов/ника', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const f = mount();
    const text = JSON.stringify(data());
    select(f.input, { size: text.length, name: 'FAKE_PRIVATE_FILENAME', text: async () => text });
    await vi.waitFor(() => expect(f.output.value).toBe('file/structure_ok'));
    expect(document.body.textContent + f.output.value).not.toContain('FAKE_PRIVATE');
  });

  it('очистка и новое чтение не позволяют старому результату перезаписать актуальный', async () => {
    const f = mount();
    let resolve;
    select(f.input, {
      size: 1,
      text: () =>
        new Promise(done => {
          resolve = done;
        })
    });
    document.getElementById('clear-file').click();
    resolve('{FAKE_PRIVATE');
    await Promise.resolve();
    expect(f.output.value).toBe('');
  });
});

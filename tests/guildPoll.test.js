import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseProfileDocument, normalizeGuildData } from '../js/modules/guild/core.js';
import { guildPollHtml, normalizeGuildPoll, safePollLink } from '../js/modules/guild/poll.js';

const html = readFileSync('tests/fixtures/site-guild-poll.html', 'utf8');
const response = JSON.parse(readFileSync('tests/fixtures/site-guild-poll-response.json', 'utf8'));
const script = readFileSync('src-tauri/src/scripts/guild.js', 'utf8');
const reply = data => ({ ok: true, json: async () => structuredClone(data) });
const report = prefix => JSON.parse(decodeURIComponent(window.location.hash.slice(prefix.length)));
const waitHash = prefix => vi.waitFor(() => expect(window.location.hash.startsWith(prefix)).toBe(true));

function install(fetchMock = vi.fn(async () => reply(response))) {
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/index.php');
  delete window.__tfGuildInstalled;
  window.__tfGuildOrigin = window.location.origin;
  vi.stubGlobal('fetch', fetchMock);
  new Function(script)();
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__tfGuildInstalled;
  delete window.__tfGuildOrigin;
});

describe('структура опроса и безопасный рендерер', () => {
  it('читает заголовок и ссылки из обезличенной структуры, а отсутствие опроса скрывает блок', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const poll = parseProfileDocument(doc).poll;
    expect(poll.id).toBe('901');
    expect(poll.title.filter(p => p.href).map(p => p.href)).toEqual([
      'https://example.com/players/101',
      'https://example.com/players/102',
      'https://example.com/players/103'
    ]);
    expect(poll.options).toEqual([]); // варианты приходят отдельным запросом
    doc.querySelector('#mainPoll').remove();
    expect(parseProfileDocument(doc).poll).toBeNull();
    expect(guildPollHtml(null)).toBe('');
  });

  it('не доверяет ссылкам и HTML из state.json даже после перезапуска', () => {
    const poll = normalizeGuildData({
      poll: {
        id: '901',
        title: [{ text: '<img onerror=alert(1)>', href: 'javascript:alert(1)' }],
        type: 'multiple',
        options: [
          { id: '501', text: [{ text: 'Безопасная ссылка', href: 'https://example.com/path' }], selected: true },
          { id: '501', text: [{ text: 'дубликат' }] },
          { id: '1" onclick="alert(1)', text: [{ text: 'лишнее' }] }
        ]
      }
    }).poll;
    expect(poll.options).toHaveLength(1);
    const container = document.createElement('div');
    container.innerHTML = guildPollHtml(poll);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a').href).toBe('https://example.com/path');
    expect(container.querySelector('input').checked).toBe(true);
    expect(container.textContent).toContain('<img onerror=alert(1)>');
    expect(normalizeGuildPoll({ id: 'bad' })).toBeNull();
    expect(safePollLink('javascript:alert(1)')).toBe('');
    expect(safePollLink('https://user:pass@example.com')).toBe('');
    expect(safePollLink('/local')).toBe('');
  });

  it('отображает ошибку загрузки, но не скрывает существующий опрос', () => {
    const markup = guildPollHtml({ id: '901', title: [{ text: 'Тест' }], loadError: true });
    expect(markup).toContain('Не удалось загрузить варианты');
    expect(markup).toContain('disabled');
  });
});

describe('скрипт окна клана: API и голосование', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('асинхронно загружает варианты и выбранные ответы в том же формате, что модель', async () => {
    const fetchMock = install();
    await waitHash('#TFETE1_');
    const result = report('#TFETE1_');
    const poll = result.data.poll;
    expect(result.error).toBeNull();
    expect(poll.title).toEqual(parseProfileDocument(new DOMParser().parseFromString(html, 'text/html')).poll.title);
    expect(poll.type).toBe('multiple');
    expect(poll.options.map(o => [o.id, o.selected])).toEqual([
      ['501', true],
      ['502', false],
      ['503', false]
    ]);
    expect(poll.options[1].text).toEqual([{ text: 'Второй вариант', href: 'https://example.com/details' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/handlers/get_poll.php?poll_id=901',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(normalizeGuildPoll(poll)).toEqual(poll);
  });

  it('разрешает относительные ссылки вариантов на домене окна и отбрасывает исполняемые', async () => {
    const data = structuredClone(response);
    data.options[0].option_text =
      '<a href="/details">Подробнее</a><script>alert(1)</script><a href="javascript:alert(1)">опасно</a>';
    install(vi.fn(async () => reply(data)));
    await waitHash('#TFETE1_');
    expect(report('#TFETE1_').data.poll.options[0].text).toEqual([
      { text: 'Подробнее', href: `${window.location.origin}/details` },
      { text: 'опасно' }
    ]);
  });

  it('при ошибке API сохраняет заголовок и показывает ошибку, не выдавая пустой опрос за отсутствие', async () => {
    install(
      vi.fn(async () => {
        throw new TypeError('failed');
      })
    );
    await waitHash('#TFETE1_');
    expect(report('#TFETE1_').data.poll).toMatchObject({ id: '901', loadError: true, options: [] });
  });

  it('голосует только после проверки текущих вариантов и подтверждения сервера', async () => {
    const fetchMock = install(
      vi.fn(async url => (url === '/handlers/vote.php' ? reply({ success: true }) : reply(response)))
    );
    await waitHash('#TFETE1_');
    window.history.replaceState(null, '', '/index.php');
    expect(await window.__tfGuildVote('901', ['501', '502'])).toBe(true);
    await waitHash('#TFETV1_');
    expect(report('#TFETV1_')).toEqual({ error: null, data: { ok: true, pollId: '901', message: '' } });
    const post = fetchMock.mock.calls.find(([url]) => url === '/handlers/vote.php');
    expect(JSON.parse(post[1].body)).toEqual({ poll_id: '901', option_ids: [501, 502] });
  });

  it('не отправляет POST при изменившемся опросе, варианте или некорректном выборе', async () => {
    const fetchMock = install();
    await waitHash('#TFETE1_');
    for (const [id, values] of [
      ['902', ['501']],
      ['901', ['999']],
      ['901', []],
      ['901', ['501', '501']]
    ]) {
      expect(await window.__tfGuildVote(id, values)).toBe(false);
    }
    expect(fetchMock.mock.calls.some(([url]) => url === '/handlers/vote.php')).toBe(false);
  });

  it('не выдаёт отказ или обрыв ответа за успешный голос и не повторяет POST', async () => {
    const fetchMock = install(
      vi.fn(async url => {
        if (url === '/handlers/vote.php') throw new TypeError('connection lost');
        return reply(response);
      })
    );
    await waitHash('#TFETE1_');
    expect(await window.__tfGuildVote('901', ['501'])).toBe(false);
    expect(report('#TFETV1_').data).toMatchObject({ ok: false, message: expect.stringContaining('Обновите сводку') });
    expect(fetchMock.mock.calls.filter(([url]) => url === '/handlers/vote.php')).toHaveLength(1);
  });

  it('не отправляет голос при переходе на другой сайт', async () => {
    const fetchMock = install();
    await waitHash('#TFETE1_');
    window.__tfGuildOrigin = 'https://another.example';
    expect(await window.__tfGuildVote('901', ['501'])).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url === '/handlers/vote.php')).toBe(false);
  });

  it('поздний старый ответ не перезаписывает новую сводку', async () => {
    const pending = [];
    install(vi.fn(() => new Promise(resolve => pending.push(resolve))));
    window.__tfGuildScrape();
    expect(pending).toHaveLength(2);
    const newer = structuredClone(response);
    newer.user_vote = [502];
    pending[1](reply(newer));
    await waitHash('#TFETE1_');
    pending[0](reply(response));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(report('#TFETE1_').data.poll.options.find(o => o.id === '502').selected).toBe(true);
  });
});

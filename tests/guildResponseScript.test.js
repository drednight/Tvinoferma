import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const source = readFileSync('src-tauri/src/scripts/guild.js', 'utf8');
const html = readFileSync('tests/fixtures/site-guild-profile.html', 'utf8');
const payload = prefix => JSON.parse(decodeURIComponent(location.hash.slice(prefix.length)));
function install() {
  delete window.__tfGuildInstalled;
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  history.replaceState(null, '', '/index.php');
  window.__tfGuildOrigin = location.origin;
  new Function(source)();
}
beforeEach(install);
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__tfGuildOrigin;
  delete window.__tfGuildInstalled;
});

describe('настоящая сверка ответа сайта в видимом окне', () => {
  it('читает свежую страницу вместо старых radio и не меняет видимую страницу пользователя', async () => {
    const old = document.querySelector('[name="response_462"][value="yes"]');
    const fresh = new DOMParser().parseFromString(html, 'text/html');
    const event = fresh.querySelector('form[data-event-id="462"]');
    event.querySelectorAll('input[type="radio"]').forEach(input => input.removeAttribute('checked'));
    event.querySelector('input[value="no"]').setAttribute('checked', '');
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => fresh.documentElement.outerHTML }));
    vi.stubGlobal('fetch', fetchMock);
    await window.__tfGuildRefresh();
    expect(fetchMock).toHaveBeenCalledWith(`${location.origin}/index.php`, {
      credentials: 'include',
      cache: 'no-store'
    });
    expect(payload('#TFETE1_').data.events.find(row => row.id === '462').response).toBe('no');
    expect(document.querySelector('[name="response_462"][value="yes"]')).toBe(old);
    expect(old.checked).toBe(true);
  });

  it('не считает страницу входа или неизвестную HTML-страницу успешной сводкой', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => '<input type="password">' }))
    );
    await window.__tfGuildRefresh();
    expect(payload('#TFETE1_')).toEqual({ data: null, error: 'login' });
    fetch.mockResolvedValue({ ok: true, text: async () => '<h1>Maintenance</h1>' });
    await window.__tfGuildRefresh();
    expect(payload('#TFETE1_')).toEqual({ data: null, error: 'page' });
  });

  it.each(['<html>Login</html>', '{}', '{"status":"error"}', '{"ok":false}'])(
    'не выдаёт неизвестный/отрицательный ответ POST за подтверждение: %s',
    async text => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, text: async () => text }))
      );
      expect(await window.__tfGuildRespond('462', 'yes')).toBe(false);
      expect(payload('#TFETA1_').ok).toBe(false);
    }
  );

  it('отправляет корректный выбор только на исходный сайт, принимает явный ответ', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '{"status":"success"}' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await window.__tfGuildRespond('462', 'no')).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${location.origin}/handlers/event_response.php`);
    expect([...options.body.entries()]).toEqual([
      ['event_id', '462'],
      ['response', 'no']
    ]);
    expect(options.credentials).toBe('include');
    window.__tfGuildOrigin = 'https://other.invalid';
    expect(await window.__tfGuildRespond('462', 'yes')).toBe(false);
    await window.__tfGuildRefresh();
    expect(payload('#TFETE1_').error).toBe('wrong_site');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('запоздалое чтение после POST не затирает ответ в общем hash-канале', async () => {
    let release;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              release = resolve;
            })
        )
        .mockResolvedValue({ ok: true, text: async () => '{"status":"success"}' })
    );
    const refresh = window.__tfGuildRefresh();
    await window.__tfGuildRespond('462', 'yes');
    const ack = location.hash;
    release({ ok: true, text: async () => html });
    await refresh;
    expect(location.hash).toBe(ack);
    expect(payload('#TFETA1_').ok).toBe(true);
  });
});

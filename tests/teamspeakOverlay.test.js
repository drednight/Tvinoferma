import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), close: vi.fn(), drag: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: mocks.close, startDragging: mocks.drag })
}));
let sockets;
const auth = () => ({
  type: 'auth',
  status: { code: 0 },
  payload: {
    apiKey: 'secret-returned-by-ts',
    connections: [
      {
        id: 1,
        clientId: 10,
        channelInfos: { rootChannels: [{ id: 3, properties: { name: 'My channel' } }] },
        clientInfos: [
          { id: 10, channelId: 3, properties: { nickname: 'Me' } },
          { id: 11, channelId: 3, properties: { nickname: '<script>bad</script>' } }
        ]
      }
    ]
  }
});
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.invoke.mockResolvedValue(undefined);
  window.localStorage.clear();
  window.__TAURI_INTERNALS__ = {};
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    readFileSync('teamspeak-overlay.html', 'utf8'),
    'text/html'
  ).documentElement.innerHTML;
  sockets = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor(url) {
        this.url = url;
        this.send = vi.fn();
        this.close = vi.fn();
        sockets.push(this);
      }
    }
  );
  await import('../js/modules/teamspeak/overlay.js');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.__TAURI_INTERNALS__;
});
async function connect6() {
  document.getElementById('connection-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(1);
  sockets[0].onopen();
  sockets[0].onmessage({ data: JSON.stringify(auth()) });
  return sockets[0];
}
it('pairs only with local TS6, shows own channel safely and marks speakers', async () => {
  const socket = await connect6();
  expect(socket.url).toBe('ws://127.0.0.1:5899');
  expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
    type: 'auth',
    payload: { identifier: 'ru.tvinoferma.overlay' }
  });
  expect(document.getElementById('channel').textContent).toContain('My channel');
  expect(document.querySelectorAll('#members li')).toHaveLength(2);
  expect(document.querySelector('#members script')).toBeNull();
  socket.onmessage({
    data: JSON.stringify({ type: 'talkStatusChanged', payload: { connectionId: 1, clientId: 11, status: 1 } })
  });
  expect(document.querySelectorAll('#members .talking')).toHaveLength(1);
  expect(localStorage.getItem('tf:teamspeak-appearance')).toBeNull();
});
it('channel chat fades out, is removed on timeout and is never stored', async () => {
  const socket = await connect6();
  socket.onmessage({
    data: JSON.stringify({
      type: 'chatMessage',
      payload: {
        connectionId: 1,
        channelId: 3,
        targetMode: 2,
        invokerName: 'Other',
        message: '<img src=x onerror=bad>'
      }
    })
  });
  expect(document.querySelectorAll('#messages li')).toHaveLength(1);
  expect(document.querySelector('#messages img')).toBeNull();
  await vi.advanceTimersByTimeAsync(16000);
  expect(document.querySelectorAll('#messages li')).toHaveLength(0);
  expect(localStorage.length).toBe(0);
});
it('clears roster and speaking state on socket closure and ignores stale messages', async () => {
  const socket = await connect6(),
    staleMessage = socket.onmessage;
  socket.onclose();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelectorAll('#members li')).toHaveLength(0);
  staleMessage({ data: JSON.stringify(auth()) });
  expect(document.querySelectorAll('#members li')).toHaveLength(0);
});
it('stores appearance only, never the user API key', async () => {
  document.getElementById('api-key').value = 'my-secret';
  document.getElementById('opacity').value = '65';
  document.getElementById('appearance-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const stored = localStorage.getItem('tf:teamspeak-appearance');
  expect(JSON.parse(stored).opacity).toBe(65);
  expect(stored).not.toContain('secret');
  expect(stored).not.toContain('apiKey');
});
it('TS3 polling uses the native loopback bridge and stops after disconnect', async () => {
  mocks.invoke.mockImplementation(async command =>
    command === 'teamspeak3_poll'
      ? {
          connected: true,
          connectionId: '1',
          channelId: '2',
          channel: 'TS3 channel',
          members: [{ name: 'Me', talking: true, self: true }]
        }
      : undefined
  );
  document.getElementById('version').value = '3';
  document.getElementById('api-key').value = 'ts3-secret';
  document.getElementById('connection-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.invoke).toHaveBeenCalledWith('teamspeak3_connect', { port: 25639, apiKey: 'ts3-secret' });
  expect(document.getElementById('api-key').value).toBe('');
  expect(document.querySelector('#members .talking')).not.toBeNull();
  document.getElementById('disconnect').click();
  await vi.advanceTimersByTimeAsync(1);
  mocks.invoke.mockClear();
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.invoke).not.toHaveBeenCalledWith('teamspeak3_poll');
  expect(document.querySelectorAll('#members li')).toHaveLength(0);
});

it('closes without waiting for a stalled native ClientQuery disconnect', async () => {
  mocks.invoke.mockImplementation(command =>
    command === 'teamspeak3_disconnect' ? new Promise(() => {}) : Promise.resolve()
  );
  document.getElementById('close').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.invoke).toHaveBeenCalledWith('teamspeak3_disconnect');
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
it('keeps native webview creation asynchronous and teardown mutex waits off the UI thread', () => {
  const source = readFileSync('src-tauri/src/teamspeak.rs', 'utf8');
  expect(source).toMatch(/pub async fn teamspeak_overlay\(/);
  const teardown = source.slice(source.indexOf('overlay.on_window_event'), source.indexOf('pub fn teamspeak_topmost'));
  expect(teardown.indexOf('spawn_blocking')).toBeGreaterThan(-1);
  expect(teardown.indexOf('QUERY.lock()')).toBeGreaterThan(teardown.indexOf('spawn_blocking'));
});

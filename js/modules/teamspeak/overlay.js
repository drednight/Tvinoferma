import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  preferences,
  text,
  createRemoteState,
  remoteEvent,
  remoteSnapshot,
  remoteChat,
  visibleMessages
} from './model.js';
const $ = id => document.getElementById(id);
let settings;
try {
  settings = preferences(JSON.parse(localStorage.getItem('tf:teamspeak-appearance') || '{}'));
} catch {
  settings = preferences();
}
let remote = createRemoteState(),
  socket = null,
  epoch = 0,
  timer,
  authTimer,
  connecting = false,
  messages = [],
  channelKey = '',
  members = [],
  connected = false,
  apiKey6 = '';
const status = value => {
  $('status').textContent = value;
};
function applyAppearance() {
  document.documentElement.style.setProperty('--alpha', String(settings.opacity / 100));
  document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--accent', settings.accent);
  document.documentElement.style.setProperty('--message-life', `${settings.messageSeconds}s`);
  $('chat').hidden = !settings.showChat;
}
function renderMembers() {
  $('members').replaceChildren(
    ...members
      .filter(m => !settings.speakersOnly || m.talking)
      .map(member => {
        const li = document.createElement('li'),
          name = document.createElement('span'),
          note = document.createElement('small');
        li.classList.toggle('talking', !!member.talking);
        name.textContent = text(member.name);
        note.textContent = [member.self ? 'Вы' : '', member.talking ? 'Говорит' : '', member.muted ? 'Без звука' : '']
          .filter(Boolean)
          .join(' · ');
        li.append(name, note);
        return li;
      })
  );
}
function renderMessages() {
  messages = visibleMessages(messages, settings.messageSeconds);
  const existing = new Map([...$('messages').children].map(li => [li.dataset.id, li]));
  const wanted = new Set(messages.map(m => m.id));
  existing.forEach((li, id) => {
    if (!wanted.has(id)) li.remove();
  });
  for (const message of messages) {
    if (existing.has(message.id)) continue;
    const li = document.createElement('li'),
      author = document.createElement('b'),
      body = document.createElement('span');
    li.dataset.id = message.id;
    author.textContent = text(message.author);
    body.textContent = text(message.text, 2000);
    li.style.animationDelay = `-${Math.max(0, Date.now() - message.at)}ms`;
    li.append(author, body);
    $('messages').append(li);
  }
}
function addMessage(message) {
  if (!message?.text || !settings.showChat) return;
  messages.push({
    id: crypto.randomUUID(),
    at: Date.now(),
    author: text(message.author),
    text: text(message.text, 2000)
  });
  renderMessages();
}
function snapshot(data) {
  const key = data.connected ? `${data.connectionId}:${data.channelId}` : '';
  if (key !== channelKey) {
    messages = [];
    $('messages').replaceChildren();
    channelKey = key;
  }
  connected = !!data.connected;
  members = Array.isArray(data.members) ? data.members.slice(0, 10000) : [];
  $('channel').textContent = data.connected
    ? `${text(data.channel || 'Мой канал')} · ${members.length}`
    : 'Нет активного канала';
  renderMembers();
  for (const message of data.messages || []) addMessage(message);
}
async function disconnect(showStatus = true) {
  ++epoch;
  clearTimeout(timer);
  clearTimeout(authTimer);
  const oldSocket = socket;
  socket = null;
  if (oldSocket) {
    oldSocket.onclose = null;
    oldSocket.onerror = null;
    oldSocket.onmessage = null;
    oldSocket.close();
  }
  remote = createRemoteState();
  snapshot({ connected: false, members: [] });
  $('server-label').hidden = true;
  if (window.__TAURI_INTERNALS__) await invoke('teamspeak3_disconnect').catch(() => {});
  connecting = false;
  $('connect').disabled = false;
  if (showStatus) status('Отключено');
}
function renderRemote() {
  const selected = remote.selected;
  $('server').replaceChildren(...[...remote.connections.values()].map(c => new Option(c.name, c.id)));
  $('server').value = selected;
  $('server-label').hidden = remote.connections.size < 2;
  snapshot(remoteSnapshot(remote));
  status(connected ? 'TS6 · подключено' : 'TS6 · доступ разрешён, ожидаю подключение к голосовому каналу');
}
async function connect3(id) {
  await invoke('teamspeak3_connect', { port: settings.port3, apiKey: $('api-key').value });
  $('api-key').value = '';
  if (id !== epoch) return;
  async function poll() {
    if (id !== epoch) return;
    try {
      const data = await invoke('teamspeak3_poll');
      if (id !== epoch) return;
      snapshot(data);
      status(data.connected ? 'TS3 · подключено' : 'TS3 · ожидаю подключение к голосовому каналу');
      timer = setTimeout(poll, 500);
    } catch {
      if (id !== epoch) return;
      await disconnect(false);
      status('Связь с ClientQuery потеряна. Проверьте TS3 и подключитесь снова.');
    }
  }
  await poll();
}
function connect6(id) {
  socket = new WebSocket('ws://127.0.0.1:5899');
  const ws = socket;
  ws.onopen = () => {
    if (id !== epoch) return;
    status('TS6 · разрешите Твиноферму в Settings → Remote Apps');
    ws.send(
      JSON.stringify({
        type: 'auth',
        payload: {
          identifier: 'ru.tvinoferma.overlay',
          version: '1.0.0',
          name: 'Твиноферма — оверлей',
          description: 'Состав своего канала, говорящие и временные сообщения чата',
          content: { apiKey: $('api-key').value || apiKey6 }
        }
      })
    );
    $('api-key').value = '';
    authTimer = setTimeout(() => {
      if (id === epoch && !remote.authenticated) {
        void disconnect(false).then(() =>
          status('TS6 не подтвердил доступ за 60 секунд. Разрешите Remote Apps и повторите подключение.')
        );
      }
    }, 60000);
  };
  ws.onmessage = event => {
    if (id !== epoch || typeof event.data !== 'string' || event.data.length > 2_000_000) return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.type === 'auth') {
      if (data.status?.code !== 0) {
        void disconnect(false).then(() => status('TS6 не разрешил подключение. Проверьте Remote Apps/API-ключ.'));
        return;
      }
      clearTimeout(authTimer);
      apiKey6 = text(data.payload?.apiKey, 1024);
    } else if (!remote.authenticated) return;
    try {
      remoteEvent(remote, data);
      renderRemote();
      const message = remoteChat(remote, data);
      if (message) addMessage(message);
    } catch {
      status('TS6 прислал неподдерживаемый формат события. Обновите клиент или переподключитесь.');
    }
  };
  ws.onerror = () => {
    if (id === epoch) status('Не удалось подключиться к TS6. Включите Remote Apps (порт 5899).');
  };
  ws.onclose = () => {
    if (id !== epoch) return;
    void disconnect(false).then(() => status('TS6 · соединение закрыто. Подключитесь снова.'));
  };
}
function connectionHelp() {
  const ts3 = $('version').value === '3';
  $('port3-label').hidden = !ts3;
  $('connection-help').textContent = ts3
    ? 'TS3: Инструменты → Параметры → Дополнения → ClientQuery. Включите плагин и скопируйте его API-ключ сюда (не пароль сервера). Слежение за текущей вкладкой TS3.'
    : 'TS6: Settings → Remote Apps → включите API (порт 5899), затем разрешите подключение Твинофермы. При нескольких серверах выберите нужный ниже. API-ключ хранится только в памяти этого окна.';
}
for (const id of ['version', 'opacity', 'fontSize', 'accent', 'messageSeconds', 'port3'])
  $(id).value = String(settings[id]);
for (const id of ['topmost', 'speakersOnly', 'showChat']) $(id).checked = settings[id];
applyAppearance();
connectionHelp();
$('version').onchange = connectionHelp;
$('server').onchange = () => {
  remote.selected = $('server').value;
  renderRemote();
};
$('connection-form').onsubmit = async event => {
  event.preventDefault();
  if (connecting) return;
  if (!window.__TAURI_INTERNALS__) {
    status('Подключение к TeamSpeak доступно только в настольном приложении.');
    return;
  }
  await disconnect(false);
  connecting = true;
  $('connect').disabled = true;
  settings = preferences({ ...settings, version: $('version').value, port3: $('port3').value });
  const id = epoch;
  status('Подключение…');
  try {
    if (settings.version === '3') await connect3(id);
    else connect6(id);
  } catch {
    if (id === epoch) {
      await disconnect(false);
      status('Подключение не удалось. Проверьте локальный API, порт и ключ TeamSpeak.');
    }
  } finally {
    if (id === epoch) {
      connecting = false;
      $('connect').disabled = false;
    }
  }
};
$('disconnect').onclick = () => void disconnect();
$('appearance-form').onsubmit = async event => {
  event.preventDefault();
  settings = preferences({
    ...settings,
    ...Object.fromEntries(['opacity', 'fontSize', 'accent', 'messageSeconds'].map(id => [id, $(id).value])),
    ...Object.fromEntries(['topmost', 'speakersOnly', 'showChat'].map(id => [id, $(id).checked]))
  });
  applyAppearance();
  renderMembers();
  if (!settings.showChat) {
    messages = [];
    $('messages').replaceChildren();
  }
  try {
    await invoke('teamspeak_topmost', { enabled: settings.topmost });
    localStorage.setItem('tf:teamspeak-appearance', JSON.stringify(settings));
    status('Настройки вида сохранены');
  } catch {
    status('Не удалось сохранить настройки вида.');
  }
};
$('settings-toggle').onclick = () => {
  $('settings').hidden = !$('settings').hidden;
  $('settings-toggle').setAttribute('aria-expanded', String(!$('settings').hidden));
};
$('drag').onpointerdown = event => {
  if (event.button === 0 && !event.target.closest('button')) void getCurrentWindow().startDragging();
};
$('close').onclick = async () => {
  // Stop local timers/socket immediately, but don't wait for a native poll's mutex.
  // The native Destroyed handler also cleans up the session on a blocking worker.
  void disconnect(false);
  await getCurrentWindow().close();
};
setInterval(renderMessages, 500);
if (window.__TAURI_INTERNALS__) void invoke('teamspeak_topmost', { enabled: settings.topmost }).catch(() => {});

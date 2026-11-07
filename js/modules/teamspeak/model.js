// Protocol state only. No audio, history persistence or third-party service calls.
export const text = (value, limit = 200) => String(value ?? '').slice(0, limit);
export function preferences(value = {}) {
  return {
    version: value.version === '3' ? '3' : '6',
    opacity: Math.max(20, Math.min(100, Number(value.opacity) || 90)),
    fontSize: Math.max(10, Math.min(24, Number(value.fontSize) || 14)),
    messageSeconds: Math.max(3, Math.min(120, Number(value.messageSeconds) || 15)),
    speakersOnly: value.speakersOnly === true,
    showChat: value.showChat !== false,
    topmost: value.topmost !== false,
    accent: /^#[0-9a-f]{6}$/i.test(value.accent) ? value.accent : '#7de4b4',
    port3: Math.max(1, Math.min(65535, Math.round(Number(value.port3) || 25639)))
  };
}
export function createRemoteState() {
  return { connections: new Map(), selected: '', authenticated: false };
}
function channels(conn, info) {
  for (const channel of [...(info?.rootChannels || []), ...Object.values(info?.subChannels || {}).flat()]) {
    conn.channels.set(
      String(channel.id),
      text(channel.properties?.name || channel.properties?.channel_name || channel.name)
    );
  }
}
function client(conn, info) {
  const id = String(info.id ?? info.clientId);
  const previous = conn.clients.get(id) || {};
  conn.clients.set(id, {
    ...previous,
    id,
    channelId: String(info.channelId ?? info.channel ?? previous.channelId ?? '0'),
    properties: { ...previous.properties, ...info.properties },
    talking: info.talkStatus === undefined ? !!previous.talking : info.talkStatus === 1
  });
}
export function remoteEvent(state, event) {
  const p = event?.payload || {};
  if (event?.type === 'auth') {
    state.connections.clear();
    state.authenticated = event.status?.code === 0;
    if (!state.authenticated) return;
    for (const info of (p.connections || []).slice(0, 30)) {
      const conn = {
        id: String(info.id),
        selfId: String(info.clientId),
        name: text(info.properties?.virtualserver_name || info.properties?.name || `Сервер ${info.id}`),
        channels: new Map(),
        clients: new Map()
      };
      channels(conn, info.channelInfos);
      for (const c of (info.clientInfos || Object.values(info.clients || {})).slice(0, 10000)) client(conn, c);
      state.connections.set(conn.id, conn);
    }
    if (!state.connections.has(state.selected)) state.selected = state.connections.keys().next().value || '';
    return;
  }
  const id = String(p.connectionId);
  if (event?.type === 'connectStatusChanged') {
    if (p.status === 0) state.connections.delete(id);
    else if (!state.connections.has(id) && state.connections.size < 30)
      state.connections.set(id, {
        id,
        selfId: String(p.info?.clientId || ''),
        name: `Сервер ${id}`,
        channels: new Map(),
        clients: new Map()
      });
    else if (p.info?.clientId) state.connections.get(id).selfId = String(p.info.clientId);
    if (!state.connections.has(state.selected)) state.selected = state.connections.keys().next().value || '';
  }
  const conn = state.connections.get(id);
  if (!conn) return;
  const member = conn.clients.get(String(p.clientId));
  switch (event.type) {
    case 'channels':
      channels(conn, p.info);
      break;
    case 'channelCreated':
    case 'channelPropertiesUpdated':
      conn.channels.set(String(p.channelId), text(p.properties?.name || p.properties?.channel_name));
      break;
    case 'channelRemoved':
      conn.channels.delete(String(p.channelId));
      break;
    case 'serverPropertiesUpdated':
      conn.name = text(p.properties?.virtualserver_name || p.properties?.name || conn.name);
      break;
    case 'talkStatusChanged':
      if (member) member.talking = p.status === 1;
      break;
    case 'clientPropertiesUpdated':
      if (member) member.properties = { ...member.properties, ...p.properties };
      break;
    case 'clientMoved':
      if (String(p.newChannelId) === '0') conn.clients.delete(String(p.clientId));
      else if (conn.clients.size < 10000 || member)
        client(conn, { id: p.clientId, channelId: p.newChannelId, properties: p.properties });
      break;
  }
}
export function remoteSnapshot(state) {
  const conn = state.connections.get(state.selected);
  const self = conn?.clients.get(conn.selfId);
  if (!self || !self.channelId || self.channelId === '0') return { connected: false, members: [] };
  return {
    connected: true,
    connectionId: conn.id,
    channelId: self.channelId,
    channel: conn.channels.get(self.channelId) || `Канал ${self.channelId}`,
    members: [...conn.clients.values()]
      .filter(c => c.channelId === self.channelId)
      .map(c => ({
        id: c.id,
        name: text(c.properties.nickname || c.properties.client_nickname || `Участник ${c.id}`),
        talking: c.talking,
        self: c.id === conn.selfId,
        muted: c.properties.inputMuted === true || c.properties.outputMuted === true
      }))
  };
}
export function remoteChat(state, event) {
  if (!['chatMessage', 'textMessage', 'textMessageReceived'].includes(event?.type)) return null;
  const p = event.payload || {},
    snapshot = remoteSnapshot(state);
  if (!snapshot.connected || String(p.connectionId) !== snapshot.connectionId) return null;
  // Never show private/server chat in the channel overlay, including unknown message shapes.
  if (!['2', 'channel'].includes(String(p.targetMode).toLowerCase())) return null;
  if (p.channelId !== undefined && String(p.channelId) !== snapshot.channelId) return null;
  const content = p.message ?? p.msg ?? p.text;
  if (typeof content !== 'string' || !content.trim()) return null;
  const conn = state.connections.get(state.selected);
  const member = conn.clients.get(String(p.invokerId ?? p.fromId ?? p.clientId));
  return {
    author: text(p.invokerName ?? p.fromName ?? member?.properties?.nickname ?? 'Участник'),
    text: text(content, 2000)
  };
}
export function visibleMessages(messages, seconds, now = Date.now()) {
  return messages.filter(m => now - m.at < seconds * 1000).slice(-30);
}

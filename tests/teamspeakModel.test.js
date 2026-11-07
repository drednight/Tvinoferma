import { it, expect } from 'vitest';
import {
  preferences,
  createRemoteState,
  remoteEvent,
  remoteSnapshot,
  remoteChat,
  visibleMessages
} from '../js/modules/teamspeak/model.js';
const fixture = () => ({
  type: 'auth',
  status: { code: 0 },
  payload: {
    apiKey: 'secret',
    connections: [
      {
        id: 1,
        clientId: 10,
        properties: { virtualserver_name: 'Server' },
        channelInfos: { rootChannels: [{ id: 3, properties: { name: 'Party' } }], subChannels: {} },
        clientInfos: [
          { id: 10, channelId: 3, properties: { nickname: 'Me' } },
          { id: 11, channelId: 3, properties: { nickname: '<b>Other</b>' } },
          { id: 12, channelId: 4, properties: { nickname: 'Outside' } }
        ]
      }
    ]
  }
});
it('normalizes only appearance settings and never persists keys', () => {
  expect(
    preferences({ apiKey: 'secret', opacity: 0, messageSeconds: 999, fontSize: 60, accent: 'url(x)' })
  ).toMatchObject({ messageSeconds: 120, fontSize: 24, accent: '#7de4b4' });
  expect(preferences({ apiKey: 'secret' })).not.toHaveProperty('apiKey');
});
it('shows only own channel and follows self movement', () => {
  const state = createRemoteState();
  remoteEvent(state, fixture());
  expect(remoteSnapshot(state)).toMatchObject({
    channel: 'Party',
    channelId: '3',
    members: [
      { name: 'Me', self: true },
      { name: '<b>Other</b>', self: false }
    ]
  });
  remoteEvent(state, {
    type: 'clientMoved',
    payload: { connectionId: 1, clientId: 10, newChannelId: 4, properties: {} }
  });
  expect(remoteSnapshot(state).members.map(m => m.name)).toEqual(['Me', 'Outside']);
});
it('updates talking, mute and nick without dropping channel assignment', () => {
  const state = createRemoteState();
  remoteEvent(state, fixture());
  remoteEvent(state, { type: 'talkStatusChanged', payload: { connectionId: 1, clientId: 11, status: 1 } });
  remoteEvent(state, {
    type: 'clientPropertiesUpdated',
    payload: { connectionId: 1, clientId: 11, properties: { nickname: 'Renamed', inputMuted: true } }
  });
  expect(remoteSnapshot(state).members[1]).toMatchObject({ name: 'Renamed', talking: true, muted: true });
  remoteEvent(state, { type: 'talkStatusChanged', payload: { connectionId: 1, clientId: 11, status: 0 } });
  expect(remoteSnapshot(state).members[1].talking).toBe(false);
});
it('does not leak membership after disconnect, leaving channel or rejected auth', () => {
  const state = createRemoteState();
  remoteEvent(state, fixture());
  remoteEvent(state, { type: 'clientMoved', payload: { connectionId: 1, clientId: 11, newChannelId: 0 } });
  expect(remoteSnapshot(state).members).toHaveLength(1);
  remoteEvent(state, { type: 'connectStatusChanged', payload: { connectionId: 1, status: 0 } });
  expect(remoteSnapshot(state)).toMatchObject({ connected: false, members: [] });
  remoteEvent(state, { ...fixture(), status: { code: 1 } });
  expect(state.authenticated).toBe(false);
  expect(state.connections.size).toBe(0);
});
it('isolates multiple TS6 server connections', () => {
  const state = createRemoteState(),
    auth = fixture();
  auth.payload.connections.push({ ...auth.payload.connections[0], id: 2 });
  remoteEvent(state, auth);
  remoteEvent(state, { type: 'talkStatusChanged', payload: { connectionId: 2, clientId: 11, status: 1 } });
  expect(remoteSnapshot(state).members[1].talking).toBe(false);
  state.selected = '2';
  expect(remoteSnapshot(state).members[1].talking).toBe(true);
});
it('only accepts channel chat for the selected connection; unknown/private/server scopes are rejected', () => {
  const state = createRemoteState();
  remoteEvent(state, fixture());
  const chat = {
    type: 'chatMessage',
    payload: { connectionId: 1, channelId: 3, targetMode: 2, invokerId: 11, message: 'Hi' }
  };
  expect(remoteChat(state, chat)).toEqual({ author: '<b>Other</b>', text: 'Hi' });
  for (const targetMode of [undefined, 1, 3, 'private'])
    expect(remoteChat(state, { ...chat, payload: { ...chat.payload, targetMode } })).toBeNull();
  expect(remoteChat(state, { ...chat, payload: { ...chat.payload, connectionId: 2 } })).toBeNull();
  expect(remoteChat(state, { ...chat, payload: { ...chat.payload, channelId: 9 } })).toBeNull();
});
it('expires messages and bounds retained visible history', () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ at: i * 1000 }));
  expect(visibleMessages(messages, 15, 100000)).toHaveLength(14);
  expect(visibleMessages(messages, 120, 100000)).toHaveLength(30);
});

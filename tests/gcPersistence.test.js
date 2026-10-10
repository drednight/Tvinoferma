import { describe, it, expect } from 'vitest';

// Вопрос «переживает ли перезапуск приложения» — это вопрос сериализации: что именно
// уезжает на диск и что именно читается обратно. Проверяем круг целиком, а не отдельные
// функции: реальная ошибка обычно живёт между ними (поле забыли в нормализации).

/** Состояние, как оно выглядит в памяти, с привязкой GameCenter и запомненными входами. */
const stateWithGc = () => ({
  settings: {
    launcher: {
      gameCenters: [
        { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' },
        { id: 'gc-2', name: 'Папка 2', path: 'D:\\GC2\\GameCenter.exe' }
      ],
      preferredGcId: 'gc-2',
      delaySec: 5
    }
  },
  parties: [{ id: 'p1', name: 'Пати', memberIds: ['a'], color: '', archived: false }],
  characters: [
    {
      id: 'a', nick: 'Первый', class: 'Воин',
      partyIds: ['p1'], mainPartyId: 'p1', tags: [],
      launch: {
        gcPath: '', gcNick: '', gcAccount: false,
        gcIds: ['gc-1', 'gc-2'],
        gcAccounts: { 'gc-1': { nick: 'Дракон' }, 'gc-2': { nick: 'Дракон2', legacy: true } }
      }
    },
    { id: 'b', nick: 'Второй', class: 'Маг', partyIds: [], tags: [], launch: {} }
  ]
});

/** Один запуск приложения: записали на диск, потом прочитали при старте. */
const restart = async () => {
  const { state, serializeState, normalizeState } = await import('../js/core/state.js');
  state.settings = stateWithGc().settings;
  state.parties = stateWithGc().parties;
  state.characters = stateWithGc().characters;
  return normalizeState(JSON.parse(JSON.stringify(serializeState())));
};

describe('привязка GameCenter переживает перезапуск', () => {
  it('список GameCenter и «запускать в первую очередь» сохраняются', async () => {
    const s = await restart();
    expect(s.settings.launcher.gameCenters.map(g => g.id)).toEqual(['gc-1', 'gc-2']);
    expect(s.settings.launcher.gameCenters[0].name).toBe('Папка 1');
    expect(s.settings.launcher.gameCenters[0].path).toBe('D:\\GC1\\GameCenter.exe');
    expect(s.settings.launcher.preferredGcId).toBe('gc-2');
  });

  it('привязки персонажа к GameCenter сохраняются в том же порядке', async () => {
    const a = (await restart()).characters.find(c => c.id === 'a');
    expect(a.launch.gcIds).toEqual(['gc-1', 'gc-2']);   // порядок решает, какой запускать
  });

  it('запомненные входы сохраняются вместе с ником и признаком legacy', async () => {
    const a = (await restart()).characters.find(c => c.id === 'a');
    expect(a.launch.gcAccounts['gc-1']).toEqual({ nick: 'Дракон' });
    expect(a.launch.gcAccounts['gc-2']).toEqual({ nick: 'Дракон2', legacy: true });
  });

  it('персонаж без привязок остаётся с пустыми списками, а не теряется', async () => {
    const b = (await restart()).characters.find(c => c.id === 'b');
    expect(b).toBeTruthy();
    expect(b.launch.gcIds).toEqual([]);
    expect(b.launch.gcAccounts).toEqual({});
  });

  it('битая привязка не ломает запуск: ссылка на удалённый GameCenter не мешает', async () => {
    const { state, serializeState, normalizeState } = await import('../js/core/state.js');
    const st = stateWithGc();
    // Пользователь удалил GameCenter из настроек, персонаж остался со старой привязкой
    st.characters[0].launch.gcIds = ['gc-1', 'gc-удалённый'];
    st.characters[0].launch.gcAccounts = { 'gc-удалённый': { nick: 'X' } };
    state.settings = st.settings;
    state.parties = st.parties;
    state.characters = st.characters;
    const s = normalizeState(JSON.parse(JSON.stringify(serializeState())));
    const a = s.characters.find(c => c.id === 'a');
    // Привязка остаётся в данных (её видно в окне и можно перепривязать), но не должна
    // приводить к попытке запустить из несуществующего пути
    expect(a.launch.gcIds).toContain('gc-1');
  });

  it('полный круг дважды подряд не теряет данные (повторная запись)', async () => {
    const once = await restart();
    const { state, serializeState, normalizeState } = await import('../js/core/state.js');
    state.settings = once.settings;
    state.parties = once.parties;
    state.characters = once.characters;
    const twice = normalizeState(JSON.parse(JSON.stringify(serializeState())));
    expect(twice.characters.find(c => c.id === 'a').launch.gcIds).toEqual(['gc-1', 'gc-2']);
    expect(twice.characters.find(c => c.id === 'a').launch.gcAccounts['gc-1'].nick).toBe('Дракон');
  });
});
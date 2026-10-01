import { describe, it, expect } from 'vitest';
import { slugifyNick, characterIdFor, planCharacterIds, remapIdsDeep } from '../js/core/ids.js';
import { migrateState } from '../js/core/migrations.js';
import { normalizeState } from '../js/core/state.js';

describe('читаемые id персонажей', () => {
  it('строит id из ника: латиница, цифры, _ и -', () => {
    expect(slugifyNick('DragonSlayer#1')).toBe('DragonSlayer_1');
    expect(slugifyNick('Тёмный Маг')).toBe('Temnyy_Mag');
    expect(slugifyNick('  ***  ')).toBe('char');
    expect(slugifyNick('Con')).toBe('Con_');
    expect(slugifyNick('a'.repeat(60))).toHaveLength(40);
  });

  it('делает id уникальным без учёта регистра', () => {
    expect(characterIdFor('Mage', ['mage'])).toBe('Mage-2');
    expect(characterIdFor('Mage', ['Mage', 'Mage-2'])).toBe('Mage-3');
    expect(characterIdFor('Mage', ['Mage'], 'Mage')).toBe('Mage');
  });

  it('planCharacterIds возвращает только изменившиеся', () => {
    const remap = planCharacterIds([{ id: 'uuid-1', nick: 'A' }, { id: 'A-2', nick: 'A' }]);
    expect([...remap]).toEqual([['uuid-1', 'A']]);
  });

  it('remapIdsDeep меняет и значения, и ключи', () => {
    const out = remapIdsDeep({ participantIds: ['u1', 'x'], progress: { u1: { t: 1 } } }, new Map([['u1', 'Nick']]));
    expect(out).toEqual({ participantIds: ['Nick', 'x'], progress: { Nick: { t: 1 } } });
  });
});

describe('миграция v4', () => {
  it('переименовывает персонажей и ссылки в марафонах', () => {
    const raw = {
      schemaVersion: 3,
      characters: [{ id: '11111111-aaaa', nick: 'Маг#1' }, { id: '22222222-bbbb', nick: 'маг 1' }],
      marathons: [{ id: 'm1', title: 'M', participantIds: ['11111111-aaaa', '22222222-bbbb'], progress: { '11111111-aaaa': {} } }]
    };
    const res = migrateState(raw);
    expect(res.idRemap).toEqual({ '11111111-aaaa': 'Mag_1', '22222222-bbbb': 'mag_1-2' });
    expect(res.state.characters.map(c => c.id)).toEqual(['Mag_1', 'mag_1-2']);
    expect(res.state.marathons[0].participantIds).toEqual(['Mag_1', 'mag_1-2']);
    expect(Object.keys(res.state.marathons[0].progress)).toEqual(['Mag_1']);
    expect(res.state.__idRemap).toBeUndefined();
  });

  it('новым персонажам без id назначается id из ника', () => {
    const st = normalizeState({ schemaVersion: 4, characters: [{ nick: 'Bob' }, { nick: 'bob' }] });
    expect(st.characters.map(c => c.id)).toEqual(['Bob', 'bob-2']);
  });
});

import { state } from '../js/core/state.js';
import { syncIdWithNick } from '../js/modules/characters/identity.js';

describe('смена ника', () => {
  it('меняет id и ссылки в марафонах', async () => {
    state.characters = [{ id: 'Old', nick: 'New Name' }, { id: 'New_Name', nick: 'Другой' }];
    state.marathons = [{ id: 'm', participantIds: ['Old'], progress: { Old: { t: 1 } } }];
    state.ui.selection = new Set(['Old']);
    const res = await syncIdWithNick(state.characters[0]);
    expect(res).toEqual({ id: 'New_Name-2', changed: true });
    expect(state.marathons[0].participantIds).toEqual(['New_Name-2']);
    expect(state.marathons[0].progress).toHaveProperty('New_Name-2');
    expect(state.ui.selection.has('New_Name-2')).toBe(true);
  });
});

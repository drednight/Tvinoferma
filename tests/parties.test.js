import { describe, it, expect } from 'vitest';
import {
  resolveMainPartyId, ensureMainParty, setMainParty, mainPartyName, additionalPartiesOf, charactersInMainParty, isMainParty,
  normalizePartyIds, partiesOf, partyNamesOf, isInParty, hasNoParty, charactersInParty,
  setMembership, removePartyFromAll, sweepPartyIds, planPartyImport, remapCharacterParties, totalCoins, coinSummary
} from '../js/modules/parties/membership.js';
import { planImport } from '../js/data/import.js';
import { normalizeState, normalizeCharacter } from '../js/core/state.js';
import { presentPaths, diffCharacters, mergeValues, ALL_FIELDS, displayValue, setPartyNameResolver } from '../js/data/characterFields.js';

const parties = [{ id: 'a', name: 'Основа', order: 1 }, { id: 'b', name: 'Крипы', order: 2 }];
const mk = (id, partyIds = [], coins = 0, mainPartyId = partyIds[0] || null) => ({ id, nick: id, partyIds, mainPartyId, ancientCoins: coins });

describe('членство в партиях (issue #4)', () => {
  it('normalizePartyIds: без пустых и дублей', () => {
    expect(normalizePartyIds(['a', ' a ', '', null, 'b'])).toEqual(['a', 'b']);
    expect(normalizePartyIds('x')).toEqual(['x']);
    expect(normalizePartyIds(undefined)).toEqual([]);
  });

  it('персонаж в нескольких пати: сначала основная, затем дополнительные', () => {
    const c = mk('X', ['b', 'a']); // основная — первая в списке (b)
    expect(partyNamesOf(c, parties)).toEqual(['Крипы', 'Основа']);
    expect(mainPartyName(c, parties)).toBe('Крипы');
    expect(partiesOf(mk('Y', ['ghost']), parties)).toEqual([]);
    expect(hasNoParty(mk('Y', ['ghost']), parties)).toBe(true);
  });

  it('setMembership добавляет и убирает ровно одну пати', () => {
    const c = mk('X', ['a']);
    expect(setMembership(c, 'b', true)).toBe(true);
    expect(c.partyIds).toEqual(['a', 'b']);
    expect(setMembership(c, 'b', true)).toBe(false);
    expect(setMembership(c, 'a', false)).toBe(true);
    expect(c.partyIds).toEqual(['b']);
  });

  it('удаление пати убирает её у всех, остальные пати остаются', () => {
    const chars = [mk('X', ['a', 'b']), mk('Y', ['a']), mk('Z', [])];
    expect(removePartyFromAll(chars, 'a')).toBe(2);
    expect(chars.map(c => c.partyIds)).toEqual([['b'], [], []]);
  });

  it('sweepPartyIds убирает ссылки на несуществующие пати', () => {
    const chars = [mk('X', ['a', 'ghost'])];
    expect(sweepPartyIds(chars, parties)).toBe(1);
    expect(chars[0].partyIds).toEqual(['a']);
  });
});

describe('основная и дополнительные пати', () => {
  it('основная — первая из списка, если не задана; неверная заменяется', () => {
    expect(resolveMainPartyId(['a', 'b'], 'b')).toBe('b');
    expect(resolveMainPartyId(['a', 'b'], 'ghost')).toBe('a');
    expect(resolveMainPartyId([], 'a')).toBe(null);
  });

  it('первая добавленная пати становится основной, следующие — дополнительными', () => {
    const c = mk('X', []);
    setMembership(c, 'a', true);
    setMembership(c, 'b', true);
    expect(c.mainPartyId).toBe('a');
    expect(partyNamesOf(c, parties)).toEqual(['Основа', 'Крипы']);
    expect(additionalPartiesOf(c, parties).map(p => p.id)).toEqual(['b']);
  });

  it('основная всегда первой в списке названий, даже если порядок партий другой', () => {
    const c = mk('X', ['a', 'b'], 0, 'b');
    expect(partyNamesOf(c, parties)).toEqual(['Крипы', 'Основа']);
    expect(mainPartyName(c, parties)).toBe('Крипы');
  });

  it('убрали основную — основной становится следующая; убрали все — null', () => {
    const c = mk('X', ['a', 'b'], 0, 'a');
    setMembership(c, 'a', false);
    expect(c.mainPartyId).toBe('b');
    setMembership(c, 'b', false);
    expect(c.mainPartyId).toBe(null);
  });

  it('setMainParty: прежняя основная остаётся дополнительной, новая добавляется при необходимости', () => {
    const c = mk('X', ['a']);
    expect(setMainParty(c, 'b')).toBe(true);
    expect(c.partyIds).toEqual(['a', 'b']);
    expect(c.mainPartyId).toBe('b');
    expect(isMainParty(c, 'b')).toBe(true);
    ensureMainParty(c);
    expect(c.mainPartyId).toBe('b');
  });

  it('sweepPartyIds переназначает основную, если её пати удалена', () => {
    const c = mk('X', ['ghost', 'b'], 0, 'ghost');
    sweepPartyIds([c], parties);
    expect(c.mainPartyId).toBe('b');
  });
});

describe('монеты: по основной пати, двойного счёта нет', () => {
  const chars = [mk('X', ['a', 'b'], 100), mk('Y', ['a'], 28.5), mk('Z', [], 10), mk('W', ['b', 'a'], 5)];
  it('totalCoins считает каждого один раз', () => {
    expect(totalCoins(chars)).toBe(143.5);
    expect(totalCoins([...chars, chars[0]])).toBe(143.5);
  });
  it('персонаж в двух пати идёт в монеты только основной; сумма по пати + без пати = общий итог', () => {
    const s = coinSummary(parties, chars);
    expect(s.perParty).toEqual({ a: 128.5, b: 5 }); // X и Y — основная «Основа», W — основная «Крипы»
    expect(s.noParty).toBe(10);
    expect(s.perParty.a + s.perParty.b + s.noParty).toBe(s.overall);
  });
  it('для марафона персонаж доступен только в группе основной пати', () => {
    expect(charactersInMainParty(chars, 'a').map(c => c.id)).toEqual(['X', 'Y']);
    expect(charactersInMainParty(chars, 'b').map(c => c.id)).toEqual(['W']);
    expect(charactersInParty(chars, 'b').map(c => c.id)).toEqual(['X', 'W']); // фильтр на вкладке персонажей — по любой
  });
});

describe('импорт: партии из файла (старый и новый формат)', () => {
  it('партии сопоставляются по названию, новые добавляются, id в персонажах переписываются', () => {
    const local = [{ id: 'L1', name: 'основа', order: 1 }];
    const incoming = [{ id: 'f1', name: 'Основа' }, { id: 'f2', name: 'Новая' }];
    const plan = planPartyImport(local, incoming);
    expect(plan.idMap.get('f1')).toBe('L1');
    expect(plan.newParties.map(p => p.name)).toEqual(['Новая']);
    const remapped = remapCharacterParties([mk('X', ['f1', 'f2'])], plan.idMap);
    expect(remapped[0].partyIds).toEqual(['L1', plan.idMap.get('f2')]);
    const main = remapCharacterParties([mk('Y', ['f1', 'f2'], 0, 'f2')], plan.idMap)[0];
    expect(main.mainPartyId).toBe(plan.idMap.get('f2')); // основная переносится вместе с id
  });

  it('id новой пати, занятый другой локальной пати, заменяется', () => {
    const plan = planPartyImport([{ id: 'same', name: 'A' }], [{ id: 'same', name: 'B' }]);
    expect(plan.newParties[0].id).not.toBe('same');
    expect(plan.idMap.get('same')).toBe(plan.newParties[0].id);
  });

  it('файл старого формата (party: название) открывается без потерь', () => {
    const raw = { schemaVersion: 4, parties: [{ name: 'Основа', order: 1 }], characters: [{ id: 'A', nick: 'A', party: 'Основа' }, { id: 'B', nick: 'B', party: 'Другая' }] };
    const st = normalizeState(raw);
    expect(st.parties.map(p => p.name)).toEqual(['Основа', 'Другая']);
    expect(partyNamesOf(st.characters[0], st.parties)).toEqual(['Основа']);
    expect(partyNamesOf(st.characters[1], st.parties)).toEqual(['Другая']);
    expect(mainPartyName(st.characters[0], st.parties)).toBe('Основа'); // единственная пати старого формата — основная
    expect(presentPaths(raw.characters[0]).has('partyIds')).toBe(true); // пати из файла участвуют в сравнении
  });

  it('сравнение карточек: разные наборы пати — отличие; «объединить» делает объединение', () => {
    const local = normalizeCharacter({ id: 'A', nick: 'A', partyIds: ['a'] });
    const inc = normalizeCharacter({ id: 'A', nick: 'A', partyIds: ['a', 'b'] });
    expect(diffCharacters(local, inc).map(f => f.path)).toEqual(['partyIds']);
    expect(normalizeCharacter({ id: 'A', nick: 'A', partyIds: ['a', 'b'], mainPartyId: 'zzz' }).mainPartyId).toBe('a');
    const f = ALL_FIELDS.find(x => x.path === 'partyIds');
    expect(mergeValues(f, ['a'], ['a', 'b'])).toEqual(['a', 'b']);
    setPartyNameResolver(id => ({ a: 'Основа', b: 'Крипы' })[id]);
    expect(displayValue(f, ['a', 'b'])).toBe('Основа, Крипы');
    setPartyNameResolver(null);
  });
});

describe('примечания (issue #20)', () => {
  it('normalizeCharacter сохраняет notes, по умолчанию пусто', () => {
    expect(normalizeCharacter({ id: 'a', nick: 'A', notes: 'докачать до 100' }).notes).toBe('докачать до 100');
    expect(normalizeCharacter({ id: 'a', nick: 'A' }).notes).toBe('');
  });
  it('notes участвует в сравнении при импорте и в окне объединения', () => {
    const local = normalizeCharacter({ id: 'a', nick: 'A', notes: 'старая' });
    const inc = normalizeCharacter({ id: 'a', nick: 'A', notes: 'новая' });
    const plan = planImport([local], [inc]);
    expect(plan.conflicts[0].diffs.map(f => f.path)).toEqual(['notes']);
  });
  it('поле не входит в файл → текущее примечание не затирается', () => {
    const raw = { id: 'a', nick: 'A' };
    expect(presentPaths(raw).has('notes')).toBe(false);
  });
});

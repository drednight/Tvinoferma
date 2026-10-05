import { describe, it, expect } from 'vitest';
import {
  normalizeGameCenters, resolveGameCenter, accountKey, attachGc, detachGc, replaceGc, setGcAccount,
  accountKeysOf, removeGameCenter, importLegacyPaths, suggestGcName, samePathKey, countLaunchReady, pickMajorityGc
} from '../js/modules/launcher/gameCenters.js';
import { launchCharacters, launchable, launchPlan, loginStatusText } from '../js/modules/launcher/launch.js';
import { normalizeCharacter, normalizeState } from '../js/core/state.js';

const GC1 = { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' };
const GC2 = { id: 'gc-2', name: 'Папка 2', path: 'D:\\GC2\\GameCenter.exe' };
const ctx = (preferredId = '') => ({ gameCenters: [GC1, GC2], preferredId });
const ch = (id, launch = {}) => ({ id, nick: id, launch });

describe('GameCenter: общий список', () => {
  it('список очищается: без id/пути и повторов, имя по умолчанию', () => {
    const list = normalizeGameCenters([GC1, { ...GC1, name: 'дубль' }, { id: '', path: 'x' }, { id: 'z', path: '' }, { id: 'n', path: 'P' }, null]);
    expect(list.map(g => g.id)).toEqual(['gc-1', 'n']);
    expect(list[1].name).toBe('GameCenter');
    expect(normalizeGameCenters(null)).toEqual([]);
  });

  it('название по умолчанию — имя папки; если занято — «GameCenter N»', () => {
    expect(suggestGcName('D:\\Games\\GC2\\GameCenter.exe', [])).toBe('GC2');
    expect(suggestGcName('D:\\Games\\GC2\\GameCenter.exe', [{ name: 'gc2' }])).toBe('GameCenter 2');
  });

  it('пути сравниваются без учёта регистра, слэшей и имени файла', () => {
    expect(samePathKey('D:/GC1/')).toBe(samePathKey('d:\\gc1\\GameCenter.exe'));
    expect(samePathKey('D:\\GC1')).not.toBe(samePathKey('D:\\GC2'));
  });

  it('настройки: список и выбранный GameCenter нормализуются, лишний выбор сбрасывается', () => {
    const s = normalizeState({ characters: [], settings: { launcher: { gameCenters: [GC1, GC2], preferredGcId: 'gc-2' } } }).settings.launcher;
    expect(s.gameCenters).toHaveLength(2);
    expect(s.preferredGcId).toBe('gc-2');
    const bad = normalizeState({ characters: [], settings: { launcher: { gameCenters: [GC1], preferredGcId: 'нет-такого' } } }).settings.launcher;
    expect(bad.preferredGcId).toBe('');
    expect(normalizeState({ characters: [], settings: {} }).settings.launcher.gameCenters).toEqual([]);
  });

  it('персонаж: gcIds без повторов, gcAccounts только объекты', () => {
    const c = normalizeCharacter({ nick: 'X', launch: { gcIds: ['gc-1', ' gc-1 ', '', 'gc-2'], gcAccounts: { 'gc-1': { nick: ' Twin ', legacy: true, token: 'SECRET' }, bad: 5 } } });
    expect(c.launch.gcIds).toEqual(['gc-1', 'gc-2']);
    expect(c.launch.gcAccounts).toEqual({ 'gc-1': { nick: ' Twin ', legacy: true } });
    expect(JSON.stringify(c)).not.toContain('SECRET');
  });
});

describe('GameCenter: какой запускать', () => {
  it('выбран «Папка 2», он есть у персонажа — запускается из него', () => {
    expect(resolveGameCenter(ch('a', { gcIds: ['gc-1', 'gc-2'] }), ctx('gc-2')).path).toBe(GC2.path);
  });

  it('«Папки 2» у персонажа нет — запускается из доступного ему', () => {
    expect(resolveGameCenter(ch('a', { gcIds: ['gc-1'] }), ctx('gc-2')).path).toBe(GC1.path);
  });

  it('ничего не выбрано — берётся первый из списка персонажа', () => {
    expect(resolveGameCenter(ch('a', { gcIds: ['gc-2', 'gc-1'] }), ctx('')).gc.id).toBe('gc-2');
  });

  it('GameCenter из списка важнее своего пути; без списка работает свой путь; без всего — null', () => {
    expect(resolveGameCenter(ch('a', { gcIds: ['gc-1'], gcPath: 'D:\\own' }), ctx()).path).toBe(GC1.path);
    const own = resolveGameCenter(ch('a', { gcPath: ' D:\\own ', gcNick: 'Twin', gcAccount: true }), ctx());
    expect(own).toEqual({ path: 'D:\\own', key: 'a', nick: 'Twin', saved: true, gc: null });
    expect(resolveGameCenter(ch('a', {}), ctx())).toBeNull();
    expect(resolveGameCenter(ch('a', { gcIds: ['удалён'] }), ctx())).toBeNull();
  });

  it('вход запоминается отдельно для каждого GameCenter персонажа', () => {
    const c = ch('a', { gcIds: ['gc-1', 'gc-2'] });
    setGcAccount(c, 'gc-2', 'Twin');
    expect(accountKey(c, 'gc-1')).toBe('a@gc-1');
    expect(accountKey(c, 'gc-2')).toBe('a@gc-2');
    const r = resolveGameCenter(c, ctx('gc-2'));
    expect(r).toMatchObject({ key: 'a@gc-2', nick: 'Twin', saved: true });
    expect(resolveGameCenter(c, ctx('gc-1'))).toMatchObject({ key: 'a@gc-1', nick: '', saved: false });
  });

  it('перенесённый вход (legacy) остаётся под прежним ключом — id персонажа', () => {
    const c = ch('a', { gcIds: ['gc-1'] });
    setGcAccount(c, 'gc-1', 'Twin', true);
    expect(accountKey(c, 'gc-1')).toBe('a');
    expect(accountKeysOf(c)).toEqual(['a']);
  });
});

describe('GameCenter: выбор по большинству участников пати', () => {
  const pc = (id, ids) => ch(id, { gcIds: ids });
  const base = { gameCenters: [GC1, GC2], preferredId: '' };

  it('побеждает GameCenter, которым пользуется больше персонажей', () => {
    const party = [pc('a', ['gc-2']), pc('b', ['gc-2']), pc('c', ['gc-1'])];
    const m = pickMajorityGc(party, base);
    expect(m).toMatchObject({ count: 2, total: 3, distinct: 2 });
    expect(m.gc.id).toBe('gc-2');
  });

  it('учитывает все прикреплённые GameCenter, а не только первый', () => {
    const party = [pc('a', ['gc-1', 'gc-2']), pc('b', ['gc-2', 'gc-1']), pc('c', ['gc-1'])];
    expect(pickMajorityGc(party, base).gc.id).toBe('gc-1');
  });

  it('ничья: сначала «в первую очередь» из настроек, потом порядок списка', () => {
    const party = [pc('a', ['gc-1']), pc('b', ['gc-2'])];
    expect(pickMajorityGc(party, base).gc.id).toBe('gc-1');
    expect(pickMajorityGc(party, { ...base, preferredId: 'gc-2' }).gc.id).toBe('gc-2');
  });

  it('у кого нет выбранного GameCenter — запускается из доступного ему', () => {
    const party = [pc('a', ['gc-2']), pc('b', ['gc-2']), pc('c', ['gc-1'])];
    const ctxMajor = { ...base, preferredId: pickMajorityGc(party, base).gc.id };
    expect(party.map(c => resolveGameCenter(c, ctxMajor).gc.id)).toEqual(['gc-2', 'gc-2', 'gc-1']);
  });

  it('без GameCenter из списка — null; персонажи только со своим путём не учитываются', () => {
    expect(pickMajorityGc([], base)).toBeNull();
    expect(pickMajorityGc([ch('a', { gcPath: 'D:\\own' }), pc('b', ['нет такого'])], base)).toBeNull();
    expect(pickMajorityGc([pc('a', ['gc-1'])], base)).toMatchObject({ distinct: 1, total: 1 });
  });
});

describe('GameCenter: привязка персонажей', () => {
  it('прикрепить, не дублировать, заменить, открепить', () => {
    const c = ch('a');
    attachGc(c, 'gc-1'); attachGc(c, 'gc-1'); attachGc(c, 'gc-2');
    expect(c.launch.gcIds).toEqual(['gc-1', 'gc-2']);
    setGcAccount(c, 'gc-1', 'Twin');
    replaceGc(c, 0, 'gc-2'); // gc-2 уже есть — замена не выполняется
    expect(c.launch.gcIds).toEqual(['gc-1', 'gc-2']);
    detachGc(c, 'gc-1');
    expect(c.launch.gcIds).toEqual(['gc-2']);
    expect(c.launch.gcAccounts).toEqual({}); // вместе с привязкой уходит и запомненный вход
  });

  it('удаление GameCenter открепляет его от всех и возвращает ключи входов для очистки', () => {
    const a = ch('a', { gcIds: ['gc-1', 'gc-2'] });
    const b = ch('b', { gcIds: ['gc-2'] });
    setGcAccount(a, 'gc-2', 'A');
    setGcAccount(b, 'gc-2', 'B', true); // legacy: ключ общий со «своим путём», его не удаляем
    const l = { gameCenters: [GC1, GC2], preferredGcId: 'gc-2' };
    const keys = removeGameCenter(l, [a, b], 'gc-2');
    expect(keys).toEqual(['a@gc-2']);
    expect(l).toEqual({ gameCenters: [GC1], preferredGcId: '' });
    expect(a.launch.gcIds).toEqual(['gc-1']);
    expect(b.launch.gcIds).toEqual([]);
  });

  it('перенос путей из карточек: одинаковые пути — один GameCenter, вход сохраняется', () => {
    const a = ch('a', { gcPath: 'D:\\GC1', gcAccount: true, gcNick: 'Twin' });
    const b = ch('b', { gcPath: 'd:/gc1/GameCenter.exe' });
    const c = ch('c', { gcPath: 'D:\\GC2' });
    const d = ch('d', {});
    const l = { gameCenters: [] };
    expect(importLegacyPaths(l, [a, b, c, d])).toEqual({ created: 2, attached: 3 });
    expect(l.gameCenters.map(g => g.name)).toEqual(['GC1', 'GC2']);
    expect(a.launch.gcIds).toEqual(b.launch.gcIds);
    expect(accountKey(a, a.launch.gcIds[0])).toBe('a');
    expect(resolveGameCenter(a, { gameCenters: l.gameCenters })).toMatchObject({ key: 'a', nick: 'Twin', saved: true });
    expect(importLegacyPaths(l, [a, b, c, d])).toEqual({ created: 0, attached: 0 }); // повтор ничего не меняет
  });

  it('сколько персонажей готово к запуску', () => {
    expect(countLaunchReady([ch('a', { gcIds: ['gc-1'] }), ch('b', { gcPath: 'x' }), ch('c', {})], ctx())).toBe(2);
  });
});

describe('GameCenter: запуск', () => {
  it('в команду запуска уходит путь выбранного GameCenter и ключ входа этого GameCenter', async () => {
    const seen = [];
    const invoke = async (cmd, args) => { seen.push(args); return {}; };
    const a = ch('a', { gcIds: ['gc-1', 'gc-2'], gcAccounts: { 'gc-2': { nick: 'Twin' } } });
    const b = ch('b', { gcIds: ['gc-1'] });
    const own = ch('own', { gcPath: 'D:\\own' });
    await launchCharacters([a, b, own], { delayMs: 0, gcId: 'gc-2' }, { invoke, ctx: ctx() });
    expect(seen.map(x => [x.path, x.charId, x.nick])).toEqual([
      [GC2.path, 'a@gc-2', 'Twin'], // «Папка 2» есть
      [GC1.path, 'b@gc-1', null],   // «Папки 2» нет — из доступной
      ['D:\\own', 'own', null]      // старый путь из карточки
    ]);
  });

  it('план запуска и фильтр учитывают GameCenter из списка', () => {
    const list = [ch('a', { gcIds: ['gc-1'] }), ch('b', {}), ch('c', { gcPath: 'x' })];
    expect(launchable(list, ctx()).map(c => c.id)).toEqual(['a', 'c']);
    expect(launchPlan(list, ctx()).skipped.map(c => c.id)).toEqual(['b']);
  });

  it('подсказка в карточке называет GameCenter и сохранённый вход', () => {
    const c = ch('a', { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'Twin' } } });
    expect(loginStatusText(c, ctx())).toBe('GameCenter «Папка 1». Вход запомнен «Twin». При запуске этот GameCenter будет закрыт и откроется под этим аккаунтом.');
    expect(loginStatusText(ch('b', { gcIds: ['gc-2'] }), ctx())).toContain('Вход не запомнен');
  });
});

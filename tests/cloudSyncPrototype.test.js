// Только прототип: фиктивные устройства и «облако» живут в памяти теста.
import { describe, expect, it, vi } from 'vitest';
import { equalValue, exampleRecords, MemoryTransport, mergeRecords, SyncPrototype } from '../demo/cloud-sync/model.js';

const ID = 'example-char-01';
const note = (engine, device, value) => engine.edit(device, ID, { note: value });
const setup = () => {
  const engine = new SyncPrototype();
  expect(engine.connect('second').status).toBe('connected');
  return engine;
};

describe('прототип синхронизации: два ПК и очередь', () => {
  it('подключает только пустой второй ПК и не перезаписывает существующий пример', () => {
    const engine = new SyncPrototype();
    expect(engine.snapshot().devices.second.records).toEqual({});
    engine.device('second').records = exampleRecords();
    engine.device('second').records[ID].fields.note = 'Уже есть на втором ПК';
    expect(engine.connect('second').status).toBe('needs_review');
    expect(engine.snapshot().devices.second.records[ID].fields.note).toBe('Уже есть на втором ПК');
    expect(engine.snapshot().devices.second.connected).toBe(false);
  });

  it('правки без интернета ждут в очереди и передаются после восстановления связи', () => {
    const engine = setup();
    engine.setOnline('second', false);
    note(engine, 'second', 'Сохранено без сети');
    expect(engine.synchronize('second').status).toBe('offline');
    expect(engine.snapshot().devices.second.pending).toHaveLength(1);
    expect(engine.snapshot().cloud.records[ID].fields.note).not.toBe('Сохранено без сети');
    engine.setOnline('second', true);
    expect(engine.synchronize('second').status).toBe('synced');
    expect(engine.synchronize('first').status).toBe('synced');
    const { devices } = engine.snapshot();
    expect(devices.first.records[ID].fields.note).toBe('Сохранено без сети');
    expect(devices.second.pending).toHaveLength(0);
  });

  it('независимые поля объединяются; переименование не меняет постоянный id', () => {
    const engine = setup();
    engine.setOnline('first', false);
    engine.setOnline('second', false);
    engine.edit('first', ID, { nick: 'Звеномир Новый' });
    note(engine, 'second', 'Примечание с другого ПК');
    engine.setOnline('first', true);
    engine.synchronize('first');
    engine.setOnline('second', true);
    expect(engine.synchronize('second').status).toBe('synced');
    engine.synchronize('first');
    for (const device of Object.values(engine.snapshot().devices)) {
      expect(Object.keys(device.records)).toEqual([ID]);
      expect(device.records[ID]).toMatchObject({
        id: ID,
        fields: { nick: 'Звеномир Новый', note: 'Примечание с другого ПК' }
      });
    }
  });

  it('одно поле изменено на двух ПК — обе версии и очередь сохраняются до явного выбора', () => {
    const engine = setup();
    engine.setOnline('first', false);
    engine.setOnline('second', false);
    note(engine, 'first', 'Версия первого');
    note(engine, 'second', 'Версия второго');
    engine.setOnline('first', true);
    engine.synchronize('first');
    engine.setOnline('second', true);
    const conflict = engine.synchronize('second');
    expect(conflict.status).toBe('conflict');
    expect(engine.snapshot().cloud.records[ID].fields.note).toBe('Версия первого');
    expect(engine.snapshot().devices.second.records[ID].fields.note).toBe('Версия второго');
    expect(engine.snapshot().devices.second.pending).toHaveLength(1);
    const [item] = conflict.conflicts;
    expect(item).toMatchObject({
      kind: 'field',
      field: 'note',
      local: { value: 'Версия второго' },
      remote: { value: 'Версия первого' }
    });
    expect(engine.resolve('second', item.key, 'local').status).toBe('synced');
    engine.synchronize('first');
    expect(engine.snapshot().devices.first.records[ID].fields.note).toBe('Версия второго');
  });

  it('если конфликтов несколько, каждый выбор сохраняется до разрешения остальных', () => {
    const engine = setup();
    engine.edit('first', ID, { nick: 'Первый', note: 'Первое' });
    engine.edit('second', ID, { nick: 'Второй', note: 'Второе' });
    engine.synchronize('first');
    const first = engine.synchronize('second');
    expect(first.conflicts).toHaveLength(2);
    const nick = first.conflicts.find(c => c.field === 'nick');
    const noteConflict = first.conflicts.find(c => c.field === 'note');
    expect(engine.resolve('second', nick.key, 'local').status).toBe('conflict');
    expect(engine.resolve('second', noteConflict.key, 'remote').status).toBe('synced');
    expect(engine.snapshot().cloud.records[ID].fields).toEqual({ nick: 'Второй', note: 'Первое' });
  });

  it('удаление против редактирования требует выбора и не воскрешает запись молча', () => {
    const engine = setup();
    engine.remove('first', ID);
    note(engine, 'second', 'Важная правка');
    engine.synchronize('first');
    const conflict = engine.synchronize('second');
    expect(conflict.conflicts[0].kind).toBe('delete-edit');
    expect(engine.snapshot().cloud.records[ID].deleted).toBe(true);
    expect(engine.resolve('second', conflict.conflicts[0].key, 'local').status).toBe('synced');
    expect(engine.snapshot().cloud.records[ID]).toMatchObject({ deleted: false, fields: { note: 'Важная правка' } });
  });

  it('подтверждённая метка удаления доходит до не изменявшего запись ПК', () => {
    const engine = setup();
    engine.remove('first', ID);
    engine.synchronize('first');
    engine.synchronize('second');
    expect(engine.snapshot().devices.second.records[ID].deleted).toBe(true);
    expect(engine.snapshot().cloud.records[ID].deleted).toBe(true);
  });

  it('исчезнувшая запись — конфликт, а не неявное удаление', () => {
    const base = exampleRecords();
    const result = mergeRecords(base, {}, base);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].kind).toBe('record');
  });

  it('одинаковый новый id на двух ПК с разными данными требует выбора', () => {
    const engine = setup();
    engine.add('first', { id: 'new', type: 'character', deleted: false, fields: { nick: 'А' } });
    engine.add('second', { id: 'new', type: 'character', deleted: false, fields: { nick: 'Б' } });
    engine.synchronize('first');
    expect(engine.synchronize('second')).toMatchObject({ status: 'conflict', conflicts: [{ kind: 'record' }] });
  });

  it('устаревший выбор не применяется к изменившейся облачной версии', () => {
    const engine = setup();
    note(engine, 'first', 'Первая версия');
    note(engine, 'second', 'Локальная версия');
    engine.synchronize('first');
    const conflict = engine.synchronize('second');
    note(engine, 'first', 'Более новая версия');
    engine.synchronize('first');
    const refreshed = engine.resolve('second', conflict.conflicts[0].key, 'local');
    expect(refreshed).toMatchObject({ status: 'conflict', stale: true });
    expect(refreshed.conflicts[0].remote.value).toBe('Более новая версия');
    expect(engine.snapshot().cloud.records[ID].fields.note).toBe('Более новая версия');
    expect(engine.snapshot().devices.second.pending).toHaveLength(1);
  });

  it('после гонки версий повторно читает облако и объединяет независимые правки', () => {
    class RacingTransport extends MemoryTransport {
      commit(expected, records) {
        if (!this.raced) {
          this.raced = true;
          const concurrent = this.read().records;
          concurrent[ID].fields.note = 'Изменение другого ПК';
          super.commit(expected, concurrent);
        }
        return super.commit(expected, records);
      }
    }
    const engine = new SyncPrototype({ transport: new RacingTransport() });
    engine.edit('first', ID, { nick: 'Изменённое имя' });
    expect(engine.synchronize('first').status).toBe('synced');
    expect(engine.snapshot().cloud.records[ID].fields).toEqual({
      nick: 'Изменённое имя',
      note: 'Изменение другого ПК'
    });
  });

  it('гонка при подтверждении конфликта не применяет старый выбор к новой версии', () => {
    class RacingTransport extends MemoryTransport {
      commit(expected, records) {
        if (this.armed) {
          this.armed = false;
          const concurrent = this.read().records;
          concurrent[ID].fields.note = 'Новая версия во время подтверждения';
          super.commit(expected, concurrent);
        }
        return super.commit(expected, records);
      }
    }
    const transport = new RacingTransport();
    const engine = new SyncPrototype({ transport });
    engine.connect('second');
    note(engine, 'first', 'Первый вариант');
    note(engine, 'second', 'Второй вариант');
    engine.synchronize('first');
    const conflict = engine.synchronize('second');
    transport.armed = true;
    const result = engine.resolve('second', conflict.conflicts[0].key, 'local');
    expect(result.status).toBe('conflict');
    expect(result.conflicts[0].remote.value).toBe('Новая версия во время подтверждения');
    expect(engine.snapshot().devices.second.pending).toHaveLength(1);
    expect(engine.snapshot().cloud.records[ID].fields.note).toBe('Новая версия во время подтверждения');
  });

  it('при неудачной условной записи ничего не теряется и повтор остаётся возможным', () => {
    class BusyTransport extends MemoryTransport {
      commit(expected, records) {
        if (this.busy) return { ok: false, snapshot: this.read() };
        return super.commit(expected, records);
      }
    }
    const transport = new BusyTransport();
    transport.busy = true;
    const engine = new SyncPrototype({ transport });
    note(engine, 'first', 'Ожидающая правка');
    expect(engine.synchronize('first').status).toBe('retry');
    expect(engine.snapshot().devices.first.pending).toHaveLength(1);
    expect(engine.snapshot().devices.first.records[ID].fields.note).toBe('Ожидающая правка');
    transport.busy = false;
    expect(engine.synchronize('first').status).toBe('synced');
    expect(engine.snapshot().cloud.records[ID].fields.note).toBe('Ожидающая правка');
  });

  it('подключение пустого ПК не считывает и не изменяет настоящее хранилище или сеть', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const storeSpy = vi.spyOn(Storage.prototype, 'setItem');
    const engine = setup();
    note(engine, 'second', 'Лишь фиктивный текст');
    engine.synchronize('second');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    storeSpy.mockRestore();
  });

  it('сравнение объектов не зависит от порядка полей', () => {
    expect(equalValue({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(equalValue([1, 2], [2, 1])).toBe(false);
  });
});

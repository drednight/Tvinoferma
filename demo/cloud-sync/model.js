// Учебный прототип: все устройства и «облако» живут только в памяти этой страницы.
// Здесь нет сети, настоящих файлов, авторизации, шифрования или данных приложения.
// Формат намеренно маленький: он позволяет проверить базовое трёхстороннее слияние
// и очередь, но не заменяет проверенный механизм синхронизации релизной версии.

const copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

/** Сравнение JSON-значений не зависит от порядка полей объекта. */
export function equalValue(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equalValue(v, b[i]));
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return equalValue(ak, bk) && ak.every(key => equalValue(a[key], b[key]));
}

/** Набор вымышленных записей: постоянный sync-id не зависит от изменяемого ника. */
export function exampleRecords() {
  return {
    'example-char-01': {
      id: 'example-char-01',
      type: 'character',
      deleted: false,
      fields: { nick: 'Звеномир', note: 'Подготовить персонажа к походу' }
    }
  };
}

/** Учебное хранилище: условная запись не заменяет более новую версию. */
export class MemoryTransport {
  constructor(records = exampleRecords()) {
    this.revision = 1;
    this.records = copy(records);
  }

  read() {
    return { revision: this.revision, records: copy(this.records) };
  }

  commit(expectedRevision, records) {
    if (expectedRevision !== this.revision) return { ok: false, snapshot: this.read() };
    this.records = copy(records);
    this.revision += 1;
    return { ok: true, snapshot: this.read() };
  }
}

const fieldAt = (record, field) =>
  has(record?.fields, field) ? { exists: true, value: copy(record.fields[field]) } : { exists: false };

/**
 * Трёхстороннее слияние общей базы, локальной версии и облачной версии.
 * Удаление — явная метка deleted; отсутствие записи само по себе удалением не считается.
 * При конфликте результат только предварительный и НЕ должен сохраняться.
 */
export function mergeRecords(base = {}, local = {}, remote = {}, choices = {}) {
  const merged = {};
  const conflicts = [];
  const ids = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();

  function choose(conflict, localValue, remoteValue) {
    const selected = choices[conflict.key];
    if (selected === 'local') return copy(localValue);
    if (selected === 'remote') return copy(remoteValue);
    conflicts.push(conflict);
    return copy(remoteValue); // Только для отображения; пока есть конфликт, запись запрещена.
  }

  for (const id of ids) {
    const b = base[id];
    const l = local[id];
    const r = remote[id];
    let result;
    // Пропавшая запись и подменённая идентичность не означают подтверждённое удаление.
    if (b && (!l || !r || l.id !== b.id || r.id !== b.id || l.type !== b.type || r.type !== b.type)) {
      result = choose(
        { key: `${id}:record`, id, kind: 'record', base: copy(b), local: copy(l), remote: copy(r) },
        l,
        r
      );
    } else if (equalValue(l, r)) result = copy(l);
    else if (equalValue(l, b)) result = copy(r);
    else if (equalValue(r, b)) result = copy(l);
    else if (!b && !l) result = copy(r);
    else if (!b && !r) result = copy(l);
    else if (!b || !l || !r || l.type !== r.type || l.id !== r.id) {
      result = choose(
        { key: `${id}:record`, id, kind: 'record', base: copy(b), local: copy(l), remote: copy(r) },
        l,
        r
      );
    } else if (l.deleted || r.deleted) {
      if (l.deleted && r.deleted) result = copy(r);
      else {
        result = choose(
          { key: `${id}:record`, id, kind: 'delete-edit', base: copy(b), local: copy(l), remote: copy(r) },
          l,
          r
        );
      }
    } else {
      const fields = {};
      const keys = [
        ...new Set([...Object.keys(b.fields || {}), ...Object.keys(l.fields || {}), ...Object.keys(r.fields || {})])
      ].sort();
      for (const field of keys) {
        const bf = fieldAt(b, field);
        const lf = fieldAt(l, field);
        const rf = fieldAt(r, field);
        let selected;
        if (equalValue(lf, rf)) selected = lf;
        else if (equalValue(lf, bf)) selected = rf;
        else if (equalValue(rf, bf)) selected = lf;
        else {
          selected = choose(
            {
              key: `${id}:field:${encodeURIComponent(field)}`,
              id,
              kind: 'field',
              field,
              base: bf,
              local: lf,
              remote: rf
            },
            lf,
            rf
          );
        }
        // Object.defineProperty безопасен даже для поля с именем __proto__.
        if (selected?.exists)
          Object.defineProperty(fields, field, {
            value: copy(selected.value),
            enumerable: true,
            configurable: true,
            writable: true
          });
      }
      result = { id: r.id, type: r.type, deleted: false, fields };
    }
    if (result !== undefined)
      Object.defineProperty(merged, id, { value: result, enumerable: true, configurable: true, writable: true });
  }
  return { records: merged, conflicts };
}

function newDevice(id, name, snapshot, connected) {
  return {
    id,
    name,
    connected,
    online: true,
    revision: connected ? snapshot.revision : 0,
    base: connected ? copy(snapshot.records) : {},
    records: connected ? copy(snapshot.records) : {},
    pending: [],
    conflicts: [],
    choices: {},
    localVersion: 0,
    conflictRevision: null,
    conflictLocalVersion: null,
    lastSync: connected ? 'Начальный пример' : '',
    status: connected ? 'synced' : 'disconnected'
  };
}

/** Два виртуальных ПК, очередь и транспорт без привязки к облачному провайдеру. */
export class SyncPrototype {
  constructor({ records = exampleRecords(), transport = new MemoryTransport(records) } = {}) {
    this.transport = transport;
    const snapshot = transport.read();
    this.devices = {
      first: newDevice('first', 'Этот ПК', snapshot, true),
      second: newDevice('second', 'Второй ПК', snapshot, false)
    };
    this.sequence = 0;
  }

  device(id) {
    const device = this.devices[id];
    if (!device) throw new Error('Неизвестный виртуальный компьютер');
    return device;
  }

  snapshot() {
    return { devices: copy(this.devices), cloud: this.transport.read() };
  }

  /** Второй ПК в демо изначально пуст. Существующие пользовательские данные здесь не соединяются. */
  connect(id) {
    const device = this.device(id);
    if (device.connected) return { status: 'already_connected' };
    if (!device.online) return { status: 'offline' };
    if (device.pending.length || Object.keys(device.records).length) return { status: 'needs_review' };
    const snapshot = this.transport.read();
    device.connected = true;
    device.base = copy(snapshot.records);
    device.records = copy(snapshot.records);
    device.revision = snapshot.revision;
    device.status = 'synced';
    device.lastSync = 'Подключён к примеру';
    return { status: 'connected' };
  }

  setOnline(id, online) {
    const device = this.device(id);
    device.online = !!online;
    device.status = !device.connected
      ? 'disconnected'
      : device.online
        ? device.pending.length
          ? 'pending'
          : 'synced'
        : 'offline';
  }

  queue(device, action, id, fields = []) {
    device.pending.push({ id: `${device.id}-${++this.sequence}`, action, recordId: id, fields: [...fields] });
    device.localVersion += 1;
    device.conflicts = [];
    device.choices = {};
    device.conflictRevision = null;
    device.conflictLocalVersion = null;
    device.status = device.online ? 'pending' : 'offline';
  }

  edit(id, recordId, patch) {
    const device = this.device(id);
    if (!device.connected) throw new Error('ПК не подключён к примеру');
    const record = device.records[recordId];
    if (!record || record.deleted) throw new Error('Записи нет или она удалена');
    const fields = Object.keys(patch || {}).filter(field => !equalValue(record.fields[field], patch[field]));
    if (!fields.length) return false;
    const nextFields = { ...record.fields };
    fields.forEach(field =>
      Object.defineProperty(nextFields, field, {
        value: copy(patch[field]),
        enumerable: true,
        configurable: true,
        writable: true
      })
    );
    device.records[recordId] = { ...record, fields: nextFields };
    this.queue(device, 'edit', recordId, fields);
    return true;
  }

  add(id, record) {
    const device = this.device(id);
    if (!device.connected) throw new Error('ПК не подключён к примеру');
    if (!record?.id || has(device.records, record.id)) throw new Error('Такой идентификатор уже существует');
    Object.defineProperty(device.records, record.id, {
      value: copy(record),
      enumerable: true,
      configurable: true,
      writable: true
    });
    this.queue(device, 'add', record.id);
  }

  remove(id, recordId) {
    const device = this.device(id);
    if (!device.connected) throw new Error('ПК не подключён к примеру');
    const record = device.records[recordId];
    if (!record || record.deleted) return false;
    device.records[recordId] = { ...record, deleted: true };
    this.queue(device, 'delete', recordId);
    return true;
  }

  synchronize(id) {
    const device = this.device(id);
    if (!device.connected) return { status: 'disconnected' };
    if (!device.online) {
      device.status = 'offline';
      return { status: 'offline' };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const cloud = this.transport.read();
      const plan = mergeRecords(device.base, device.records, cloud.records, device.choices);
      if (plan.conflicts.length) {
        device.status = 'conflict';
        device.conflicts = plan.conflicts;
        device.conflictRevision = cloud.revision;
        device.conflictLocalVersion = device.localVersion;
        return { status: 'conflict', conflicts: copy(plan.conflicts) };
      }
      let next = cloud;
      if (!equalValue(plan.records, cloud.records)) {
        const commit = this.transport.commit(cloud.revision, plan.records);
        if (!commit.ok) {
          // Старый выбор в окне конфликта нельзя применять к новой версии незаметно.
          device.choices = {};
          continue;
        }
        next = commit.snapshot;
      }
      device.records = copy(next.records);
      device.base = copy(next.records);
      device.revision = next.revision;
      device.pending = [];
      device.conflicts = [];
      device.choices = {};
      device.conflictRevision = null;
      device.conflictLocalVersion = null;
      device.status = 'synced';
      device.lastSync = 'Только что в примере';
      return { status: 'synced', revision: next.revision };
    }
    device.status = 'retry';
    return { status: 'retry' }; // Очередь и обе версии остались нетронутыми.
  }

  resolve(id, conflictKey, choice) {
    const device = this.device(id);
    if (!device.online) return { status: 'offline' };
    if (!['local', 'remote'].includes(choice) || !device.conflicts.some(c => c.key === conflictKey))
      return { status: 'not_found' };
    if (
      this.transport.read().revision !== device.conflictRevision ||
      device.localVersion !== device.conflictLocalVersion
    ) {
      device.choices = {};
      return { ...this.synchronize(id), stale: true };
    }
    device.choices[conflictKey] = choice;
    return this.synchronize(id);
  }
}

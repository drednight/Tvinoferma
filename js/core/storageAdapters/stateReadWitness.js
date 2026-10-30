// @ts-check
// Временное свидетельство точного исходного JSON после чтения. Хранится только в памяти
// адаптера, никогда не отправляется в облако и не пишется в журнал. Это не межпроцессная
// блокировка: остальные процессы/вкладки обязаны координироваться отдельно.

function invalid() {
  return new Error('Исходные данные изменились или недоступны; миграция остановлена');
}

// Сравниваем с разобранным JSON, не вызывая getters в изменённом объекте.
function sameJson(expected, actual) {
  const stack = [[expected, actual]];
  let visited = 0;
  while (stack.length) {
    if (++visited > 1_000_000) return false;
    const [left, right] = stack.pop();
    if (Object.is(left, right)) continue;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    const isArray = Array.isArray(left);
    if (isArray !== Array.isArray(right)) return false;
    if (isArray && Object.getPrototypeOf(right) !== Array.prototype) return false;
    if (!isArray && Object.getPrototypeOf(right) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(left);
    const otherKeys = Reflect.ownKeys(right);
    if (keys.length !== otherKeys.length || keys.some(key => typeof key !== 'string' || !Object.hasOwn(right, key)))
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(right);
    for (const key of keys) {
      if (typeof key !== 'string') return false;
      const value = descriptors[key];
      const original = Object.getOwnPropertyDescriptor(left, key);
      if (
        !value ||
        !original ||
        !('value' in value) ||
        value.enumerable !== original.enumerable ||
        value.configurable !== original.configurable ||
        value.writable !== original.writable
      )
        return false;
      stack.push([original.value, value.value]);
    }
  }
  return true;
}

/** Отдельная таблица для каждого адаптера; ключ — именно объект, возвращённый после чтения. */
export function createStateReadWitness() {
  const bySnapshot = new WeakMap();
  return {
    remember(snapshot, raw) {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof raw !== 'string')
        throw invalid();
      bySnapshot.set(snapshot, raw);
    },
    rawFor(snapshot) {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw invalid();
      const raw = bySnapshot.get(snapshot);
      if (typeof raw !== 'string') throw invalid();
      try {
        if (!sameJson(JSON.parse(raw), snapshot)) throw invalid();
      } catch {
        throw invalid();
      }
      return raw;
    },
    forget(snapshot) {
      if (snapshot && typeof snapshot === 'object') bySnapshot.delete(snapshot);
    }
  };
}

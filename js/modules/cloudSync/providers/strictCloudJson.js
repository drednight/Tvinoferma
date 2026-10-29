// @ts-check
// Малый JSON-разбор для ответов с полями строк, объектов, массивов и логических значений.
// В отличие от JSON.parse обнаруживает повторные ключи, включая экранированные эквиваленты.
// Исходный ответ может содержать персональные сведения: не включать его в исключения.

const MAX_CHARS = 2 * 1024 * 1024;
const MAX_NODES = 5000;
const MAX_DEPTH = 8;
const MAX_STRING = 16384;
const MAX_ARRAY = 1000;

function invalid() {
  return new Error('Некорректный ответ облачного диска');
}

/** @param {string} raw */
export function parseStrictCloudJson(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_CHARS) throw invalid();
  let index = 0;
  let nodes = 0;
  const space = () => {
    while (index < raw.length && ' \t\r\n'.includes(raw[index])) index++;
  };
  const string = () => {
    space();
    if (raw[index] !== '"') throw invalid();
    const start = index++;
    while (index < raw.length) {
      const character = raw[index++];
      if (character === '\\') {
        if (index >= raw.length) throw invalid();
        index++;
      } else if (character === '"') {
        let value;
        try {
          value = JSON.parse(raw.slice(start, index));
        } catch {
          throw invalid();
        }
        if (typeof value !== 'string' || value.length > MAX_STRING) throw invalid();
        return value;
      }
    }
    throw invalid();
  };
  const read = depth => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw invalid();
    space();
    if (raw[index] === '"') return string();
    if (raw.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (raw.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (raw[index] === '[') {
      index++;
      const values = [];
      space();
      if (raw[index] !== ']') {
        while (true) {
          values.push(read(depth + 1));
          if (values.length > MAX_ARRAY) throw invalid();
          space();
          if (raw[index] !== ',') break;
          index++;
        }
      }
      if (raw[index++] !== ']') throw invalid();
      return values;
    }
    if (raw[index] === '{') {
      index++;
      const result = Object.create(null);
      space();
      if (raw[index] !== '}') {
        while (true) {
          const key = string();
          if (Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid();
          space();
          if (raw[index++] !== ':') throw invalid();
          result[key] = read(depth + 1);
          space();
          if (raw[index] !== ',') break;
          index++;
        }
      }
      if (raw[index++] !== '}') throw invalid();
      return result;
    }
    throw invalid();
  };
  const result = read(0);
  space();
  if (index !== raw.length) throw invalid();
  return result;
}

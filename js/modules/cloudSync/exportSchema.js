// @ts-check
// Проверка отдельных подготовительных схем экспорта. Ошибки не содержат пользовательских значений.
import { preparationError } from './preparationDiagnostics.js';

const MAX_ITEMS = 100_000;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function invalidExport(reason = 'invalid') {
  return preparationError(new Error('Неподдерживаемая структура данных; экспорт остановлен'), reason);
}

function descriptorsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidExport();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalidExport();
  return Object.getOwnPropertyDescriptors(value);
}

/** Строго заданные поля; getter и невидимое поле никогда не считываются. */
export function object(value, required, optional = []) {
  const descriptors = descriptorsOf(value);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.length > MAX_ITEMS || keys.some(key => typeof key !== 'string' || !allowed.has(key)))
    throw invalidExport('unknown_field');
  for (const key of required) if (!Object.hasOwn(descriptors, key)) throw invalidExport('missing_field');
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) throw invalidExport();
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalidExport();
    result[key] = descriptor.value;
  }
  return result;
}

/** Словарь с ограниченным форматом ключей и явной проверкой каждого значения. */
export function dictionary(value, keyAllowed, convert) {
  return mappedDictionary(
    value,
    key => {
      if (!keyAllowed(key)) throw invalidExport();
      return key;
    },
    convert
  );
}

/** Словарь со строгой заменой ключей; столкновения и опасные имена не допускаются. */
export function mappedDictionary(value, mapKey, convert) {
  const descriptors = descriptorsOf(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_ITEMS) throw invalidExport();
  const entries = [];
  const seen = new Set();
  for (const key of keys) {
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) throw invalidExport();
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalidExport();
    const mapped = mapKey(key);
    if (typeof mapped !== 'string' || !mapped || UNSAFE_KEYS.has(mapped) || seen.has(mapped)) throw invalidExport();
    seen.add(mapped);
    entries.push([mapped, convert(descriptor.value, key)]);
  }
  return Object.fromEntries(entries);
}

export function array(value, convert) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw invalidExport();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw invalidExport();
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalidExport();
    result.push(convert(descriptor.value));
  }
  return result;
}

export function text(value) {
  if (typeof value !== 'string') throw invalidExport('text');
  return value;
}
export function number(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) throw invalidExport('number');
  return value;
}
export function boolean(value) {
  if (typeof value !== 'boolean') throw invalidExport('boolean');
  return value;
}
export function oneOf(value, choices) {
  if (typeof value !== 'string' || !choices.includes(value)) throw invalidExport('choice');
  return value;
}
export const nullableText = value => (value === null ? null : text(value));
export const nullableNumber = value => (value === null ? null : number(value));

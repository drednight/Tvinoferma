import { sameJsonValue } from '../valueEquality.js';
import { STAT_FIELDS } from '../../characters/statsOcr.js';

export function characterFieldText(key, value) {
  if (value === null || value === undefined || value === '') return 'Не указано';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (Array.isArray(value)) return value.join(', ') || 'Нет';
  if (key === 'stats')
    return (
      STAT_FIELDS.filter(f => !f.ignore && Object.hasOwn(value, f.key))
        .map(f => `${f.label}: ${value[f.key]}`)
        .join(' · ') || 'Нет характеристик'
    );
  if (key === 'dungeonPasses')
    return [
      ['weapon', 'Оружие'],
      ['armor', 'Доспех'],
      ['relic', 'Реликвия']
    ]
      .map(([k, label]) => `${label}: ${value[k] ?? 0}`)
      .join(' · ');
  if (key === 'sky') return [value.name, value.level].filter(v => v != null).join(' · ') || 'Не указано';
  if (key === 'lastCoinUpdate') {
    const d = new Date(value);
    return Number.isNaN(d.getTime())
      ? 'Дата не распознана'
      : d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' мск';
  }
  return typeof value === 'object' ? 'Есть данные' : String(value);
}

export function characterFieldDifferences(key, before, after) {
  const labels =
    key === 'stats'
      ? Object.fromEntries(STAT_FIELDS.filter(f => !f.ignore).map(f => [f.key, f.label]))
      : key === 'dungeonPasses'
        ? { weapon: 'Оружие', armor: 'Доспех', relic: 'Реликвия' }
        : key === 'sky'
          ? { name: 'Небо', level: 'Уровень неба' }
          : null;
  if (!labels) return [{ label: '', before, after }];
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter(k => !sameJsonValue(before?.[k], after?.[k]))
    .map(k => ({ label: labels[k] || 'Дополнительный показатель', before: before?.[k], after: after?.[k] }));
}

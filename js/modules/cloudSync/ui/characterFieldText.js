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

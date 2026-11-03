import { CHARACTER_UPDATE_FIELDS } from '../characterUpdates.js';
import { STAT_FIELDS } from '../../characters/statsOcr.js';
import { characterFieldText } from './characterFieldText.js';
// @ts-check
// Presentation only: never alters comparisons, snapshots or acceptance rules.
const PATHS = {
  fields: 'Поля',
  ...CHARACTER_UPDATE_FIELDS,
  ...Object.fromEntries(STAT_FIELDS.map(f => [f.key, f.label])),
  weapon: 'Оружие',
  armor: 'Доспех',
  relic: 'Реликвия',
  statsHistory: 'История характеристик',
  coinHistory: 'История монет',
  coinsParserV: 'Версия проверки баланса',
  marathonData: 'Данные марафона',
  partyIds: 'Пати',
  mainPartyId: 'Основная пати',
  partyOrder: 'Порядок в пати',

  statusByDate: 'Выполнение по дням',
  updatedAt: 'Дата изменения',
  createdAt: 'Дата создания',
  status: 'Статус',
  nick: 'Имя',
  title: 'Название',
  notes: 'Заметки',
  date: 'Дата',
  enabled: 'Включено',
  amount: 'Сумма',
  balance: 'Баланс'
};
export function cloudChangePath(path) {
  return path
    .map(
      part =>
        (Object.hasOwn(PATHS, part) ? PATHS[part] : null) ||
        (/^\d{4}-\d{2}-\d{2}$/.test(String(part)) ? String(part).split('-').reverse().join('.') : String(part))
    )
    .join(' › ');
}
export function cloudChangeValue(part, path = []) {
  if (!part?.present) return 'отсутствует';
  const value = part.value;
  if (path.at(-1) === 'status' || path.includes('statusByDate')) {
    const statuses = { done: 'Выполнено', todo: 'Не выполнено', skipped: 'Пропущено' };
    if (typeof value === 'string' && Object.hasOwn(statuses, value)) return statuses[value];
  }
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return humanCloudValue(value, path.at(-1)).slice(0, typeof value === 'string' ? 300 : 4000);
}
export function cloudChangeCounts(entries) {
  return [
    ['Добавится', entries.filter(entry => entry.kind === 'only_cloud').length],
    ['Изменится', entries.filter(entry => !['only_cloud', 'only_local'].includes(entry.kind)).length],
    ['Удалится', entries.filter(entry => entry.kind === 'only_local').length]
  ];
}
export function folderNextStep(status, diagnostic) {
  if (status === 'folder_missing') return 'Создание пустой папки не отправляет данные и не меняет ключ шифрования.';
  if (['folder_ready', 'folder_created', 'folder_file_verified'].includes(status))
    return 'Путь: Яндекс Диск → Файлы → Твиноферма. Сохранение считается успешным только после отправки и обратной сверки файла.';
  if (status === 'folder_creation_unconfirmed')
    return 'Сначала проверьте папку повторно. Не создавайте новый ключ и не повторяйте отправку вслепую.';
  if (
    diagnostic?.endsWith('_forbidden') ||
    diagnostic?.endsWith('_unauthorized') ||
    ['credential_missing', 'login_required'].includes(status)
  )
    return 'Проверьте права приложения: чтение и запись Диска, доступ к папке приложения. Затем выйдите и войдите в прежний аккаунт Яндекса — старый токен новые права сам не получает.';
  if (diagnostic?.includes('_native_connect') || diagnostic?.endsWith('_timeout'))
    return 'Проверьте доступность Яндекс Диска и сеть на этом ПК. Смена пароля шифрования не исправляет DNS или TLS. Скопируйте безопасный отчёт для диагностики.';
  return 'Не удаляйте ключи, аккаунт или прежние файлы. Скопируйте безопасный отчёт: в нём будет этап отказа без токенов и содержимого данных.';
}

export function humanCloudValue(value, key = '', depth = 0) {
  if (depth > 5) return 'Вложенные данные';
  if (['stats', 'dungeonPasses', 'sky', 'lastCoinUpdate'].includes(key)) return characterFieldText(key, value);
  if (value == null) return 'Не указано';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value))
    return value.length
      ? value
          .slice(0, 40)
          .map(v => humanCloudValue(v, '', depth + 1))
          .join(' · ')
      : 'Нет записей';
  return Object.entries(value)
    .slice(0, 50)
    .map(
      ([k, v]) =>
        `${(Object.hasOwn(PATHS, k) ? PATHS[k] : '') || (/^\d{4}-\d{2}-\d{2}$/.test(k) ? k.split('-').reverse().join('.') : 'Дополнительно')}: ${humanCloudValue(v, k, depth + 1)}`
    )
    .join(' · ');
}

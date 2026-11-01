// @ts-check
// Presentation only: never alters comparisons, snapshots or acceptance rules.
const PATHS = {
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
  return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 300);
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

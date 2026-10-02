// js/desktop/updateState.js
// Единое состояние автообновления: его читают и кнопка в шапке, и раздел «Настройки → Обновления».
// Без зависимостей от Tauri и DOM, поэтому легко тестируется.
//
// status:
//   idle          — ещё не проверяли
//   checking      — идёт проверка
//   uptodate      — установлена последняя версия
//   available     — найдена новая версия (показываем кнопку «Доступно обновление»)
//   downloading   — идёт загрузка (progress 0–100 или null, если размер неизвестен)
//   installing    — загрузка завершена, идёт установка и перезапуск
//   error         — не удалось скачать/установить (кнопка остаётся, можно повторить)
//   check_error   — не удалось проверить (кнопки нет)

const initial = () => ({
  status: 'idle',
  currentVersion: null,
  version: null,
  notes: '',
  progress: null,
  error: null,
  lastCheckedAt: null
});

let current = initial();
const subscribers = new Set();

export const getUpdateState = () => ({ ...current });

export function setUpdateState(patch) {
  current = { ...current, ...patch };
  const snapshot = { ...current };
  subscribers.forEach((fn) => { try { fn(snapshot); } catch (e) { console.warn('[UPDATE STATE]', e); } });
}

/** Подписка; callback вызывается сразу и при каждом изменении. Возвращает функцию отписки. */
export function subscribeUpdate(fn) {
  subscribers.add(fn);
  fn({ ...current });
  return () => subscribers.delete(fn);
}

export function resetUpdateState() {
  current = initial();
  subscribers.clear();
}

/** "0.3.0" → "v0.3.0" */
export const formatVersion = (v) => (v ? (String(v).startsWith('v') ? String(v) : `v${v}`) : '');

/** Есть ли найденное обновление, о котором надо напоминать кнопкой. */
export const hasUpdate = (s = current) =>
  !!s.version && ['available', 'downloading', 'installing', 'error'].includes(s.status);

export const isBusy = (s = current) => s.status === 'downloading' || s.status === 'installing';

/** Подпись кнопки в шапке. */
export function badgeLabel(s = current) {
  switch (s.status) {
    case 'downloading': return s.progress == null ? '⬇️ Загрузка обновления…' : `⬇️ Загрузка ${s.progress}%`;
    case 'installing': return '⏳ Установка, перезапуск…';
    case 'error': return '⚠️ Ошибка обновления: повторить';
    default: return `⬆️ Доступно обновление ${formatVersion(s.version)}`;
  }
}

/** Подпись кнопки установки в настройках. */
export function installButtonLabel(s = current) {
  switch (s.status) {
    case 'downloading': return s.progress == null ? 'Загрузка…' : `Загрузка ${s.progress}%`;
    case 'installing': return 'Установка…';
    case 'error': return `Повторить обновление до ${formatVersion(s.version)}`;
    default: return `⬆️ Обновить до ${formatVersion(s.version)}`;
  }
}

/** Строка статуса в настройках. */
export function statusText(s = current, { supported = true } = {}) {
  if (!supported) return 'Автообновление работает только в установленном приложении.';
  switch (s.status) {
    case 'checking': return 'Проверяю наличие обновлений…';
    case 'uptodate': return 'Установлена последняя версия.';
    case 'available': return `Доступна версия ${formatVersion(s.version)} (сейчас ${formatVersion(s.currentVersion)}).`;
    case 'downloading': return `Загружаю версию ${formatVersion(s.version)}…`;
    case 'installing': return `Устанавливаю версию ${formatVersion(s.version)}, приложение перезапустится.`;
    case 'error': return `Не удалось установить ${formatVersion(s.version)}: ${s.error || 'неизвестная ошибка'}`;
    case 'check_error': return `Не удалось проверить обновления: ${s.error || 'нет ответа'}`;
    default: return 'Обновления скачиваются из GitHub Releases.';
  }
}

export function checkedAtText(s = current) {
  if (!s.lastCheckedAt) return '';
  const d = new Date(s.lastCheckedAt);
  return isNaN(d.getTime()) ? '' : `Последняя проверка: ${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

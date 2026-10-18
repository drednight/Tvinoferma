// js/modules/guild/window.js
// Окно браузера с клановым сайтом.
//
// Одно общее окно на приложение: у сайта свой вход, он не привязан к персонажу
// (отметки на ивенты ставит человек один раз за себя и своих твинов).
//
// Почему не `open_sync_window`: у окна персонажа метка `sync-win-<id>` и профиль браузера
// этого персонажа — открыть в ней чужой сайт значит подменить окно pwonline.ru и сломать
// синхронизацию сайта. Поэтому в Rust своя команда со своей меткой и своим каталогом профилей.

/** Вызов команды Rust. Импорт ленивый, как в остальных модулях (см. promo.js). */
async function callRust(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

/** Открывает окно (или поднимает уже открытое). */
export async function openGuild(deps = {}) {
  return (deps.invoke || callRust)('open_guild_window');
}

/** Закрывает окно. */
export async function closeGuild(deps = {}) {
  return (deps.invoke || callRust)('close_guild_window');
}

/** Открыто ли окно (видимое или скрытое). */
export async function isGuildOpen(deps = {}) {
  return (deps.invoke || callRust)('guild_window_exists');
}

/**
 * Обновляет сводку: события и пати. Работает без открытого окна, если сессия на сайте жива.
 * Возвращает `{ events, parties }`. Ошибки приходят строкой: `login`, `timeout`, `busy`.
 */
export async function syncGuildFromSite(deps = {}) {
  return (deps.invoke || callRust)('guild_sync');
}

/** Отмечает ивент на сайте и ждёт ответа. Возвращает `{ ok, eventId, response, message }`. */
export async function setGuildResponse(eventId, response, deps = {}) {
  return (deps.invoke || callRust)('guild_set_response', { eventId: String(eventId), response });
}

/**
 * Отметка на ивенте: одна команда, которая сама поднимет скрытое окно клана, если его нет,
 * дождётся страницы и вернёт ответ сайта. Ошибки приходят строкой: `login`, `timeout`, `busy`.
 */
export async function respondToEvent(eventId, response, deps = {}) {
  return setGuildResponse(eventId, response, deps);
}

// js/core/logStore.js
// Общее хранилище журналов: чтение, добавление записи с вытеснением старых и запись.
//
// Зачем отдельный модуль: правило «новые сверху, дальше лимит — выкидываем самые старые»
// было написано шесть раз, и в пяти случаях копия была без защиты от квоты. LocalStorage
// общий на все журналы приложения, и когда он переполнен, `setItem` бросает
// `QuotaExceededError`. Раньше это гасилось пустым `catch`, и новая запись просто не
// сохранялась — без ошибки и без сообщения: после перезапуска её действительно не было,
// и выглядело это как «логи удалились».
//
// Здесь поведение явное: журнал не умеет расти бесконечно, но при нехватке места он
// уменьшается сам — сначала вытесняя самые старые записи. Данные, ради которых журнал
// заводится, при этом остаются.

/** Признак «местно не хватило», а не «сломано хранилище». */
function isQuotaError(e) {
  if (!e) return false;
  // У разных браузеров причина выражена по-разному: именем, кодом или просто числом
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014;
}

function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Читает журнал. Битое или чужое содержимое не должно ронять запуск приложения.
 * @template T
 * @param {string} key
 * @param {T} [fallback]
 * @returns {T}
 */
export function readLog(key, fallback = []) {
  try {
    const value = JSON.parse(store()?.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Записывает журнал, при нехватке места вытесняя самые старые записи.
 *
 * Список ожидается «новые сверху»: усечение с конца выбрасывает именно старые.
 *
 * @param {string} key
 * @param {Array<any>} list
 * @returns {boolean} записалось ли хоть что-то
 */
export function writeLogBounded(key, list) {
  const s = store();
  if (!s) return false;
  let data = Array.isArray(list) ? list : [];
  // Места хватает не всегда, и уменьшать журнал надо частями: сразу пополам — грубо,
  // по одной записи на сотнях тысяч записей — долго. Поэтому шаг с каждым разом больше.
  let cut = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      s.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      if (!isQuotaError(e)) return false;
      const next = Math.max(1, data.length - cut);
      if (next >= data.length) return false;
      data = data.slice(0, next);
      cut = Math.max(1, cut * 2);
    }
  }
  return false;
}

/**
 * Кладёт запись в начало журнала, вытесняя самую старую сверх `max`.
 *
 * @template T
 * @param {string} key
 * @param {T} entry
 * @param {number} max сколько записей держать
 * @returns {Array<T>} что осталось в журнале
 */
export function pushLog(key, entry, max) {
  const list = [entry, ...(Array.isArray(readLog(key)) ? readLog(key) : [])]
    .filter(it => it != null)
    .slice(0, Math.max(1, Number(max) || 1));
  writeLogBounded(key, list);
  return list;
}

/**
 * Полностью очищает журнал. Отдельная функция, а не `writeLogBounded(key, [])`:
 * так видно намерение, и «очистить» нельзя случайно спутать с «записать пустое».
 * @param {string} key
 */
export function clearLog(key) {
  try {
    store()?.removeItem(key);
  } catch {
    /* хранилище недоступно — нечего чистить */
  }
}

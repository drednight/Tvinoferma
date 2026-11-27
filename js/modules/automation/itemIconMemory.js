// @ts-check
// js/modules/automation/itemIconMemory.js
// Память картинок предметов: «такое название предмета мы уже видели на сайте вот с такой картинкой».
//
// Нужна потому, что картинку предмет получает не от нас: рисунок из приложения есть лишь у
// немногих присланных предметов, а всё остальное — превью самого сайта, и то только там, где
// это превью сейчас прочитано. Список «Что будет передано» строится из сохранённого чтения
// страницы передачи, и пока страницу не перечитали, картинок в нём нет. При этом тот же
// предмет мог уже мелькнуть в магазине подарков («Камень светлого духа», «Знак доблести»),
// где сайт рисует свою картинку: запомнив адрес по названию, приложение показывает иконку
// сразу, а не после следующего удачного чтения.
//
// Это не угадывание картинки по названию: в память попадает только адрес, прочитанный из
// <img> строки товара на странице сайта (см. src-tauri/src/scripts/transfer.js и shop.js),
// и только прошедший проверку сайта в siteItemImage. Названию, которое на сайте ни разу не
// встречалось с картинкой, иконка не придумывается — остаётся нейтральный знак.
import { siteItemIconHtml, siteItemImage } from './siteItemIcon.js';
import { itemIconKey } from './localItemIcons.js';

/** Ключ в localStorage: память можно очистить, не трогая данные пользователя. */
export const ITEM_ICON_KEY = 'tf_item_icons_v1';
const KEY = ITEM_ICON_KEY;
/** Память служит интерфейсу, а не данным пользователя: много её копить незачем. */
export const ITEM_ICON_MAX = 400;

const store = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** @type {null | Map<string, string>} ключ предмета → адрес картинки с сайта */
let cache = null;

function load() {
  if (cache) return cache;
  cache = new Map();
  let raw;
  try {
    raw = JSON.parse(store()?.getItem(KEY) || 'null');
  } catch {
    raw = null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, url] of Object.entries(raw)) {
      // Проверка повторяется при чтении: файл мог остаться от прежней, более снисходительной версии.
      const image = siteItemImage(url);
      const key = itemIconKey(name);
      if (key && image) cache.set(key, image);
    }
  }
  return cache;
}

function save() {
  try {
    const out = {};
    for (const [key, url] of load()) out[key] = url;
    store()?.setItem(KEY, JSON.stringify(out));
  } catch {
    /* квота: иконки не критичны, память останется в этом запуске */
  }
}

/**
 * Запомнить картинки прочитанной страницы: `[{ name, image }]` — как их отдаёт сайт.
 * Пустой список и чужие адреса молча пропускаются: вызывать можно из любого места,
 * где приложение получило строки товара со страницы сайта.
 * @param {Array<{name?: any, image?: any, siteName?: any}>} items
 */
export function rememberItemIcons(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const map = load();
  let added = 0;
  for (const item of items) {
    const url = siteItemImage(item?.image);
    if (!url) continue;
    for (const name of [item?.name, item?.siteName]) {
      const key = itemIconKey(name);
      if (!key) continue;
      if (map.get(key) === url) continue;
      map.set(key, url);
      added++;
      // Новые названия вытесняют самые старые: словарь не должен расти вместе со списком акций.
      // Порядок обхода Map — порядок вставки, так что первым ключом всегда идёт древний.
      while (map.size > ITEM_ICON_MAX) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
  }
  if (added) save();
  return added;
}

/**
 * Картинка предмета, виденная приложением на сайте (или '' — тогда показывается то,
 * что умеет siteItemIconHtml: рисунок из приложения или нейтральный знак).
 * @param {any} name
 */
export function rememberedItemIcon(name) {
  const key = itemIconKey(name);
  return key ? load().get(key) || '' : '';
}

/**
 * Иконка строки со списком предметов: своя картинка с этой страницы → картинка сайта,
 * виденная для такого же названия → рисунок из приложения → нейтральный знак.
 * Рисунок из приложения всегда впереди: он офлайн и без чужих запросов.
 * @param {any} image адрес картинки у самой строки (может быть пустым)
 * @param {any} name название предмета
 */
export function itemIconHtml(image, name = '') {
  return siteItemIconHtml(image || rememberedItemIcon(name), name);
}

/** Забыть память (для теста и для «сбросить накопленное»). */
export function forgetItemIcons() {
  cache = null;
  try {
    store()?.removeItem(KEY);
  } catch {
    /* вне браузера */
  }
}

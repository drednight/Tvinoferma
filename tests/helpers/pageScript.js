// Запуск настоящих скриптов разбора (src-tauri/src/scripts/*.js) на сохранённых страницах pwonline.ru.
import { readFileSync } from 'node:fs';

export const fixture = (name) => readFileSync(`tests/fixtures/${name}`, 'utf8');

export function runPageScript(script, html, prefix) {
  if (!('innerText' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, configurable: true });
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.title = doc.title;
  document.body.innerHTML = doc.body.innerHTML;
  window.location.hash = '';
  new Function(readFileSync(`src-tauri/src/scripts/${script}`, 'utf8'))();
  return JSON.parse(decodeURIComponent(window.location.hash.replace(`#${prefix}`, '')));
}

/** Результат marathon_detail.js для страницы-фикстуры: { data, error }. */
export const parseSitePage = (file) => runPageScript('marathon_detail.js', fixture(file), 'TF_DETAIL_V4_');

/** Запуск скрипта на фикстуре, при необходимости с правкой HTML: run('balance.js', 'TF_BAL_V5_', 'site-chests2.html', h => h.replace(...)). */
export const runOnFixture = (script, prefix, file, edit = (h) => h) => runPageScript(script, edit(fixture(file)), prefix);

/** Правка страницы через DOM: удобнее регулярных выражений, когда нужно «сломать вёрстку». */
export function editDom(html, fn) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  fn(doc);
  return doc.documentElement.outerHTML;
}

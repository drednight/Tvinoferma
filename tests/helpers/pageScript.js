// Запуск настоящих скриптов разбора (src-tauri/src/scripts/*.js) на сохранённых страницах pwonline.ru.
import { readFileSync } from 'node:fs';

export const fixture = (name) => readFileSync(`tests/fixtures/${name}`, 'utf8');

export function runPageScript(script, html, prefix) {
  if (!('innerText' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, configurable: true });
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
  window.location.hash = '';
  new Function(readFileSync(`src-tauri/src/scripts/${script}`, 'utf8'))();
  return JSON.parse(decodeURIComponent(window.location.hash.replace(`#${prefix}`, '')));
}

/** Результат marathon_detail.js для страницы-фикстуры: { data, error }. */
export const parseSitePage = (file) => runPageScript('marathon_detail.js', fixture(file), 'TF_DETAIL_V4_');

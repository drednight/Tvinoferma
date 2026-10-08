// Готовит страницу pwonline.ru для tests/fixtures: убирает скрипты, стили, картинки и личные данные.
//   node scripts/sanitize-fixture.mjs "C:\путь\страница.htm" tests/fixtures/site-имя.html [--trim=селектор:N]
// --trim=ul:2 оставляет только первые N дочерних элементов у каждого элемента по селектору (для длинных списков).
// Кодировка windows-1251 определяется автоматически. Результат ВСЕГДА открывайте глазами перед коммитом.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const args = process.argv.slice(2);
const trims = args.filter((a) => a.startsWith('--trim=')).map((a) => a.slice(7).split(/:(\d+)$/));
const [src, dst] = args.filter((a) => !a.startsWith('--'));
if (!src || !dst) {
  console.error('Использование: node scripts/sanitize-fixture.mjs <исходная страница> <файл в tests/fixtures>');
  process.exit(1);
}

const bytes = fs.readFileSync(src);
const head = bytes.subarray(0, 4000).toString('latin1');
const html = new TextDecoder(/charset=["']?windows-1251/i.test(head) ? 'windows-1251' : 'utf-8').decode(bytes);

const FAKE_ID = '1000000001';
/** Заменяет личные данные: e-mail, ники вида u_123…, числовой id аккаунта (аватар VK Play). */
export function scrub(text) {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, 'user@example.com')
    .replace(/\bu_\d{6,}\b/g, `u_${FAKE_ID}`)
    .replace(/(avatar\/|(?<!cart_)id=|user[_-]?id["':= ]+)\d{6,}/gi, `$1${FAKE_ID}`)
    .replace(/\b\d{9}\b(?=\.(?:jpe?g|png))/g, FAKE_ID)
    // токены и подписи в адресах: ?token=…, &sid=…, &hash=…
    .replace(/([?&;](?:amp;)?(?:token|securitytoken|sid|hash|key|sign|signature|session)=)[^&"'\s<>]+/gi, '$1X');
}

const dom = new JSDOM(html);
const { document } = dom.window;
document.querySelectorAll('script, style, link, iframe, noscript, svg, source, video, audio, canvas').forEach((n) => n.remove());
document.querySelectorAll('input[type="hidden"]').forEach((i) => i.setAttribute('value', ''));
document.querySelectorAll('img').forEach((img) => { img.removeAttribute('srcset'); img.setAttribute('src', ''); });
for (const [sel, n] of trims) {
  document.querySelectorAll(sel).forEach((el) => [...el.children].slice(Number(n)).forEach((c) => c.remove()));
}
const walker = document.createTreeWalker(document, 128 /* комментарии */);
const comments = [];
while (walker.nextNode()) comments.push(walker.currentNode);
comments.forEach((c) => c.remove());
document.querySelectorAll('*').forEach((el) => {
  for (const a of [...el.attributes]) {
    if (/^(on|data-(?!dp-|info$|turn$))/.test(a.name) || a.name === 'style' || a.name === 'nonce') el.removeAttribute(a.name);
    else if (a.value.length > 400) el.setAttribute(a.name, '');
  }
});
// <meta> оставляем только charset: остальное (токены, проверочные коды) не нужно
document.querySelectorAll('meta').forEach((m) => { if (!m.hasAttribute('charset')) m.remove(); });
if (!document.querySelector('meta[charset]')) {
  const m = document.createElement('meta'); m.setAttribute('charset', 'utf-8'); document.head.prepend(m);
}

const out = scrub('<!DOCTYPE html>\n' + document.documentElement.outerHTML).replace(/\n\s*\n+/g, '\n').replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, '');
fs.writeFileSync(dst, out.endsWith('\n') ? out : out + '\n');
console.log(`${dst}: ${(out.length / 1024).toFixed(1)} КБ`);

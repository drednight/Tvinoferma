// Генерирует один автономный HTML вне Git. Без CDN, сервера или внешнего JS.
import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || resolve(root, 'dist/state-file-check.html'));
const result = await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    write: false,
    minify: true,
    target: 'es2021',
    lib: { entry: resolve(root, 'scripts/state-file-check-entry.js'), name: 'StateFileCheck', formats: ['iife'] }
  }
});
const bundle = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk');
if (!bundle || /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB)\b/.test(bundle.code))
  throw new Error('Offline bundle includes an unexpected network/storage dependency');
const html = `<!doctype html>
<html lang="ru"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Твиноферма — локальная проверка данных</title>
<style>
:root{color-scheme:dark;font:16px/1.6 system-ui,sans-serif;background:#101522;color:#e8edf7}*{box-sizing:border-box}body{margin:0;padding:40px 20px}main{max-width:780px;margin:auto}.eyebrow{color:#94b6ff;font-size:13px;letter-spacing:.12em;text-transform:uppercase}h1{font-size:clamp(26px,5vw,38px);line-height:1.2;margin:12px 0 24px}.panel{background:#192133;border:1px solid #34445f;border-radius:18px;padding:26px;margin:24px 0}.muted{color:#b6c3d9}.badge{display:inline-block;color:#a6e4c4;background:#173a32;border-radius:40px;padding:5px 13px;font-size:13px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}button,.button{font:inherit;color:#fff;border:1px solid #50658c;border-radius:10px;background:#2a3a56;padding:10px 18px;cursor:pointer}.primary{background:#3363c4;border-color:#6890df}button:focus-visible,.button:focus-within,textarea:focus{outline:3px solid #a6c4ff;outline-offset:3px}input[type=file]{position:absolute;width:1px;height:1px;overflow:hidden;opacity:0}textarea{width:100%;min-height:150px;resize:vertical;background:#0e1524;color:#b9d5ff;border:1px solid #3b5073;border-radius:10px;padding:14px;font:13px/1.7 ui-monospace,monospace}ol{padding-left:23px}small{display:block;color:#a8b7d0}label[for=report]{display:block;margin-bottom:10px}
</style></head><body><main>
<div class="eyebrow">Твиноферма · диагностика</div>
<h1>Проверка сохранённой базы</h1>
<span class="badge">Офлайн · без записи · без подключения к облаку</span>
<p class="muted">Откройте этот HTML в Edge или Chrome. Выбранный JSON читается только кодом страницы в памяти браузера. Сетевые запросы запрещены политикой страницы; нет загрузки на сервер или сохранения в браузерное хранилище.</p>
<section class="panel"><h2>Выберите локальный state.json</h2>
<ol><li>В приложении: <b>Настройки → Информация о системе → Скопировать путь</b>.</li><li>Нажмите «Выбрать файл», вставьте этот путь в адресную строку окна выбора, откройте <b>state.json</b>.</li><li>Передайте только коды результата. <b>Сам JSON в чат не прикрепляйте.</b></li></ol>
<small>Требуется именно файл состояния, а не частичный JSON-экспорт. В нём могут быть личные данные. Эта страница не подключается к Google, не создаёт ключи и не изменяет файл приложения.</small>
<div class="actions"><label class="button primary">Выбрать файл<input id="state-file" type="file" accept=".json,application/json"></label><button id="clear-file" type="button">Очистить выбор</button></div>
<p id="check-status" role="status" aria-live="polite">Файл ещё не выбран.</p>
<label for="report">Безопасные коды для сообщения</label><textarea id="report" readonly spellcheck="false" aria-label="Результат проверки"></textarea>
<div class="actions"><button type="button" id="select-report">Выделить коды</button></div>
</section><small>Проверяется сохранённая копия после обычной нормализации при загрузке. Это не проверка состояния Windows vault, доступа к диску, связи с Google или изменений, оставшихся только в памяти приложения. При разных сбоях выводится список кодов по разным записям; в каждой записи — первая ошибка.</small>
</main><script>${bundle.code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(output);

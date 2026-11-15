// Requires playwright-core and Chromium. Run against `npm run dev -- --host 0.0.0.0`.
// Optional PLAYWRIGHT_MODULE points to an external installation; CHROMIUM_EXECUTABLE selects the binary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true,
  args: ['--no-sandbox']
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } }),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const css = [
    ...readFileSync(new URL('../index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet"[^>]+>/g)
  ]
    .map(match => match[0])
    .join('\n');
  await page.route('**/macro-browser-test', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="host"></div><div id="modal-root"></div><div id="toast-root"></div><script type="module">
import {state} from '/js/core/state.js';
import {normalizeGameMacros} from '/js/modules/gameMacros/model.js';
import {mountGameMacros} from '/js/modules/gameMacros/panel.js';
state.parties=[{id:'p',name:'Test party'}];state.characters=[{id:'a',nick:'Alpha',partyIds:['p']}];state.settings.gameMacros=normalizeGameMacros({partyId:'p',leaders:{p:'a'},commands:[{id:'original',name:'Original',action:'sequence',sequence:'B'}]});
mountGameMacros(document.getElementById('host'));window.ready=true;
</script></body></html>`
    })
  );
  await page.goto(`${process.env.MACRO_TEST_URL || 'http://127.0.0.1:1420'}/macro-browser-test`);
  await page.waitForFunction(() => window.ready);
  await page.locator('[data-gm-create]').click();
  await page.locator('[data-gm-form] [name="name"]').fill('Browser command');
  await page.locator('[data-add-type="keys"]').click();
  await page.locator('[data-field="value"]').fill('F8');
  await page.locator('[data-field="value"]').dispatchEvent('change');
  await page.keyboard.press('Escape');
  await page.locator('[data-draft-continue]').click();
  assert.equal(await page.locator('[data-gm-form] [name="name"]').inputValue(), 'Browser command');
  await page.locator('.modal-footer .primary').click();
  await page.waitForSelector('[data-gm-form]', { state: 'detached' });
  await page.getByRole('button', { name: /Browser command/ }).click();
  await page.locator('[data-gm-edit]').click();
  await page.locator('[data-gm-form] [name="name"]').fill('Edited command');
  await page.locator('.modal-footer .primary').click();
  await page.waitForSelector('[data-gm-form]', { state: 'detached' });
  await page.locator('[data-gm-plan]').click();
  assert.match(await page.locator('.gm-review').innerText(), /F8/);
  await page.keyboard.press('Escape');
  await page.locator('[data-gm-delete]').click();
  await page.locator('.modal-footer .primary').click();
  await page.waitForSelector('[data-gm-undo-delete]');
  await page.locator('[data-gm-undo-delete]').click();
  await page.getByRole('button', { name: /Edited command/ }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'Page must not overflow on mobile'
  );
  await page.locator('[data-gm-create]').focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-gm-form] [name="name"]').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-gm-form]', { state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS macro browser: create, configure, close guard, save, edit, review, delete, undo, 390px layout, keyboard open/Escape.'
  );
} finally {
  await browser.close();
}

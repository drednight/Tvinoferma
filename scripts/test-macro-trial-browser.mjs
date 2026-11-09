// Browser UI harness only: callbacks deliberately simulate Windows. No real game input.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true,
  args: ['--no-sandbox']
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const css = [
    ...readFileSync(new URL('../index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet"[^>]+>/g)
  ]
    .map(match => match[0])
    .join('\n');
  await page.route('**/macro-trial-test', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="modal-root"></div><script type="module">
 import {normalizeGameMacros} from '/js/modules/gameMacros/model.js';
 import {openTrialWizard,openTrialComparison} from '/js/modules/gameMacros/trialWizard.js';
 const state={parties:[{id:'p'}],characters:[{id:'a',nick:'Leader',partyIds:['p']},{id:'b',nick:'Twin',partyIds:['p']}]};let c=normalizeGameMacros({partyId:'p',leaders:{p:'a'}});window.sendCount=0;
 openTrialWizard({getConfig:()=>c,state,diagnose:async()=> 'Simulated Windows report — no input',runTrial:async()=>{window.sendCount++;return {runId:'simulated',state:'finished',stage:'execution-complete',events:[]}},save:async patch=>{c=normalizeGameMacros({...c,...patch});window.records=c.backgroundTrials},stop:()=>{}});window.compare=()=>openTrialComparison(c,state);window.ready=true;
 </script></body></html>`
    })
  );
  await page.goto(`${process.env.MACRO_TEST_URL || 'http://127.0.0.1:1420'}/macro-trial-test`);
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => window.sendCount), 0);
  await page.locator('[data-trial-char]').selectOption('b');
  await page.locator('[data-trial-key]').fill('B');
  await page.locator('[data-trial-check]').click();
  await page.locator('[data-trial-consent]').check();
  assert.equal(await page.evaluate(() => window.sendCount), 0);
  await page.locator('[data-trial-run]').click();
  await page.locator('[data-trial-observation]').waitFor({ state: 'visible' });
  await page.locator('[data-trial-verdict]').selectOption('failed');
  await page.locator('[data-trial-observed]').check();
  await page.locator('[data-trial-notes]').fill('No game action (simulated)');
  await page.locator('[data-trial-save]').click();
  await page.waitForFunction(() => window.records?.[0]?.verdict === 'failed');
  assert.equal(await page.evaluate(() => window.sendCount), 1);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'No page overflow at 390px'
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.compare());
  assert.match(await page.locator('tbody').innerText(), /Twin/);
  assert.match(await page.locator('tbody').innerText(), /Не сработало/);
  await page.locator('[data-trial-details]').click();
  await page.locator('textarea[aria-label="Структурированная диагностика"]').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS trial wizard Chromium: explicit probe/consent, one send, manual verdict, stored comparison and diagnostics, 390px. Windows callbacks simulated.'
  );
} finally {
  await browser.close();
}

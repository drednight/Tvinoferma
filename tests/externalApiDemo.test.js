// tests/externalApiDemo.test.js
// Макет страницы внешнего API (demo/external-api) — часть плана, а не приложения.
// Тест держит три вещи, которые легко незаметно сломать при правке макета:
//   1) макет не ходит в сеть и не трогает данные приложения;
//   2) у каждого действия есть ответ в журнале, и данные меняются только после подключения;
//   3) пути запросов в макете совпадают с контрактом docs/EXTERNAL-API.md.
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const html = readFileSync('demo/external-api/index.html', 'utf8');
const script = readFileSync('demo/external-api/external-api.js', 'utf8');
const css = readFileSync('demo/external-api/external-api.css', 'utf8');
const contract = readFileSync('docs/EXTERNAL-API.md', 'utf8');
const plan = readFileSync('docs/EXTERNAL-API-PLAN.md', 'utf8');

/** Страница с поднятым макетом: сначала DOM, потом скрипт — как в браузере. */
function mount() {
  const dom = new JSDOM(html, {
    url: 'http://localhost:1420/demo/external-api/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const errors = [];
  dom.window.addEventListener('error', error => errors.push(String(error.message || error)));
  dom.window.navigator.clipboard = { writeText: async () => {} };
  // Скрипт макета — обычный модуль без импортов, поэтому исполняется в окне страницы.
  dom.window.eval(script);
  return { window: dom.window, errors };
}

const $ = (window, selector) => window.document.querySelector(selector);
const click = (window, element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const journal = window => $(window, '#calls-table tbody').textContent.replace(/\s+/g, ' ');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connected() {
  const mounted = mount();
  $(mounted.window, '#token').value = 'tf_test';
  click(mounted.window, $(mounted.window, '#connect-btn'));
  return mounted;
}

describe('макет внешнего API: файлы', () => {
  it('страница, стили и скрипт на месте и подключены локально', () => {
    for (const file of [
      'demo/external-api/index.html',
      'demo/external-api/external-api.js',
      'demo/external-api/external-api.css'
    ]) {
      expect(existsSync(file), file).toBe(true);
    }
    expect(html).toContain('./external-api.js');
    expect(html).toContain('./external-api.css');
    // Оформление — токены темы приложения, без копий и внешних CDN
    expect(html).toContain('../../css/core/variables.css');
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });

  it('цвета только из токенов темы — ни одного собственного hex-значения', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).toContain('var(--surface-1)');
    expect(css).toContain('var(--accent)');
  });

  it('на странице честно написано, что данные вымышлены и запросы не уходят', () => {
    expect(html).toContain('макет');
    expect(html).toContain('вымышленные данные');
    expect(html).toContain('запросы не отправляются');
  });
});

describe('макет внешнего API: действия', () => {
  it('без токена действие не проходит и данные не меняются — в журнале 401', () => {
    const { window } = mount();
    click(window, $(window, '#bulk-btn'));
    expect(journal(window)).toContain('401');
    expect($(window, '[data-char="Mag_1"][data-pass="relic"]').value).toBe('1');
    window.close();
  });

  it('подключение, сохранение статов и массовое изменение видны в журнале', async () => {
    const { window } = await connected();
    expect($(window, '[data-chip="server"]').classList.contains('is-ok')).toBe(true);
    expect(journal(window)).toContain('/health');

    const stat = $(window, '[data-char="Mag_1"][data-stat="physAttack"]');
    stat.value = '13000';
    stat.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect($(window, '[data-dirty="Mag_1"]').textContent.trim()).not.toBe('');
    click(window, $(window, '[data-save="Mag_1"]'));
    expect(journal(window)).toContain('PATCH');
    // После перерисовки карточки введённое значение осталось
    expect($(window, '[data-char="Mag_1"][data-stat="physAttack"]').value).toBe('13000');
    // Метка «есть несохранённые изменения» снялась
    expect($(window, '[data-dirty="Mag_1"]').textContent.trim()).toBe('');

    click(window, $(window, '#bulk-btn'));
    expect(journal(window)).toContain('bulk-update');
    expect($(window, '[data-char="Mag_1"][data-pass="relic"]').value).toBe('2');
    window.close();
  });

  it('окно закрывается по pid, а не по персонажу', async () => {
    const { window } = await connected();
    const closeButton = $(window, '#windows [data-close]');
    expect(closeButton.dataset.close).toMatch(/^\d+$/);
    click(window, closeButton);
    expect(journal(window)).toContain('windows/close');
    expect($(window, '#windows').querySelectorAll('.xapi-window')).toHaveLength(0);
    window.close();
  });

  it('запуск персонажа: задание, окно и запись в журнале', async () => {
    const { window, errors } = await connected();
    click(window, $(window, '[data-launch="Mag_1"]'));
    expect($(window, '#job').textContent).toContain('Запуск игры: Маг');
    expect(journal(window)).toContain('/launch/character');
    await wait(3200);
    expect($(window, '#windows').querySelectorAll('.xapi-window')).toHaveLength(1);
    expect($(window, '#job').textContent).toContain('готово');
    expect(errors).toEqual([]);
    window.close();
  }, 20000);

  it('персонаж без запомненного входа честно помечается пропущенным', async () => {
    const { window } = await connected();
    click(window, $(window, '[data-launch="Zhrets_3"]'));
    await wait(5200);
    expect($(window, '#job').textContent).toContain('пропущен');
    expect($(window, '#job').textContent).toContain('готово');
    // Окно не появилось: пропуск не запускает клиент
    expect($(window, '#windows').querySelectorAll('.xapi-window')).toHaveLength(1);
    window.close();
  }, 20000);

  it('запуск пати идёт по одному окну и показывает итог по каждому', async () => {
    const { window } = await connected();
    click(window, $(window, '[data-launch-party="p-osnova"]'));
    expect(journal(window)).toContain('/launch/party');
    expect($(window, '#job').textContent).toContain('Основа');
    await wait(11000);
    expect($(window, '#job').textContent).toContain('готово');
    expect($(window, '#job').textContent).toContain('пропущен');
    // Маг и Лучник запустились, Жрец пропущен: в списке окон два окна плюс исходное
    expect($(window, '#windows').querySelectorAll('.xapi-window').length).toBeGreaterThanOrEqual(2);
    window.close();
  }, 30000);

  it('примеры кода подставляют введённый токен', () => {
    const { window } = mount();
    $(window, '#token').value = 'tf_super_secret';
    click(window, $(window, '#connect-btn'));
    click(window, $(window, '[data-recipe="python"]'));
    // В Python-примере токен берётся из переменной окружения — в коде его быть не должно
    expect($(window, '#recipe').textContent).toContain('urllib.request');
    expect($(window, '#recipe').textContent).toContain('os.environ[');
    expect($(window, '#recipe').textContent).not.toContain('tf_super_secret');
    click(window, $(window, '[data-recipe="powershell"]'));
    expect($(window, '#recipe').textContent).toContain('Invoke-RestMethod');
    click(window, $(window, '[data-recipe="curl"]'));
    // В curl-примере токен подставлен — его легко скопировать целиком
    expect($(window, '#recipe').textContent).toContain('curl -s http://127.0.0.1:47831/api/v1/characters');
    expect($(window, '#recipe').textContent).toContain('Bearer tf_super_secret');
    window.close();
  });
});

describe('документ и макет не расходятся', () => {
  it('все пути запросов из макета описаны в контракте', () => {
    const paths = new Set(
      [...script.matchAll(/'(\/(?:health|characters|parties|windows|launch|jobs|app)[^']*)'/g)].map(m => m[1])
    );
    expect(paths.size).toBeGreaterThan(3);
    for (const path of paths) {
      // В контракте путь указан либо целиком, либо по первому сегменту: /jobs/{jobId}
      const head = path.split('/')[1];
      expect(contract, path).toContain(`/${head}`);
    }
    expect(contract).toContain('http://127.0.0.1:47831/api/v1');
  });

  it('короткий план ссылается на полный документ и на макет', () => {
    expect(plan).toContain('docs/EXTERNAL-API.md');
    expect(plan).toContain('demo/external-api/');
    expect(plan).toContain('launchOne');
    expect(plan).toContain('launchPartyByName');
    expect(plan).toContain('127.0.0.1');
  });
});

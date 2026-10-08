// Мини-игра «Коллекция» в видимом окне персонажа: панель слева, запуск только по кнопке, статистика выпадений (Issue #72).
// Страница — настоящая фикстура site-collection.html, сайт игры заменён createGameServer (tests/helpers/collectionServer.js).
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fixture } from './helpers/pageScript.js';
import { createGameServer } from './helpers/collectionServer.js';

const SCRIPT = readFileSync('src-tauri/src/scripts/collection.js', 'utf8');
const URL_OK = '/minigames.php?game=collection&doo=display';
const origAttach = Element.prototype.attachShadow;
let shadow;
let game;

function mount({ url = URL_OK, edit = (h) => h, server = {} } = {}) {
  const doc = new DOMParser().parseFromString(edit(fixture('site-collection.html')), 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
  window.history.replaceState(null, '', url);
  delete window.__tfCollection;
  shadow = null;
  game = createGameServer(server);
  window.fetch = game.fetch;
}
const run = () => new Function(SCRIPT)();
const buttons = () => [...shadow.querySelectorAll('button')];
const btn = (text) => buttons().find((b) => b.textContent.includes(text));
const click = (text) => { const b = btn(text); expect(b, `кнопка «${text}»`).toBeTruthy(); b.click(); };
const text = () => shadow.textContent;
const statusText = () => (shadow.querySelector('.status') || { textContent: '' }).textContent;
const isRunning = () => !!btn('Стоп') && !btn('Стоп').disabled;

/** Двигаем время, пока условие не выполнится (паузы между запросами — setTimeout). */
async function until(cond, limit = 4000) {
  for (let i = 0; i < limit && !cond(); i++) await vi.advanceTimersByTimeAsync(500);
  expect(cond(), 'условие не выполнилось вовремя').toBe(true);
}
const finished = () => /Карточки закончились|Остановлено|Достигнут|выше цели|проверку безопасности|не вошли|изменилась|не открываются|не принимает|нет данных/.test(statusText()) && !isRunning();

async function start() {
  click('Старт');
  click('Запустить');
  await vi.advanceTimersByTimeAsync(0);   // статус прошлого запуска на панели не считается итогом нового
  await until(finished);
}
const setTarget = (n) => click(String(n));
const selectAbove = (value) => {
  const sel = shadow.querySelector('select');
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
  Element.prototype.attachShadow = function (init) { shadow = origAttach.call(this, { ...init, mode: 'open' }); return shadow; };
});
afterEach(() => {
  vi.useRealTimers();
  Element.prototype.attachShadow = origAttach;
});

describe('collection.js: когда показывается панель', () => {
  it('на странице игры панель появляется, цель по умолчанию — 5, ничего не запрашивается', () => {
    mount(); run();
    expect(shadow).toBeTruthy();
    expect(text()).toContain('Коллекция');
    expect(btn('5').className).toContain('on');
    expect(game.calls).toEqual([]);
  });

  it.each([
    ['другая страница сайта', '/promo_items.php'],
    ['другая игра', '/minigames.php?game=piniata&doo=display'],
    ['служебный запрос игры', '/minigames.php?game=collection&doo=info']
  ])('%s: панели нет', (_n, url) => {
    mount({ url }); run();
    expect(shadow).toBeNull();
  });

  it('вёрстка изменилась (нет поля игры): панели нет', () => {
    mount({ edit: (h) => h.replace('id="collection"', 'id="other"') }); run();
    expect(shadow).toBeNull();
  });

  it('адреса игры ведут на чужой сайт: панели нет, наружу ничего не уходит', () => {
    mount({ edit: (h) => h.replace('/minigames.php?game=collection&amp;doo=info', 'https://evil.example/info') }); run();
    expect(shadow).toBeNull();
    expect(game.calls).toEqual([]);
  });

  it('повторный запуск скрипта в том же окне не рисует вторую панель', () => {
    mount(); run(); run();
    expect(document.querySelectorAll('#__tf_collection_panel__').length).toBe(1);
  });
});

describe('collection.js: «Проверить» только читает', () => {
  it('показывает карточки, прогресс и ожидающие действия; не нажимает ничего', async () => {
    mount({ server: { quantity: 37, rows: { 1: 5, 2: 3 } } }); run();
    setTarget(3);
    click('Проверить');
    await until(() => /Ничего не нажималось/.test(statusText()));
    expect(statusText()).toContain('Карточек: 37');
    expect(statusText()).toContain('Категория 1 собрана: будет обмен на 2-ю');
    expect([...shadow.querySelectorAll('.prog .num')].map((n) => n.textContent)).toEqual(['5/5', '3/5', '0/5', '0/5', '0/5', '0/10']);
    expect(game.calls.map((c) => c.doo)).toEqual(['info']);
  });

  it('категория выше цели в проверке названа заранее', async () => {
    mount({ server: { quantity: 5, rows: { 4: 5 } } }); run();
    setTarget(2);
    click('Проверить');
    await until(() => /Ничего не нажималось/.test(statusText()));
    expect(statusText()).toContain('выше цели: запуск остановится');
  });
});

describe('collection.js: запуск', () => {
  it('«Старт» сначала просит подтверждение; «Отмена» ничего не запускает', async () => {
    mount(); run();
    click('Старт');
    expect(text()).toContain('Карточки тратятся необратимо');
    click('Отмена');
    await vi.advanceTimersByTimeAsync(3000);
    expect(game.calls).toEqual([]);
  });

  it('цель 2: обмен 1→2, приз 2-й категории, статистика по категориям', async () => {
    mount({ server: { quantity: 9, drops: [1, 1, 1, 1, 1, 2, 2, 2, 2] } }); run();
    setTarget(2);
    await start();
    expect(statusText()).toContain('Карточки закончились');
    expect(game.rewards[2]).toBe(1);
    expect(game.count('get_next')).toBe(1);
    expect(game.count('turn')).toBe(9);
    expect(game.quantity).toBe(0);
    // таблица: по строкам категорий — запуск и окно
    const rows = [...shadow.querySelectorAll('tr')].slice(1, 7).map((tr) => [...tr.querySelectorAll('td')].slice(1, 3).map((td) => td.textContent));
    expect(rows[0]).toEqual(['5', '5']);
    expect(rows[1]).toEqual(['4', '4']);
    expect(rows[2]).toEqual(['0', '0']);
    expect(shadow.querySelector('.tot-run').textContent).toBe('9');
    expect(shadow.querySelector('.tot-ses').textContent).toBe('9');
    expect(text()).toContain('Призы: 2-я ×1');
    expect(text()).toContain('обменов: 1');
    expect(text()).toContain('55.6%');
  });

  it('все запросы идут на тот же сайт, как GET с куками страницы', async () => {
    mount({ server: { quantity: 3 } }); run();
    await start();
    expect(game.calls.length).toBeGreaterThan(3);
    game.calls.forEach((c) => {
      expect(c.origin).toBe(window.location.origin);
      expect(c.init.credentials).toBe('same-origin');
      expect(c.init.method).toBeUndefined();
    });
  });

  it('лимит карт за запуск: открывает ровно столько', async () => {
    mount({ server: { quantity: 50 } }); run();
    const inp = shadow.querySelector('input');
    inp.value = '4';
    inp.dispatchEvent(new Event('change'));
    await start();
    expect(game.count('turn')).toBe(4);
    expect(statusText()).toContain('Достигнут лимит запуска: 4');
    expect(game.quantity).toBe(46);
  });

  it('«Стоп» останавливает после текущего запроса', async () => {
    mount({ server: { quantity: 500 } }); run();
    click('Старт');
    click('Запустить');
    await until(() => game.count('turn') >= 3);
    click('Стоп');
    await until(() => /Остановлено вами/.test(statusText()));
    const made = game.count('turn');
    await vi.advanceTimersByTimeAsync(5000);
    expect(game.count('turn')).toBe(made);
    expect(made).toBeLessThan(500);
  });

  it('карточки закончились сразу: ничего не открывается', async () => {
    mount({ server: { quantity: 0 } }); run();
    await start();
    expect(game.count('turn')).toBe(0);
    expect(statusText()).toContain('Карточки закончились');
  });
});

describe('collection.js: категория выше цели', () => {
  it('по умолчанию останавливается и ничего не забирает', async () => {
    mount({ server: { quantity: 20, rows: { 3: 5 } } }); run();
    setTarget(1);
    await start();
    expect(statusText()).toContain('Собрана категория 3 выше цели');
    expect(game.count('get_item')).toBe(0);
    expect(game.count('turn')).toBe(0);
  });

  it('«забрать до 3-й»: забирает 3-ю и продолжает, 4-ю — уже нет', async () => {
    mount({ server: { quantity: 3, rows: { 3: 5, 4: 4 }, drops: [4, 1, 1] } }); run();
    setTarget(1);
    selectAbove('3');
    await start();
    expect(game.rewards[3]).toBe(1);
    expect(statusText()).toContain('Собрана категория 4 выше цели');
    expect(game.count('turn')).toBe(1);
  });

  it('при смене цели настройка «выше цели» сбрасывается, если стала недопустимой', () => {
    mount(); run();
    setTarget(2);
    selectAbove('4');
    setTarget(5);
    expect(shadow.querySelector('select').value).toBe('stop');
  });
});

describe('collection.js: безопасность и сбои сайта', () => {
  it('«Проверка безопасности» не решается: запуск останавливается, карточки не трогаются', async () => {
    mount({ server: { info: '<html><body>Проверка безопасности. Подтвердите, что вы не робот</body></html>' } }); run();
    await start();
    expect(statusText()).toContain('проверку безопасности');
    expect(game.count('turn')).toBe(0);
  });

  it('потеря входа распознаётся отдельно', async () => {
    mount({ server: { info: '<html><body><h1>Предупреждение</h1> Вы не авторизованы</body></html>' } }); run();
    await start();
    expect(statusText()).toContain('Вы не вошли на сайт');
  });

  it('формат ответа изменился: ошибка, а не «нулевые карточки»', async () => {
    mount({ server: { info: JSON.stringify({ rows: null }) } }); run();
    await start();
    expect(statusText()).toContain('игра изменилась');
    expect(game.count('turn')).toBe(0);
  });

  it('сайт не открывает карточки: три попытки и остановка', async () => {
    mount({ server: { quantity: 10, ignore: ['turn'] } }); run();
    await start();
    expect(game.count('turn')).toBe(3);
    expect(statusText()).toContain('Карточки не открываются');
  });

  it('сайт не принимает приз: остановка вместо бесконечного цикла', async () => {
    mount({ server: { quantity: 10, rows: { 5: 5 }, ignore: ['get_item'] } }); run();
    await start();
    expect(statusText()).toContain('не принимает действие');
    expect(game.count('get_item')).toBeLessThanOrEqual(3);
  });
});

describe('collection.js: сессия, настройки, копирование', () => {
  it('цель и «выше цели» помнятся в профиле окна', () => {
    mount(); run();
    setTarget(3);
    selectAbove('5');
    mount(); run();
    expect(btn('3').className).toContain('on');
    expect(shadow.querySelector('select').value).toBe('5');
  });

  it('статистика окна переживает перезагрузку страницы и сбрасывается кнопкой', async () => {
    mount({ server: { quantity: 4, drops: [1, 2, 3, 3] } }); run();
    await start();
    expect(shadow.querySelector('.tot-ses').textContent).toBe('4');
    mount(); run();
    expect(shadow.querySelector('.tot-ses').textContent).toBe('4');
    expect(shadow.querySelector('.tot-run').textContent).toBe('0');
    click('Сбросить');
    expect(shadow.querySelector('.tot-ses').textContent).toBe('0');
  });

  it('копирование: текст со статистикой по категориям', async () => {
    mount({ server: { quantity: 4, drops: [1, 1, 2, 5], rows: { 5: 4 } } }); run();
    setTarget(6);
    await start();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    click('Копировать');
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    expect(copied).toContain('Открыто карточек: 4');
    expect(copied).toContain('1 категория: 2 | 50.0%');
    expect(copied).toContain('5 категория: 1 | 25.0%');
    expect(copied).toContain('6 категория: только обмен, получено 1');
  });

  it('панель сворачивается во вкладку и разворачивается', () => {
    mount(); run();
    click('◀');
    expect(buttons().length).toBe(1);
    expect(btn('Коллекция')).toBeTruthy();
    btn('Коллекция').click();
    expect(btn('Старт')).toBeTruthy();
  });
});

describe('collection.js: анимация выпадения', () => {
  it('в момент выпадения строка категории подсвечивается, всплывает «+1», в ленте появляется карточка', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);          // пауза перед карточкой ровно 350 мс
    mount({ server: { quantity: 20, drops: [3, 3] } }); run();
    click('Старт');
    click('Запустить');
    await vi.advanceTimersByTimeAsync(350);
    expect(game.count('turn')).toBe(1);
    const hit = shadow.querySelectorAll('.prog.hit');
    expect(hit.length).toBe(1);
    expect(hit[0].querySelector('.fx').textContent).toBe('+1');
    expect(hit[0].textContent).toContain('3');
    expect([...shadow.querySelectorAll('.feed i')].map((i) => i.textContent)).toEqual(['3']);
    expect(shadow.querySelector('.feed i.new')).toBeTruthy();
    // эффект одноразовый: следующая перерисовка без выпадения его не повторяет
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    vi.restoreAllMocks();
    click('Стоп');
    await until(() => /Остановлено вами/.test(statusText()));
  });

  it('анимация не добавляет пауз: темп открытия тот же, что и без неё', async () => {
    const turnsIn5s = async (anim) => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      localStorage.clear();
      mount({ server: { quantity: 500 } }); run();
      if (!anim) shadow.querySelector('.chk input').click();
      click('Старт');
      click('Запустить');
      await vi.advanceTimersByTimeAsync(5000);
      const n = game.count('turn');
      click('Стоп');
      await until(() => /Остановлено вами/.test(statusText()));
      vi.restoreAllMocks();
      return n;
    };
    expect(await turnsIn5s(true)).toBe(await turnsIn5s(false));
  });

  it('обмен показывает «−5» на старой категории и «+1» на следующей; приз — 🏆', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mount({ server: { quantity: 3, rows: { 1: 5 } } }); run();
    setTarget(2);
    click('Старт');
    click('Запустить');
    await vi.advanceTimersByTimeAsync(250);
    const labels = [...shadow.querySelectorAll('.prog')].map((r) => [...r.querySelectorAll('.fx')].map((f) => f.textContent));
    expect(labels[0]).toEqual(['−5']);
    expect(labels[1]).toEqual(['+1']);
    vi.restoreAllMocks();
    click('Стоп');
    await until(() => /Остановлено вами/.test(statusText()));
  });

  it('галочка «Анимация» выключает эффекты, но лента выпавших остаётся; выбор помнится', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mount({ server: { quantity: 20, drops: [2, 2] } }); run();
    shadow.querySelector('.chk input').click();
    mount({ server: { quantity: 20, drops: [2, 2] } }); run();
    expect(shadow.querySelector('.chk input').checked).toBe(false);
    click('Старт');
    click('Запустить');
    await vi.advanceTimersByTimeAsync(350);
    expect(shadow.querySelector('.prog.hit')).toBeNull();
    expect(shadow.querySelector('.fx')).toBeNull();
    expect([...shadow.querySelectorAll('.feed i')].map((i) => i.textContent)).toEqual(['2']);
    vi.restoreAllMocks();
    click('Стоп');
    await until(() => /Остановлено вами/.test(statusText()));
  });
});

describe('collection.js: шестая категория не падает с карточек', () => {
  it('в таблице у 6-й нет выпадений, только «обмен ×N»; доли считаются по категориям 1–5', async () => {
    mount({ server: { quantity: 4, drops: [1, 2, 5, 5], rows: { 5: 3 } } }); run();
    setTarget(6);
    await start();
    expect(game.rows[6]).toBe(1);
    const six = [...shadow.querySelectorAll('tr')][6];
    expect([...six.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['6', '—', '—', 'обмен ×1']);
    expect(shadow.querySelector('.tot-ses').textContent).toBe('4');
    expect(shadow.querySelector('.feed')).toBeTruthy();
    expect([...shadow.querySelectorAll('.feed i')].every((i) => Number(i.textContent) <= 5)).toBe(true);
  });

  it('если вырос только счёт 6-й категории, выпавшей карточкой это не считается', async () => {
    mount({ server: { quantity: 3 } });
    const real = game.fetch;
    // скрипт запоминает fetch при запуске: подмену ставим до run()
    window.fetch = async (url, init) => {
      const res = await real(url, init);
      if (/doo=turn/.test(url)) { game.rows[1] -= 1; game.rows[6] += 1; }
      return res;
    };
    run();
    await start();
    expect(shadow.querySelector('.tot-ses').textContent).toBe('3');
    expect([...shadow.querySelectorAll('tr')].slice(1, 6).every((tr) => tr.querySelector('.cnt-ses').textContent === '0')).toBe(true);
    expect(text()).toContain('Без категории: 3');
  });

  it('контроль: тестовый сервер не умеет ронять 6-ю категорию', () => {
    mount({ server: { quantity: 1, drops: [6] } });
    return expect(game.fetch('/minigames.php?game=collection&doo=turn')).rejects.toThrow('только категории 1–5');
  });
});

describe('collection.js: отчёт о запуске для журнала приложения', () => {
  const hashPayload = () => JSON.parse(decodeURIComponent(window.location.hash.replace('#TFCOL1_', '')));
  const outbox = () => JSON.parse(localStorage.getItem('__tf_col_outbox') || '[]');
  const appTakesReports = () => window.history.replaceState(null, '', window.location.pathname + window.location.search);

  it('после запуска отчёт лежит в hash: цель, выпадения, призы, обмены, итог', async () => {
    mount({ server: { quantity: 9, drops: [1, 1, 1, 1, 1, 2, 2, 2, 2] } }); run();
    setTarget(2);
    await start();
    expect(window.location.hash.startsWith('#TFCOL1_')).toBe(true);
    const { data, error } = hashPayload();
    expect(error).toBeNull();
    expect(data.reports).toHaveLength(1);
    const r = data.reports[0];
    expect(r).toMatchObject({ v: 1, target: 2, above: 'stop', maxCards: 0, opened: 9, left: 0, code: 'empty', kind: 'ok' });
    expect(r.drops).toEqual({ 1: 5, 2: 4, 3: 0, 4: 0, 5: 0 });
    expect(r.claimed).toEqual({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0 });
    expect(r.promoted).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(r.id).toMatch(/^[a-z0-9]{6,}$/);
    expect(Date.parse(r.end)).toBeGreaterThanOrEqual(Date.parse(r.start));
  });

  it('hash не начинается с «TF_»: приложение не считает окно служебной страницей', async () => {
    mount({ server: { quantity: 2 } }); run();
    await start();
    expect(window.location.hash.startsWith('#TF_')).toBe(false);
  });

  it('в отчёте нет ника, почты и адресов страницы', async () => {
    mount({ server: { quantity: 2 } }); run();
    await start();
    const raw = JSON.stringify(hashPayload());
    expect(raw).not.toMatch(/@|u_\d|https?:|pwonline/i);
  });

  it('приложение забрало отчёт (hash убран): отчёт выходит из очереди, в журнале панели появляется отметка', async () => {
    mount({ server: { quantity: 3 } }); run();
    await start();
    expect(outbox()).toHaveLength(1);
    appTakesReports();
    await vi.advanceTimersByTimeAsync(1500);
    expect(outbox()).toHaveLength(0);
    expect(text()).toContain('Запуск записан в журнал приложения');
  });

  it('пока приложение не забрало отчёт, он хранится и отправляется снова после перезагрузки страницы', async () => {
    mount({ server: { quantity: 3 } }); run();
    await start();
    const id = outbox()[0].id;
    // страницу перезагрузили (таймеры старой страницы умерли), hash пропал, отчёт не принят
    vi.clearAllTimers();
    mount(); run();
    expect(window.location.hash).toBe('');
    await vi.advanceTimersByTimeAsync(1600);
    expect(window.location.hash.startsWith('#TFCOL1_')).toBe(true);
    expect(hashPayload().data.reports[0].id).toBe(id);
  });

  it('несколько запусков подряд: отчёты уходят пачкой и не теряются', async () => {
    mount({ server: { quantity: 9 } }); run();
    const inp = shadow.querySelector('input');
    inp.value = '3';
    inp.dispatchEvent(new Event('change'));
    await start();
    const first = outbox()[0].id;
    await start();                                  // приложение первый отчёт ещё не забрало
    const ids = hashPayload().data.reports.map((r) => r.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(first);
    appTakesReports();
    await vi.advanceTimersByTimeAsync(1500);
    expect(outbox()).toHaveLength(0);
  });

  it('пустой запуск без проблем (карточек нет) в журнал не пишется, проблема — пишется', async () => {
    mount({ server: { quantity: 0 } }); run();
    await start();
    expect(outbox()).toHaveLength(0);
    expect(window.location.hash).toBe('');
    mount({ server: { info: '<html><body>Проверка безопасности</body></html>' } }); run();
    await start();
    const r = hashPayload().data.reports[0];
    expect(r).toMatchObject({ kind: 'warn', code: 'challenge', opened: 0 });
    expect(r.message).toContain('проверку безопасности');
  });

  it('запуск, остановленный кнопкой «Стоп» после нескольких карт, записывается', async () => {
    mount({ server: { quantity: 500 } }); run();
    click('Старт');
    click('Запустить');
    await until(() => game.count('turn') >= 3);
    click('Стоп');
    await until(() => /Остановлено вами/.test(statusText()));
    const r = hashPayload().data.reports[0];
    expect(r.opened).toBeGreaterThanOrEqual(3);
    expect(r.code).toBe('stopped');
  });
});

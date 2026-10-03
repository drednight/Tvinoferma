// Скрипт активации промокода (src-tauri/src/scripts/promo.js, Issue #25).
// Страница ввода — НАСТОЯЩАЯ (tests/fixtures/site-pin-code.html: /pin/<код>, и site-pin-empty.html: /pin.php).
// Страницы-ответы после нажатия «Активировать» — СИНТЕТИЧЕСКИЕ: настоящих пока нет (docs/FIXTURES.md).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runPageScript, buildScript, fixture, editDom } from './helpers/pageScript.js';

const CODE = 'PWZNANIYA26';
const page = (body, title = 'Perfect World') => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const run = (html, mode = 'inspect', extra = {}) => {
  window.__TF_PIN = { mode, code: CODE, ...extra };
  return runPageScript('promo.js', html, 'TF_PIN_V1_');
};
const FORM = (value = '', label = 'Активировать') =>
  `<div id="content_body"><div class="pin_description"><p>Пин-коды — это специальные ключи, получите бонусы.</p></div><h3 class="pin_header">Введите ключ</h3>` +
  `<form method="POST" action="/pin.php?do=activate"><input type="text" id="pin" name="pin" value="${value}"><input type="hidden" name="game_account" value=""><input type="submit" value="${label}"></form></div>`;

beforeEach(() => { window.__TF_PIN = undefined; });

describe('promo.js: настоящая страница ввода (inspect, только чтение)', () => {
  it('/pin/<код>: код уже подставлен, кнопка «Активировать» найдена', () => {
    const r = run(fixture('site-pin-code.html'));
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ state: 'ready', label: 'активировать', filled: true });
    expect(r.data.sig).toMatch(/^\d+$/);
  });

  it('/pin.php: поле пустое → filled=false (код будет введён при нажатии)', () => {
    expect(run(fixture('site-pin-empty.html')).data).toMatchObject({ state: 'ready', filled: false });
  });

  it('другой код в поле не считается введённым', () => {
    expect(run(fixture('site-pin-code.html'), 'inspect', { code: 'OTHER1234' }).data.filled).toBe(false);
  });

  it('вёрстка изменилась: нет формы / кнопки → pending, а не «успех»', () => {
    const noForm = editDom(fixture('site-pin-code.html'), (d) => d.querySelector('form').remove());
    expect(run(noForm)).toEqual({ data: 'complete', error: 'pending' });
    const noBtn = editDom(fixture('site-pin-code.html'), (d) => d.querySelector('input[type=submit]').remove());
    expect(run(noBtn).error).toBe('pending');
    const renamed = editDom(fixture('site-pin-code.html'), (d) => { d.querySelector('input[type=submit]').value = 'Что-то другое'; });
    expect(run(renamed).error).toBe('pending');
  });

  it('постоянное описание страницы не принимается за ответ сайта', () => {
    const html = page(FORM(CODE).replace('получите бонусы', 'код уже использован не раз, не существует, успешно'));
    expect(run(html).data.state).toBe('ready');
  });
});

describe('promo.js: прочие состояния страницы', () => {
  it('подпись должна совпадать целиком: «Активировать позже» не подходит', () => {
    expect(run(page(FORM(CODE, 'Активировать позже'))).error).toBe('pending');
  });

  it('запасная подпись «Ввести» тоже подходит; кнопка может быть <button>', () => {
    expect(run(page(FORM(CODE, 'Ввести'))).data.state).toBe('ready');
    expect(run(page(FORM(CODE).replace(/<input type="submit"[^>]*>/, '<button type="submit">Активировать</button>'))).data.state).toBe('ready');
  });

  it('посторонние кнопки страницы (выход, меню) не учитываются', () => {
    const html = page(FORM(CODE) + '<input type="button" class="btn_logout" value=""><button>Активировать</button>');
    expect(run(html).data.state).toBe('ready');
  });

  it('невидимая кнопка не считается', () => {
    expect(run(page(FORM(CODE).replace('<input type="submit"', '<input type="submit" hidden'))).error).toBe('pending');
  });

  it('две кнопки в форме → button_ambiguous', () => {
    const html = page(FORM(CODE).replace('</form>', '<input type="submit" value="Активировать"></form>'));
    expect(run(html)).toEqual({ data: 2, error: 'button_ambiguous' });
  });

  it('выбор игрового аккаунта в форме (несколько вариантов) → needs_choice', () => {
    const html = page(FORM(CODE).replace('</form>', '<select name="game_account"><option>1</option><option>2</option></select></form>'));
    expect(run(html)).toEqual({ data: null, error: 'needs_choice' });
  });

  it('код уже использован / недействителен — отвечаем до нажатия', () => {
    expect(run(page('<div id="content_body"><p>Этот пин-код уже использован.</p></div>')).error).toBe('already_used');
    expect(run(page('<div id="content_body"><p>Пин-код не существует</p></div>')).error).toBe('invalid_code');
  });

  it('нет входа → not_logged_in', () => {
    expect(run(fixture('site-warning.html')).error).toBe('not_logged_in');
  });

  it('«Проверка безопасности» → challenge', () => {
    expect(run(page('<p>Проверяем браузер…</p>', 'Проверка безопасности')).error).toBe('challenge');
  });
});

describe('promo.js: ответ сайта после нажатия (result; страницы-ответы синтетические)', () => {
  const sigOf = (html) => run(html).data.sig;
  const BASE = fixture('site-pin-code.html');
  const answer = (text) => page(`<div id="content_body"><p>${text}</p></div>`);

  it('страница не изменилась → pending (текст до нажатия нельзя принять за ответ)', () => {
    expect(run(BASE, 'result', { baseline: sigOf(BASE) })).toEqual({ data: 'complete', error: 'pending' });
  });

  it('успех, «уже использован», «недействителен»', () => {
    const base = sigOf(BASE);
    expect(run(answer('Пин-код успешно активирован! Бонусы начислены.'), 'result', { baseline: base }).data.state).toBe('success');
    expect(run(answer('Пин-код уже использован'), 'result', { baseline: base }).error).toBe('already_used');
    expect(run(answer('Неверный код'), 'result', { baseline: base }).error).toBe('invalid_code');
  });

  it('страница изменилась, но ответ не распознан → unknown + кусок текста для разбора', () => {
    const r = run(answer('Что-то странное произошло'), 'result', { baseline: sigOf(BASE) });
    expect(r.error).toBe('unknown');
    expect(r.data).toContain('Что-то странное');
  });

  it('потеря входа после нажатия → not_logged_in', () => {
    expect(run(fixture('site-warning.html'), 'result', { baseline: sigOf(BASE) }).error).toBe('not_logged_in');
  });
});

describe('promo.js: нажатие (click)', () => {
  const prepare = (html, code = CODE) => {
    if (!('innerText' in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, configurable: true });
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    document.title = doc.title;
    document.body.innerHTML = doc.body.innerHTML;
    window.location.hash = '';
    window.__TF_PIN = { mode: 'click', code };
  };
  const exec = () => new Function(buildScript('promo.js'))();
  const payload = () => JSON.parse(decodeURIComponent(window.location.hash.replace('#TF_PIN_V1_', '')));

  it('на /pin/<код>: нажимает «Активировать» ровно один раз, код не трогает, ответа не пишет', () => {
    prepare(fixture('site-pin-code.html'));
    const onClick = vi.fn((e) => e.preventDefault());
    document.querySelector('input[type=submit]').addEventListener('click', onClick);
    exec();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#pin').value).toBe(CODE);
    expect(window.location.hash).toBe('');
  });

  it('на /pin.php: сначала вводит код в пустое поле, потом нажимает', () => {
    prepare(fixture('site-pin-empty.html'));
    let valueAtClick = null;
    document.querySelector('input[type=submit]').addEventListener('click', (e) => { e.preventDefault(); valueAtClick = document.querySelector('#pin').value; });
    exec();
    expect(valueAtClick).toBe(CODE);
  });

  it('не нажимает, если кнопок две, код недействителен или нужен выбор аккаунта', () => {
    const clicked = vi.fn((e) => e.preventDefault());
    [
      page(FORM(CODE).replace('</form>', '<input type="submit" value="Активировать"></form>')),
      page('<div id="content_body"><p>Пин-код не существует</p></div>' + FORM(CODE)),
      page(FORM(CODE).replace('</form>', '<select><option>1</option><option>2</option></select></form>'))
    ].forEach((html) => {
      prepare(html);
      document.querySelectorAll('input[type=submit]').forEach((b) => b.addEventListener('click', clicked));
      exec();
    });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('кнопка не найдена → button_not_found (Rust не считает ввод выполненным)', () => {
    prepare(page('<p>пусто</p>'));
    exec();
    expect(payload().error).toBe('button_not_found');
  });
});

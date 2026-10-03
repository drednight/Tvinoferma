// Скрипт активации промокода (src-tauri/src/scripts/promo.js, Issue #25) на НАСТОЯЩИХ страницах pwonline.ru:
//   site-pin-code.html     — /pin/<код>: код подставлен в поле, кнопка «Активировать»
//   site-pin-empty.html    — /pin.php: поле пустое
//   site-pin-result-*.html — ответы после нажатия: ok (13 наград), used, expired, nobonus, empty
// Ответа на заведомо неверный код (не «нет бонусов») у нас нет — он покрыт только общими правилами.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runPageScript, buildScript, fixture, editDom } from './helpers/pageScript.js';

const CODE = 'PWZNANIYA26';
const page = (body, title = 'Perfect World') => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const run = (html, mode = 'inspect', extra = {}) => {
  window.__TF_PIN = { mode, code: CODE, ...extra };
  return runPageScript('promo.js', html, 'TF_PIN_V1_');
};
const sigOfInput = () => run(fixture('site-pin-code.html')).data.sig;
const result = (file) => run(fixture(file), 'result', { baseline: sigOfInput() });

beforeEach(() => { window.__TF_PIN = undefined; });

describe('promo.js: страница ввода (inspect, только чтение)', () => {
  it('/pin/<код>: код подставлен, кнопка «Активировать» найдена', () => {
    const r = run(fixture('site-pin-code.html'));
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ state: 'ready', label: 'активировать' });
    expect(r.data.sig).toMatch(/^\d+$/);
  });

  it('код всегда берётся из адреса: пустое поле или чужой код — ничего не нажимаем, ошибка code_not_filled', () => {
    expect(run(fixture('site-pin-empty.html'))).toEqual({ data: null, error: 'code_not_filled' });
    expect(run(fixture('site-pin-code.html'), 'inspect', { code: 'OTHER1234' }).error).toBe('code_not_filled');
  });

  it('регистр кода не важен', () => {
    expect(run(fixture('site-pin-code.html'), 'inspect', { code: 'pwznaniya26' }).data.state).toBe('ready');
  });

  it('вёрстка изменилась: нет формы / кнопки / подпись другая → pending, а не «успех»', () => {
    const noForm = editDom(fixture('site-pin-code.html'), (d) => d.querySelector('form').remove());
    expect(run(noForm)).toEqual({ data: 'complete', error: 'pending' });
    const noBtn = editDom(fixture('site-pin-code.html'), (d) => d.querySelector('input[type=submit]').remove());
    expect(run(noBtn).error).toBe('pending');
    const renamed = editDom(fixture('site-pin-code.html'), (d) => { d.querySelector('input[type=submit]').value = 'Что-то другое'; });
    expect(run(renamed).error).toBe('pending');
    const later = editDom(fixture('site-pin-code.html'), (d) => { d.querySelector('input[type=submit]').value = 'Активировать позже'; });
    expect(run(later).error).toBe('pending');
  });

  it('посторонние кнопки страницы (выход, меню) не учитываются; невидимая кнопка не считается', () => {
    const extra = editDom(fixture('site-pin-code.html'), (d) => { d.body.insertAdjacentHTML('beforeend', '<button>Активировать</button>'); });
    expect(run(extra).data.state).toBe('ready');
    const hiddenBtn = editDom(fixture('site-pin-code.html'), (d) => d.querySelector('input[type=submit]').setAttribute('hidden', ''));
    expect(run(hiddenBtn).error).toBe('pending');
  });

  it('две кнопки в форме → button_ambiguous; выбор аккаунта → needs_choice', () => {
    const two = editDom(fixture('site-pin-code.html'), (d) => d.querySelector('form').insertAdjacentHTML('beforeend', '<input type="submit" value="Активировать">'));
    expect(run(two)).toEqual({ data: 2, error: 'button_ambiguous' });
    const choice = editDom(fixture('site-pin-code.html'), (d) => d.querySelector('form').insertAdjacentHTML('beforeend', '<select><option>1</option><option>2</option></select>'));
    expect(run(choice)).toEqual({ data: null, error: 'needs_choice' });
  });

  it('нет входа → not_logged_in; «Проверка безопасности» → challenge', () => {
    expect(run(fixture('site-warning.html')).error).toBe('not_logged_in');
    expect(run(page('<p>Проверяем браузер…</p>', 'Проверка безопасности')).error).toBe('challenge');
  });

  it('постоянное описание страницы («Пин-коды — это специальные ключи…») не принимается за ответ', () => {
    expect(run(fixture('site-pin-code.html')).data.state).toBe('ready');
  });
});

describe('promo.js: ответ сайта после нажатия (result, настоящие страницы)', () => {
  it('страница не изменилась → pending (текст до нажатия нельзя принять за ответ)', () => {
    expect(run(fixture('site-pin-code.html'), 'result', { baseline: sigOfInput() })).toEqual({ data: 'complete', error: 'pending' });
  });

  it('успех: все 13 наград с названием, количеством, ID и признаком «привязанный»', () => {
    const r = result('site-pin-result-ok.html');
    expect(r.error).toBeNull();
    expect(r.data.state).toBe('success');
    expect(r.data.detail).toContain('успешно активировали пин-код');
    expect(r.data.rewards).toHaveLength(13);
    expect(r.data.rewards[1]).toEqual({ name: 'Метеорит', qty: 100, id: '47493', bound: true });
    expect(r.data.rewards[0]).toEqual({ name: 'Коробочка с картой S', qty: 60, id: '42202', bound: true });
    // название со скобками и без количества
    expect(r.data.rewards[10]).toEqual({ name: 'Набор рун (8-го ур.)', qty: 1, id: '71238', bound: true });
  });

  it('«Вы уже активировали этот пин-код!» → already_used', () => {
    expect(result('site-pin-result-used.html')).toEqual({ data: 'Вы уже активировали этот пин-код!', error: 'already_used' });
  });

  it('«Время действия пин-кода истекло!» → expired', () => {
    expect(result('site-pin-result-expired.html')).toEqual({ data: 'Время действия пин-кода истекло!', error: 'expired' });
  });

  it('«Не добавлены бонусы для этого типа пин-кода» → invalid_code (код неверный или ещё не настроен)', () => {
    expect(result('site-pin-result-nobonus.html').error).toBe('invalid_code');
  });

  it('«Пустой пин-код» → code_empty (Rust: результат неясен)', () => {
    expect(result('site-pin-result-empty.html').error).toBe('code_empty');
  });

  it('страница изменилась, но ответ не распознан → unknown + кусок текста для разбора', () => {
    const r = run(page('<div id="content_body"><p>Что-то странное произошло</p></div>'), 'result', { baseline: sigOfInput() });
    expect(r.error).toBe('unknown');
    expect(r.data).toContain('Что-то странное');
  });

  it('сообщение об ошибке с незнакомым текстом → unknown, а не успех', () => {
    const html = page('<div id="content_body"><div class="m_error">Попробуйте позже</div></div>');
    expect(run(html, 'result', { baseline: sigOfInput() })).toEqual({ data: 'Попробуйте позже', error: 'unknown' });
  });

  it('потеря входа после нажатия → not_logged_in', () => {
    expect(run(fixture('site-warning.html'), 'result', { baseline: sigOfInput() }).error).toBe('not_logged_in');
  });

  it('успех без списка наград: success с пустым списком (не ошибка)', () => {
    const html = page('<h2>Вы успешно активировали пин-код ABCD1234</h2><div id="content_body"><div class="pin_bonuses_list"><p>Вам было выдано:</p></div></div>');
    const r = run(html, 'result', { baseline: sigOfInput() });
    expect(r.data.state).toBe('success');
    expect(r.data.rewards).toEqual([]);
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

  it('на /pin/<код>: нажимает «Активировать» ровно один раз, код в поле не трогает, ответа не пишет', () => {
    prepare(fixture('site-pin-code.html'));
    const onClick = vi.fn((e) => e.preventDefault());
    document.querySelector('input[type=submit]').addEventListener('click', onClick);
    exec();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#pin').value).toBe(CODE);
    expect(window.location.hash).toBe('');
  });

  it('пустое поле: код сам НЕ вводится и кнопка не нажимается', () => {
    prepare(fixture('site-pin-empty.html'));
    const onClick = vi.fn((e) => e.preventDefault());
    document.querySelector('input[type=submit]').addEventListener('click', onClick);
    exec();
    expect(onClick).not.toHaveBeenCalled();
    expect(document.querySelector('#pin').value).toBe('');
    expect(payload().error).toBe('code_not_filled');
  });

  it('не нажимает, если кнопок две, нужен выбор аккаунта или сайт уже сообщил об ошибке', () => {
    const clicked = vi.fn((e) => e.preventDefault());
    [
      editDom(fixture('site-pin-code.html'), (d) => d.querySelector('form').insertAdjacentHTML('beforeend', '<input type="submit" value="Активировать">')),
      editDom(fixture('site-pin-code.html'), (d) => d.querySelector('form').insertAdjacentHTML('beforeend', '<select><option>1</option><option>2</option></select>')),
      editDom(fixture('site-pin-code.html'), (d) => d.querySelector('#content_body').insertAdjacentHTML('afterbegin', '<div class="m_error">Время действия пин-кода истекло!</div>'))
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

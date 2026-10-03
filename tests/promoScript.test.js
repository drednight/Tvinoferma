// Скрипт активации промокода (src-tauri/src/scripts/promo.js, Issue #25) на страницах /pin/<КОД>.
// ВАЖНО: страницы ниже СИНТЕТИЧЕСКИЕ (настоящую страницу промокода сохранить не удалось): они описывают
// предполагаемую вёрстку. Когда будут настоящие обезличенные страницы (docs/FIXTURES.md), добавьте их сюда.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runPageScript, buildScript } from './helpers/pageScript.js';

const page = (body, title = 'Perfect World') => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const READY = page('<div id="content_body"><h1>Пин-код</h1><p>Промокод даёт бонус.</p><form><input type="submit" value="Ввести"></form></div>');
const run = (html, mode = 'inspect', extra = {}) => {
  window.__TF_PIN = { mode, code: 'ABCD1234', ...extra };
  return runPageScript('promo.js', html, 'TF_PIN_V1_');
};

beforeEach(() => { window.__TF_PIN = undefined; });

describe('promo.js: осмотр страницы (inspect, только чтение)', () => {
  it('страница с одной кнопкой «Ввести» готова, отдаёт подпись и отпечаток страницы', () => {
    const r = run(READY);
    expect(r.error).toBeNull();
    expect(r.data.state).toBe('ready');
    expect(r.data.label).toBe('ввести');
    expect(r.data.sig).toMatch(/^\d+$/);
  });

  it('кнопка может быть <button> или ссылкой-кнопкой', () => {
    expect(run(page('<button type="submit">Ввести</button>')).data.state).toBe('ready');
    expect(run(page('<a class="btn" href="#">  Ввести </a>')).data.state).toBe('ready');
  });

  it('«Ввести позже» и другие подписи не подходят (подпись целиком)', () => {
    expect(run(page('<button>Ввести позже</button>'))).toEqual({ data: 'complete', error: 'pending' });
  });

  it('нет кнопки → pending (Rust подождёт и повторит); невидимая кнопка не считается', () => {
    expect(run(page('<p>Привет</p>'))).toEqual({ data: 'complete', error: 'pending' });
    expect(run(page('<div style="display:none"><button>Ввести</button></div>')).error).toBe('pending');
  });

  it('две кнопки «Ввести» → button_ambiguous, ничего не нажимаем', () => {
    expect(run(page('<button>Ввести</button><input type="submit" value="Ввести">'))).toEqual({ data: 2, error: 'button_ambiguous' });
  });

  it('выбор игрового аккаунта (несколько вариантов) → needs_choice', () => {
    const html = page('<form><select name="acc"><option>1</option><option>2</option></select><input type="submit" value="Ввести"></form>');
    expect(run(html)).toEqual({ data: null, error: 'needs_choice' });
  });

  it('код уже использован / недействителен — отвечаем до нажатия', () => {
    expect(run(page('<p>Этот пин-код уже использован.</p><button>Ввести</button>')).error).toBe('already_used');
    expect(run(page('<p>Пин-код не существует</p>')).error).toBe('invalid_code');
    expect(run(page('<p>Срок действия истёк</p>')).error).toBe('invalid_code');
  });

  it('нет входа → not_logged_in', () => {
    expect(run(page('<p>Вы не авторизованы</p>')).error).toBe('not_logged_in');
    expect(run(page('<p>Для доступа к разделу необходимо войти</p>')).error).toBe('not_logged_in');
  });

  it('«Проверка безопасности» → challenge', () => {
    expect(run(page('<p>Проверяем браузер…</p>', 'Проверка безопасности')).error).toBe('challenge');
  });
});

describe('promo.js: ответ сайта после нажатия (result)', () => {
  const sigOf = (html) => run(html).data.sig;

  it('текст страницы не изменился → pending (текст до нажатия нельзя принять за ответ)', () => {
    const withSuccessWord = page('<p>Бонус будет успешно начислен после ввода.</p><button>Ввести</button>');
    expect(run(withSuccessWord, 'result', { baseline: sigOf(withSuccessWord) })).toEqual({ data: 'complete', error: 'pending' });
  });

  it('успех, «уже использован», «недействителен»', () => {
    const base = sigOf(READY);
    expect(run(page('<p>Пин-код успешно активирован! Бонусы начислены.</p>'), 'result', { baseline: base }).data.state).toBe('success');
    expect(run(page('<p>Пин-код уже использован</p>'), 'result', { baseline: base }).error).toBe('already_used');
    expect(run(page('<p>Неверный код</p>'), 'result', { baseline: base }).error).toBe('invalid_code');
  });

  it('страница изменилась, но ответ не распознан → unknown + кусок текста для разбора', () => {
    const r = run(page('<p>Что-то странное произошло</p>'), 'result', { baseline: sigOf(READY) });
    expect(r.error).toBe('unknown');
    expect(r.data).toContain('Что-то странное');
  });

  it('потеря входа после нажатия → not_logged_in', () => {
    expect(run(page('<p>Вы не авторизованы</p>'), 'result', { baseline: sigOf(READY) }).error).toBe('not_logged_in');
  });
});

describe('promo.js: нажатие (click)', () => {
  const prepare = (html) => {
    if (!('innerText' in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, configurable: true });
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    document.title = doc.title;
    document.body.innerHTML = doc.body.innerHTML;
    window.location.hash = '';
    window.__TF_PIN = { mode: 'click', code: 'ABCD1234' };
  };

  it('нажимает единственную кнопку «Ввести» ровно один раз и ответа не пишет', () => {
    prepare(READY);
    const onClick = vi.fn((e) => e.preventDefault());
    document.querySelector('input[type=submit]').addEventListener('click', onClick);
    new Function(buildScript('promo.js'))();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('');
  });

  it('не нажимает, если кнопок две, код недействителен или нужен выбор аккаунта', () => {
    const clicked = vi.fn((e) => e.preventDefault());
    [
      page('<button>Ввести</button><button>Ввести</button>'),
      page('<p>Пин-код не существует</p><button>Ввести</button>'),
      page('<select><option>1</option><option>2</option></select><button>Ввести</button>')
    ].forEach((html) => {
      prepare(html);
      document.querySelectorAll('button').forEach((b) => b.addEventListener('click', clicked));
      new Function(buildScript('promo.js'))();
    });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('кнопка не найдена → button_not_found (Rust увидит отказ и не будет считать ввод выполненным)', () => {
    prepare(page('<p>пусто</p>'));
    new Function(buildScript('promo.js'))();
    const payload = JSON.parse(decodeURIComponent(window.location.hash.replace('#TF_PIN_V1_', '')));
    expect(payload.error).toBe('button_not_found');
  });
});

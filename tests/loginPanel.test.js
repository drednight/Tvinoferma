import { describe, it, expect, beforeEach, vi } from 'vitest';
import { panelBootstrap, buildPanelScript, panelDataFor } from '../js/desktop/loginPanel.js';

// Панель «Помощник входа» (issue #54): скрипт, внедряемый в окно браузера
const data = { nick: 'N<b>', contacts: { email: 'a@b.ru', password: 'secret&1', recoveryEmail: '', phone: '+7900' } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
let shadow;
let origAttach;

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  // closed shadow DOM в тесте делаем открытым, чтобы его можно было проверить
  origAttach = origAttach || Element.prototype.attachShadow;
  const orig = origAttach;
  Element.prototype.attachShadow = function (init) { shadow = orig.call(this, { ...init, mode: 'open' }); return shadow; };
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
});

describe('panelDataFor', () => {
  it('берёт контакты персонажа', () => {
    expect(panelDataFor({ nick: 'x', contacts: { email: 'e' } }).contacts).toEqual({ email: 'e', password: '', recoveryEmail: '', phone: '' });
    expect(panelDataFor(null).nick).toBe('');
  });
});

describe('panelBootstrap', () => {
  it('пароль скрыт, ник не интерпретируется как HTML, пустые поля помечены', () => {
    panelBootstrap(data);
    expect(document.getElementById('__tf_login_panel__')).not.toBeNull();
    const text = shadow.textContent;
    expect(text).not.toContain('secret');
    expect(text).toContain('••••');
    expect(text).toContain('N<b>');
    expect(shadow.querySelector('b')).toBeNull();
    expect(text).toContain('Не указано');
    expect(text).toContain('a@b.ru');
  });

  it('кнопка 📋 копирует реальный пароль', async () => {
    panelBootstrap(data);
    const copyBtns = [...shadow.querySelectorAll('button')].filter(b => b.textContent === '📋');
    copyBtns[1].click();   // email, пароль (recovery пуст)
    await wait();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('secret&1');
  });

  it('клик по самой строке копирует её значение (пароль — настоящий, не точки)', async () => {
    panelBootstrap(data);
    const vals = [...shadow.querySelectorAll('.val.clickable')];
    vals[0].click();
    vals[1].click();
    await wait();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('a@b.ru');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('secret&1');
  });

  it('кнопка «глаз» показывает пароль', () => {
    panelBootstrap(data);
    [...shadow.querySelectorAll('button')].find(b => b.textContent === '👁').click();
    expect(shadow.textContent).toContain('secret&1');
  });

  it('сворачивается, запоминает состояние и прячет контакты', () => {
    panelBootstrap(data);
    [...shadow.querySelectorAll('button')].find(b => b.textContent === '–').click();
    expect(localStorage.getItem('__tf_lp_collapsed')).toBe('1');
    expect(shadow.textContent).not.toContain('a@b.ru');
    shadow.querySelector('.tab').click();
    expect(shadow.textContent).toContain('a@b.ru');
  });

  it('повторный запуск заменяет панель, а не дублирует', () => {
    panelBootstrap(data);
    panelBootstrap(data);
    expect(document.querySelectorAll('#__tf_login_panel__').length).toBe(1);
  });

  it('buildPanelScript — самодостаточный скрипт с данными', () => {
    const script = buildPanelScript(data);
    expect(script).toContain('"secret&1"');
    (0, eval)(script);
    expect(document.getElementById('__tf_login_panel__')).not.toBeNull();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { captureScroll, restoreScroll, withPreservedScroll } from '../js/core/scrollPreservation.js';

const html = key => `
  <div class="outer" ${key ? `data-scroll-key="${key}"` : ''}>
    <div class="inner"><button type="button" data-cell="c|t">Отметка</button></div>
  </div>`;

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.scrollTop = 0;
  document.documentElement.scrollLeft = 0;
  document.body.scrollTop = 0;
  document.body.scrollLeft = 0;
});

describe('сохранение прокрутки при перерисовке', () => {
  it('возвращает прокрутку окна, вложенной области и фокус после замены DOM', () => {
    const root = document.createElement('div');
    root.innerHTML = html('table');
    document.body.appendChild(root);
    const outer = root.querySelector('.outer');
    outer.scrollTop = 90;
    outer.scrollLeft = 35;
    document.documentElement.scrollTop = 210;
    root.querySelector('[data-cell]').focus();

    withPreservedScroll(() => (root.innerHTML = html('table')), { scope: root, key: 'same' });

    const next = root.querySelector('.outer');
    expect(next.scrollTop).toBe(90);
    expect(next.scrollLeft).toBe(35);
    expect(document.documentElement.scrollTop).toBe(210);
    expect(document.activeElement?.getAttribute('data-cell')).toBe('c|t');
  });

  it('находит контейнер по пути, даже если у него нет data-scroll-key', () => {
    const root = document.createElement('div');
    root.innerHTML = html(null);
    document.body.appendChild(root);
    root.querySelector('.outer').scrollTop = 47;

    withPreservedScroll(() => (root.innerHTML = html(null)), { scope: root, key: 'same' });

    expect(root.querySelector('.outer').scrollTop).toBe(47);
  });

  it('ключ null и смена ключа между рендерами не возвращают старую позицию', () => {
    const root = document.createElement('div');
    root.innerHTML = html('table');
    document.body.appendChild(root);
    root.querySelector('.outer').scrollTop = 60;
    withPreservedScroll(() => (root.innerHTML = html('table')), { scope: root, key: null });
    expect(root.querySelector('.outer').scrollTop).toBe(0);

    root.querySelector('.outer').scrollTop = 60;
    let key = 'step-1';
    withPreservedScroll(
      () => {
        key = 'step-2';
        root.innerHTML = html('table');
      },
      { scope: root, key: () => key }
    );
    expect(root.querySelector('.outer').scrollTop).toBe(0);
  });

  it('работает с асинхронной перерисовкой', async () => {
    const root = document.createElement('div');
    root.innerHTML = html('table');
    document.body.appendChild(root);
    root.querySelector('.outer').scrollTop = 73;

    await withPreservedScroll(
      async () => {
        await Promise.resolve();
        root.innerHTML = html('table');
      },
      { scope: root, key: 'same' }
    );

    expect(root.querySelector('.outer').scrollTop).toBe(73);
  });

  it('captureScroll/restoreScroll можно использовать вручную', () => {
    const root = document.createElement('div');
    root.innerHTML = html(null);
    document.body.appendChild(root);
    root.querySelector('.outer').scrollTop = 18;
    const snapshot = captureScroll(root, 'same');
    root.innerHTML = html(null);
    expect(restoreScroll(snapshot, { key: 'other' })).toBe(false);
    expect(root.querySelector('.outer').scrollTop).toBe(0);
    expect(restoreScroll(snapshot, { key: 'same' })).toBe(true);
    expect(root.querySelector('.outer').scrollTop).toBe(18);
  });
});

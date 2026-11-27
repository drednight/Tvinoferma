// Низкое окно и левое меню нового интерфейса (css/core/newStyle.css).
// Layout в jsdom не считается, поэтому здесь проверка на уровне правила: у меню должен
// быть свой прокручиваемый блок с заданной высотой, иначе часть пунктов при маленьком
// окне оказывается за нижним краем и до них нельзя добраться ни мышью, ни клавиатурой.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('css/core/newStyle.css', 'utf8');
const block = re => css.match(re)?.[0] || '';

describe('левое меню в окне меньше содержимого', () => {
  const sidebar = block(/body\[data-ui-style='next'\] \.next-sidebar \{[^}]*\}/);

  it('панель прокручивается сама: height + overflow-y, а не обрезка', () => {
    expect(sidebar).toMatch(/height:\s*100vh/);
    expect(sidebar).toMatch(/overflow-y:\s*auto/);
    // `overflow: hidden` вместо auto — это тот же баг: контент есть, прокрутки нет.
    expect(sidebar).not.toMatch(/overflow:\s*hidden/);
    // Полоса по горизонтали съела бы 10 px из 248 (и из 76 в узком режиме), поэтому
    // поперёк меню не прокручивается.
    expect(sidebar).toMatch(/overflow-x:\s*clip/);
    // И не протаскивает за собой страницу: прокрутили меню — страница осталась на месте.
    expect(sidebar).toMatch(/overscroll-behavior:\s*contain/);
  });

  it('панель остаётся липкой и во всю высоту окна', () => {
    expect(sidebar).toMatch(/position:\s*sticky/);
    expect(sidebar).toMatch(/top:\s*0/);
    // Иначе при прокрутке страницы меню уезжало бы вместе с ней.
    expect(sidebar).toMatch(/grid-row:\s*1 \/ -1/);
  });

  it('плашка статуса серверов не сжимается в полоску', () => {
    // Иначе «не видно сервера»: блок отдавал бы высоту под прокрутку и превращался в
    // обрезанную подпись вместо списка.
    const status = block(/\.next-sidebar \.server-status \{[^}]*\}/);
    expect(status).toMatch(/flex:\s*none/);
    expect(status).toMatch(/display:\s*block/);
  });

  it('узкое меню (полоса иконок) тоже прокручивается, а нижняя строка — нет', () => {
    // В режиме 76 px пунктов больше, чем места, — прокрутка наследуется от панели.
    const rail = block(/@media \(max-width: 980px\)[\s\S]*?\n\}/);
    expect(rail).toMatch(/--next-sidebar-w:\s*76px/);
    expect(rail).not.toMatch(/\.next-sidebar \{[^}]*overflow[^}]*\}/);
    // А горизонтальная панель внизу экрана (≤680 px) — строка на 64 px: полоса
    // прокрутки отняла бы половину её высоты.
    const bar = block(/@media \(max-width: 680px\)[\s\S]*?body\[data-ui-style='next'\] \.next-sidebar \{([^}]*)\}/);
    expect(bar).toMatch(/overflow:\s*visible/);
  });

  it('меню страницы настроек прокручивается так же (тот же класс случаев)', () => {
    const layout = readFileSync('css/core/layout.css', 'utf8');
    const nav = layout.match(/\.settings-nav \{[^}]*\}/)?.[0] || '';
    expect(nav).toMatch(/height:\s*max\(0px, calc\(100vh - var\(--topbar-h, 64px\) - 56px\)\)/);
    expect(nav).toMatch(/overflow-y:\s*auto/);
  });

  it('классическое оформление не затронуто: без data-ui-style меню скрыто целиком', () => {
    // Панель есть в разметке всегда, и если бы базовое правило скрытия пропало,
    // прокрутка и высота появились бы там, где бокового меню нет вовсе.
    expect(css).toMatch(/\.next-sidebar,\s*\.next-page-heading \{\s*display: none;/);
    expect(css).toMatch(/body\[data-ui-style='next'\] \.next-sidebar \{[^}]*display: flex;/);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PAGES, NEXT_PAGES, variantsFor, nextVariantsFor, KINDS } from '../demo/design-lab/catalog.js';
import {
  createLabState,
  entriesFor,
  visibleEntries,
  markDay,
  selectedDay,
  launchParty,
  simulateCheck
} from '../demo/design-lab/model.js';
import { renderPage } from '../demo/design-lab/render.js';

describe('полный каталог двух независимых лабораторий', () => {
  it('contains 80 classic variants, preserves the three Today concepts, and excludes originals from counts', () => {
    expect(PAGES).toHaveLength(8);
    expect(PAGES.flatMap(p => variantsFor(p.id))).toHaveLength(80);
    for (const page of PAGES) {
      const variants = variantsFor(page.id);
      expect(variants).toHaveLength(10);
      expect(new Set(variants.map(v => v.name)).size).toBe(10);
      expect(new Set(variants.map(v => v.kind)).size).toBe(10);
    }
    expect(
      variantsFor('today')
        .slice(0, 3)
        .map(v => v.name)
    ).toEqual(['Обзор', 'План дня', 'Пульт']);
    expect(KINDS).toHaveLength(10);
  });
  it('has six original and five follow-up concepts per page', () => {
    expect(NEXT_PAGES).toHaveLength(9);
    expect(NEXT_PAGES.flatMap(p => nextVariantsFor(p.id))).toHaveLength(99);
    expect(new Set(NEXT_PAGES.map(p => p.source))).toEqual(new Set([...PAGES.map(p => p.id), 'activity']));
    for (const page of NEXT_PAGES) {
      expect(
        new Set(
          nextVariantsFor(page.id)
            .slice(0, 6)
            .map(v => v.kind)
        ).size
      ).toBe(6);
      expect(nextVariantsFor(page.id).filter(v => v.preferred)).toHaveLength(5);
      expect(page.why.length).toBeGreaterThan(25);
    }
  });
  for (const page of PAGES)
    for (const v of variantsFor(page.id))
      it(`renders ${page.id}/${v.id}: ${v.kind} with actionable data and full feature access`, () => {
        const html = renderPage(page.id, v, createLabState());
        const root = document.createElement('div');
        root.innerHTML = html;
        expect(root.querySelector(`[data-composition="${v.kind}"]`)).not.toBeNull();
        expect(root.querySelectorAll('[data-entry]').length).toBeGreaterThan(0);
        expect(root.querySelectorAll('[data-feature]').length).toBeGreaterThanOrEqual(page.features.length);
        expect(root.textContent).not.toMatch(/undefined|NaN/);
      });
  for (const page of NEXT_PAGES)
    for (const v of nextVariantsFor(page.id))
      it(`renders demo2 ${page.id}/${v.id}`, () => {
        const root = document.createElement('div');
        root.innerHTML = renderPage(page.source, v, createLabState());
        expect(root.querySelector('[data-entry]')).not.toBeNull();
        expect(root.querySelector('.lg-coverage')).not.toBeNull();
      });
  it('search, filters, and selection inputs are backed by the same model', () => {
    const state = createLabState();
    state.query = 'Радовика';
    expect(visibleEntries('characters', state).map(e => e.title)).toEqual(['Радовика']);
    state.filter = 'Готово';
    expect(visibleEntries('characters', state)).toEqual([]);
    state.query = '';
    state.filter = 'Фенрир';
    expect(visibleEntries('characters', state).every(e => e.entity.server === 'Фенрир')).toBe(true);
  });
  it('stores date-specific checkmarks and launches only explicitly chosen characters', () => {
    const state = createLabState();
    markDay(state, 'daily', true);
    const today = selectedDay(state);
    state.day.chosenDay = 1;
    expect(state.checkDates[selectedDay(state)]).toBeUndefined();
    expect(state.checkDates[today].daily).toBe(true);
    state.activeWindows = [];
    launchParty(state, 'p1', []);
    expect(state.activeWindows).toEqual([]);
    launchParty(state, 'p1', ['c2']);
    expect(state.activeWindows.map(w => w.charId)).toEqual(['c2']);
    launchParty(state, 'p1', ['c2']);
    expect(state.activeWindows).toHaveLength(1);
  });
  it('checks only marathon participants and does not double-credit', () => {
    const state = createLabState();
    simulateCheck(state);
    const snapshot = structuredClone(state.day.marathonProgress);
    simulateCheck(state);
    expect(state.day.marathonProgress).toEqual(snapshot);
    expect(state.day.marathonProgress).toHaveLength(4);
  });
  it('conditionally removes clan, promo, attention and marathon modules without empty banners', () => {
    const state = createLabState();
    state.scenarios = { clan: false, promo: false, attention: false, marathon: false };
    expect(entriesFor('today', state).map(e => e.id)).toEqual(['daily', 'party', 'calendar', 'windows']);
  });
  it('escapes edited synthetic names and keeps currencies separate', () => {
    const state = createLabState();
    state.characters[0].nick = '<img src=x onerror=alert(1)>';
    const html = renderPage('characters', variantsFor('characters')[1], state);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x');
    const finance = renderPage('bank', variantsFor('bank')[0], state);
    expect(finance).toContain('Древние монеты');
    expect(finance).toContain('Голд');
    expect(finance).toContain('Золото');
  });
  it('keeps new demos network/native/storage isolated and published outside the app bundle', () => {
    const app = readFileSync('demo/design-lab/app.js', 'utf8');
    const model = readFileSync('demo/design-lab/model.js', 'utf8');
    expect(app + model).not.toMatch(/localStorage|sessionStorage|__TAURI|fetch\(|invoke\(|window\.open\(/);
    for (const file of ['demo/variants/index.html', 'demo2/index.html'])
      expect(readFileSync(file, 'utf8')).toContain("connect-src 'none'");
    expect(readFileSync('.github/workflows/pages.yml', 'utf8')).toContain('cp -r demo demo2 css js dist/');
    expect(readFileSync('demo/today/index.html', 'utf8')).toContain('variant=10');
  });
});
it('new server route is explicit and a fresh example has a real local calendar model', () => {
  const server = readFileSync('demo/serve.mjs', 'utf8');
  expect(server).toContain("prefix: '/demo2/'");
  const state = createLabState();
  expect(state.calendarEvents).toHaveLength(2);
  state.characters.forEach(c => (c.auth = 'online'));
  state.scenarios.marathon = false;
  expect(entriesFor('today', state).some(e => e.id === 'attention')).toBe(false);
});

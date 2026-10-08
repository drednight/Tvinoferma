// selectors.json — единственное место, где живут селекторы, тексты и регулярные выражения парсеров (issue #13).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { loadSelectors, runOnFixture, editDom, buildScript } from './helpers/pageScript.js';

const SCRIPTS = 'src-tauri/src/scripts';
const cfg = loadSelectors();
const sections = ['selectors', 'texts', 'regex'];
const keysOf = (c) => sections.flatMap((s) => Object.keys(c[s]).map((k) => `${s}:${k}`));
const parserScripts = readdirSync(SCRIPTS).filter((f) => f.endsWith('.js') && !['common.js', 'popup_patch.js'].includes(f));

describe('selectors.json: структура', () => {
  it('есть версия и три раздела', () => {
    expect(Number.isInteger(cfg.version) && cfg.version >= 1).toBe(true);
    sections.forEach((s) => expect(typeof cfg[s]).toBe('object'));
  });

  it('каждая запись — непустой список непустых строк (основной вариант, затем запасные)', () => {
    keysOf(cfg).forEach((k) => {
      const [section, name] = k.split(':');
      const list = cfg[section][name];
      expect(Array.isArray(list) && list.length > 0, k).toBe(true);
      list.forEach((v) => expect(typeof v === 'string' && v.trim().length > 0, k).toBe(true));
    });
  });

  it('все CSS-селекторы валидны, регулярные выражения компилируются', () => {
    document.body.innerHTML = '<div></div>';
    Object.entries(cfg.selectors).forEach(([name, list]) => list.forEach((sel) => {
      expect(() => document.body.querySelector(sel), `${name}: ${sel}`).not.toThrow();
    }));
    Object.entries(cfg.regex).forEach(([name, list]) => list.forEach((src) => {
      expect(() => new RegExp(src), name).not.toThrow();
    }));
  });
});

describe('selectors.json и скрипты согласованы', () => {
  const usedBy = (key) => [...parserScripts, 'common.js'].filter((f) => readFileSync(`${SCRIPTS}/${f}`, 'utf8').includes(`'${key}'`));

  it('каждое имя из скриптов описано в конфиге (иначе парсер упадёт на странице)', () => {
    const known = new Set(keysOf(cfg).map((k) => k.split(':')[1]));
    [...parserScripts, 'common.js'].forEach((f) => {
      const src = readFileSync(`${SCRIPTS}/${f}`, 'utf8');
      const names = [...src.matchAll(/'((?:common|balance|auth|titles|marathon|news|promo|transfer|shop|caravan)\.[A-Za-z]+)'/g)].map((m) => m[1]);
      names.forEach((n) => expect(known.has(n), `${f}: «${n}» нет в selectors.json`).toBe(true));
    });
  });

  it('в конфиге нет неиспользуемых записей', () => {
    keysOf(cfg).forEach((k) => {
      const name = k.split(':')[1];
      expect(usedBy(name).length, `«${name}» не используется ни одним скриптом`).toBeGreaterThan(0);
    });
  });

  it('в скриптах не осталось прямых селекторов страницы (кроме общего слоя)', () => {
    parserScripts.forEach((f) => {
      const src = readFileSync(`${SCRIPTS}/${f}`, 'utf8');
      // querySelectorAll('*') в новости — очистка атрибутов клона, это не селектор страницы
      const direct = [...src.matchAll(/document\.querySelector(?:All)?\(\s*['"`]([^'"`]+)/g)].map((m) => m[1]);
      expect(direct, f).toEqual([]);
    });
  });
});

const balance = (edit, editConfig) => runOnFixture('balance.js', 'TF_BAL_V5_', 'site-chests2.html', edit, editConfig);
const renamePoints = (h) => editDom(h, (d) => { d.querySelector('.points_info').className = 'balance_box'; });

describe('запасные селекторы', () => {
  it('вёрстка изменилась, запасного нет → container_missing', () => {
    expect(balance(renamePoints)).toEqual({ data: null, error: 'container_missing' });
  });

  it('вёрстка изменилась, добавлен запасной селектор → баланс читается', () => {
    const r = balance(renamePoints, (c) => c.selectors['balance.container'].push('.balance_box'));
    expect(r).toEqual({ data: 464, error: null });
  });

  it('новый селектор можно поставить первым, старый остаётся запасным', () => {
    const r = balance((h) => h, (c) => c.selectors['balance.container'].unshift('.balance_box'));
    expect(r).toEqual({ data: 464, error: null });
  });

  it('неверный селектор в списке не ломает остальные', () => {
    const r = balance((h) => h, (c) => c.selectors['balance.container'].unshift('[[нет'));
    expect(r).toEqual({ data: 464, error: null });
  });

  it('регулярное выражение: основное не подошло — берётся запасное', () => {
    const run = (editConfig) => runOnFixture('marathon_news.js', 'TF_NEWS_V1_', 'site-news-summer.html', (h) => h, editConfig).data.publishedAt;
    const normal = run();
    expect(normal).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(run((c) => c.regex['news.date'].unshift('НЕТ_ТАКОГО_ТЕКСТА (\\d{2}\\.\\d{2}\\.\\d{4})'))).toBe(normal);
  });

  it('тексты берутся из конфига: другая фраза «не вошли» распознаётся', () => {
    const r = runOnFixture('check_auth.js', 'TF_AUTH_V2_', 'site-warning.html', (h) => h, (c) => { c.texts['common.notLoggedIn'] = ['Вход не выполнен']; });
    expect(r).toEqual({ data: 'complete', error: 'pending' });
  });

  it('без общего слоя скрипт сообщает config_missing, а не падает', () => {
    delete window.__TF;
    document.body.innerHTML = '<p>x</p>';
    window.location.hash = '';
    new Function(readFileSync(`${SCRIPTS}/balance.js`, 'utf8'))();
    expect(JSON.parse(decodeURIComponent(window.location.hash.replace('#TF_BAL_V5_', '')))).toEqual({ data: null, error: 'config_missing' });
  });

  it('версия конфига доступна скриптам', () => {
    new Function(buildScript('check_auth.js'))();
    expect(window.__TF.version).toBe(cfg.version);
  });
});

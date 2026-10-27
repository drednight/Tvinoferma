// demo/scenarios.js
// Лаборатория окон, часть 2: те же пять вариантов окон, что нарисованы для «Промокода»
// (текущий диалог, мастер шагов, два столбца, быстрый запуск с доком, консоль),
// но параметры, единицы работы и результаты подставляет сценарий:
// «Передача предметов», «Подарки» и «Сундук караванщика».
//
// Контракт сценария (объект из SCENARIOS):
//   id, icon, title, titleShort, cmd  — как зовём сценарий в окнах и в консоли
//   howItWorks                        — текст «что сделает этот скрипт»
//   paramTitle                        — заголовок блока параметров
//   defaultState()                    — начальное состояние параметров
//   paramForm(st)                     — разметка параметров
//   bindParams(root, st, onChange)    — слушатели параметров (ставятся один раз на root)
//   paramsLine(st)                    — короткая строка параметров для сводок и консоли
//   units(st, chars)                  — колонки таблицы: [{ key, icon, label, short? }]
//   validate(st)                      — null или текст ошибки
//   planRows(st, chars)               — { skipped, jobs, total, ctx? }; job = { ch, unit, … }
//   makeRow(job, { dry, ctx })        — строка результата
//   chips(rows, dry)                  — чипы итогов
//   summaryLine(rows, dry, stopped)   — итог одной строкой
//   confirmText(st, chars, plan)      — текст предупреждения перед запуском
//   consolePlaceholder, consoleExample, consoleHelp, consoleFlags(flags, st)
//
// Данные фейковые: персонажи вымышлены, ничего не уходит на сайт игры.

import { toast, confirmModal } from '../js/core/ui.js';
import { escapeHtml } from '../js/core/utils.js';
import { noteHtml, sectionHtml, progressHtml, setProgress, chipsHtml } from '../js/modules/automation/scriptUi.js';
import { openOverlay } from '../js/modules/marathons/overlay.js';
import {
  CHARS,
  PARTIES,
  pick,
  byNick,
  dot,
  hhmmss,
  el,
  statusMeta,
  rowOf,
  runPlan,
  gridTableHtml,
  gridCellHtml,
  byKeyOfRows,
  eventLineHtml,
  defaultTarget,
  targetChars,
  targetHtml,
  targetListsHtml,
  bindTarget,
  rerunCharsOfRows
} from './lab-data.js';

/** Статусы, которые «Повторить ошибки» и итоги считают проблемами. */
const PROBLEM = ['error', 'challenge', 'not_logged_in'];
const countOf = (rows, ...statuses) => rows.filter(r => statuses.includes(r.status)).length;

/* ============================================================================ */
/* Сценарий «Передача предметов»                                                */
/* ============================================================================ */

const TYPES = [
  { key: 'weapon', icon: '⚔️', label: 'Оружие' },
  { key: 'armor', icon: '🛡', label: 'Доспех' },
  { key: 'pot', icon: '🧪', label: 'Расходники' },
  { key: 'mat', icon: '📦', label: 'Материалы' },
  { key: 'gem', icon: '💎', label: 'Драгоценности' }
];

/** Стабильный «запас» в хранилище: у каждого персонажа и типа свой, от 0 до 11 предметов. */
const hashOf = (a, b) => {
  const s = `${a}|${b}`;
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};
const stock = (charId, typeKey) => hashOf(charId, typeKey) % 12;
const typeByKey = k => TYPES.find(t => t.key === k);

const TRANSFER = {
  id: 'transfer',
  icon: '📦',
  title: 'Передача предметов',
  titleShort: 'Передача',
  cmd: 'transfer',
  howItWorks:
    'Приложение откроет страницу передачи у каждого выбранного персонажа и перенесёт отмеченные типы предметов из хранилища сайта в игру. Лимит сайта «не более 6 предметов за раз» обходит: передаёт партиями. Пробный запуск только считает предметы — ничего не передаёт.',
  paramTitle: 'Какие предметы передавать',
  consolePlaceholder: 'transfer --types=weapon,mat --target=logged --dry',
  consoleExample: 'transfer --types=weapon,armor --target=logged',
  consoleHelp: [
    'transfer [--types=…] [--target=…] [--dry] — передача предметов из хранилища сайта в игру',
    '  --types=weapon,armor,pot,mat,gem или --types=all (по умолчанию всё, кроме драгоценностей)',
    '  --target=all | logged | none | party:ИМЯ | ник1+ник2 (по умолчанию all)',
    '  --dry — пробный запуск: посчитать предметы, ничего не передавать'
  ],
  defaultState: () => ({ types: new Set(['weapon', 'armor', 'pot', 'mat']) }),
  paramForm(st) {
    return `<div class="sc-types">${TYPES.map(t => {
      const n = CHARS.filter(c => stock(c.id, t.key) > 0).length;
      return `<label class="sc-type"><input type="checkbox" data-ptype="${t.key}" ${
        st.types.has(t.key) ? 'checked' : ''
      }>
        <span>${t.icon} ${t.label}</span><small>есть у ${n} из ${CHARS.length}</small></label>`;
    }).join('')}</div>
    <p class="promo-muted">Лимит сайта — «не более 6 предметов за раз»: длинные списки приложение передаст партиями и отметит такие строки «частично».</p>`;
  },
  bindParams(root, st, onChange) {
    if (root.dataset.scTransfer) return;
    root.dataset.scTransfer = 'true';
    root.addEventListener('change', e => {
      const box = e.target.closest?.('[data-ptype]');
      if (!box) return;
      if (box.checked) st.types.add(box.dataset.ptype);
      else st.types.delete(box.dataset.ptype);
      onChange?.();
    });
  },
  paramsLine: st =>
    TYPES.filter(t => st.types.has(t.key))
      .map(t => `${t.icon} ${t.label}`)
      .join(', ') || 'типы не выбраны',
  units: st => TYPES.filter(t => st.types.has(t.key)).map(t => ({ key: t.key, icon: t.icon, label: t.label })),
  validate: st => (st.types.size ? null : 'Отметьте хотя бы один тип предметов'),
  planRows(st, chars) {
    const skipped = [];
    const jobs = [];
    for (const ch of chars) {
      for (const unit of TRANSFER.units(st)) {
        const n = stock(ch.id, unit.key);
        if (n === 0) {
          skipped.push({
            ...rowOf(ch, unit.key, 'empty', 'в хранилище нет предметов этого типа', { short: 'нет' }),
            unit
          });
        } else {
          jobs.push({ ch, unit, n });
        }
      }
    }
    return { skipped, jobs, total: skipped.length + jobs.length };
  },
  makeRow({ ch, unit, n }, { dry }) {
    if (ch.isLoggedIn === false) {
      const r = Math.random();
      if (r < 0.5) return rowOf(ch, unit.key, 'not_logged_in', 'нет входа на сайт — сначала войдите на сайт игры');
      if (r < 0.75) return rowOf(ch, unit.key, 'challenge', 'сайт показал проверку безопасности — передачу остановили');
      return rowOf(ch, unit.key, 'error', null, { error: 'timeout' });
    }
    if (dry) {
      return rowOf(ch, unit.key, 'dry_run', `в хранилище ${n} предмет(ов) — считаем, не передаём`, {
        short: `${n} 👁`,
        n
      });
    }
    const r = Math.random();
    if (r < 0.7) {
      if (n > 6 && Math.random() < 0.5) {
        return rowOf(ch, unit.key, 'partial', `лимит «не более 6 за раз»: передано 6, осталось ${n - 6}`, {
          short: `6 из ${n}`,
          n,
          sent: 6
        });
      }
      return rowOf(ch, unit.key, 'ok', `передано ${n} предмет(ов)`, { short: `+${n}`, n, sent: n });
    }
    if (r < 0.82) return rowOf(ch, unit.key, 'already', 'предметы уже в игре — передавать нечего', { short: 'уже' });
    if (r < 0.92) return rowOf(ch, unit.key, 'challenge', 'сайт показал проверку безопасности — передачу остановили');
    return rowOf(ch, unit.key, 'error', null, { error: 'timeout' });
  },
  chips(rows, dry) {
    if (dry) {
      return chipsHtml([
        { icon: '👁', label: 'Найдено передач', value: countOf(rows, 'dry_run'), tone: 'info' },
        { icon: '🧮', label: 'Предметов в хранилище', value: rows.reduce((a, r) => a + (r.n || 0), 0) },
        { icon: '📭', label: 'Пусто', value: countOf(rows, 'empty') },
        { icon: '❌', label: 'Проблем', value: countOf(rows, ...PROBLEM), tone: 'warn' }
      ]);
    }
    const sent = rows.reduce((a, r) => a + (r.sent || 0), 0);
    return chipsHtml([
      { icon: '📦', label: 'Передано предметов', value: sent, tone: 'ok', zero: true },
      { icon: '✅', label: 'Готово передач', value: countOf(rows, 'ok'), tone: 'ok' },
      { icon: '⚠️', label: 'Частично (лимит 6)', value: countOf(rows, 'partial'), tone: 'warn' },
      { icon: '♻️', label: 'Уже в игре', value: countOf(rows, 'already') },
      { icon: '📭', label: 'Пусто', value: countOf(rows, 'empty') },
      { icon: '❌', label: 'Проблем', value: countOf(rows, ...PROBLEM), tone: 'error' },
      { icon: '⏹', label: 'Не выполнено', value: countOf(rows, 'cancelled') }
    ]);
  },
  summaryLine(rows, dry, stopped) {
    const sent = rows.reduce((a, r) => a + (r.sent || 0), 0);
    const bad = countOf(rows, ...PROBLEM);
    if (dry) {
      return stopped
        ? `Пробный запуск остановлен: успели посчитать ${countOf(rows, 'dry_run')} передач.`
        : `Найдено ${countOf(rows, 'dry_run')} передач, ${sent} предмет(ов). Ничего не передано.`;
    }
    if (stopped) return `Остановлено: передано ${sent} предмет(ов), не выполнено ${countOf(rows, 'cancelled')}.`;
    return `Передано ${sent} предмет(ов): готово ${countOf(rows, 'ok')}${
      countOf(rows, 'partial') ? `, частично ${countOf(rows, 'partial')}` : ''
    }${bad ? `, проблем ${bad}` : ''}.`;
  },
  confirmText(st, chars, plan) {
    return `Персонажей: ${chars.length}, типов предметов: ${st.types.size}. Передач: ${plan.jobs.length}${
      plan.skipped.length ? ` (ещё ${plan.skipped.length} пропустим — в хранилище пусто)` : ''
    }. Предметы уйдут из хранилища сайта в игру — вернуть их назад нельзя.`;
  },
  consoleFlags(flags, st) {
    const f = flags.find(a => a.startsWith('--types='));
    if (!f) return null;
    const value = f.slice('--types='.length).trim();
    if (value === 'all') {
      TYPES.forEach(t => st.types.add(t.key));
      return null;
    }
    const keys = value.split(/[,\s]+/).filter(Boolean);
    const known = keys.map(k => typeByKey(k)).filter(Boolean);
    if (!known.length) {
      return `Не знаю таких типов: ${keys.join(', ')}. Доступны: ${TYPES.map(t => t.key).join(', ')} или all.`;
    }
    st.types = new Set(known.map(t => t.key));
    return null;
  }
};

/* ============================================================================ */
/* Сценарий «Подарки» (магазин за монеты)                                       */
/* ============================================================================ */

const GIFTS = [
  { key: 'strength', icon: '🎁', label: 'Подарок «Сила»', short: 'Сила', price: 100 },
  { key: 'crystal', icon: '💎', label: 'Кристалл заточки', short: 'Кристалл', price: 250 },
  { key: 'scroll', icon: '📜', label: 'Свиток опыта', short: 'Свиток', price: 400 },
  { key: 'luck', icon: '🍀', label: 'Талисман удачи', short: 'Удача', price: 50 }
];

/** Демо-баланс монет: у всех разный — у кого-то на подарки не хватит. */
const COINS = { c1: 1250, c2: 480, c3: 90, c4: 2300, c5: 15, c6: 640, c7: 300, c8: 1780 };
const giftByKey = k => GIFTS.find(g => g.key === k);

const SHOP = {
  id: 'shop',
  icon: '🪙',
  title: 'Подарки за монеты',
  titleShort: 'Подарки',
  cmd: 'shop',
  howItWorks:
    'Приложение откроет магазин у каждого выбранного персонажа и купит отмеченные подарки за его монеты. Баланс у всех разный: у кого монет не хватает, тот получит строку «не хватает» — остальные подарки у него всё равно купятся. Пробный запуск только считает цены — покупки не делает.',
  paramTitle: 'Какие подарки покупать',
  consolePlaceholder: 'shop --gifts=strength,luck --target=logged --dry',
  consoleExample: 'shop --gifts=luck --target=party:Альфа',
  consoleHelp: [
    'shop [--gifts=…] [--target=…] [--dry] — покупка подарков за монеты персонажа',
    '  --gifts=strength,crystal,scroll,luck или --gifts=all (по умолчанию «Сила» и «Удача»)',
    '  --target=all | logged | none | party:ИМЯ | ник1+ник2 (по умолчанию all)',
    '  --dry — пробный запуск: посчитать цены, ничего не покупать'
  ],
  defaultState: () => ({ gifts: new Set(['strength', 'luck']) }),
  paramForm(st) {
    return `<div class="sc-gifts">${GIFTS.map(
      g => `<label class="sc-gift"><input type="checkbox" data-gift="${g.key}" ${st.gifts.has(g.key) ? 'checked' : ''}>
        <span class="sc-gift-ico" aria-hidden="true">${g.icon}</span>
        <span class="sc-gift-name">${g.label}</span>
        <b class="sc-gift-price">${g.price} 🪙</b></label>`
    ).join('')}</div>
    <p class="promo-muted">Монеты списываются с баланса каждого персонажа отдельно и безвозвратно. Пробный запуск покупки не делает.</p>`;
  },
  bindParams(root, st, onChange) {
    if (root.dataset.scShop) return;
    root.dataset.scShop = 'true';
    root.addEventListener('change', e => {
      const box = e.target.closest?.('[data-gift]');
      if (!box) return;
      if (box.checked) st.gifts.add(box.dataset.gift);
      else st.gifts.delete(box.dataset.gift);
      onChange?.();
    });
  },
  paramsLine: st =>
    GIFTS.filter(g => st.gifts.has(g.key))
      .map(g => `${g.icon} ${g.label}`)
      .join(', ') || 'подарки не выбраны',
  units: st =>
    GIFTS.filter(g => st.gifts.has(g.key)).map(g => ({ key: g.key, icon: g.icon, label: g.label, short: g.short })),
  validate: st => (st.gifts.size ? null : 'Выберите хотя бы один подарок'),
  planRows(st, chars) {
    const units = SHOP.units(st);
    const cheapest = Math.min(...units.map(u => giftByKey(u.key).price));
    const ctx = { balances: { ...COINS } };
    const skipped = [];
    const jobs = [];
    for (const ch of chars) {
      const bal = ctx.balances[ch.id] ?? 0;
      if (bal < cheapest) {
        for (const unit of units) {
          skipped.push({
            ...rowOf(ch, unit.key, 'poor', `на балансе ${bal} 🪙 — не хватит ни на один выбранный подарок`, {
              short: `${bal}🪙`
            }),
            unit
          });
        }
      } else {
        for (const unit of units) jobs.push({ ch, unit });
      }
    }
    return { skipped, jobs, total: skipped.length + jobs.length, ctx };
  },
  makeRow({ ch, unit }, { dry, ctx }) {
    const g = giftByKey(unit.key);
    const bal = ctx.balances[ch.id] ?? 0;
    if (bal < g.price) {
      return rowOf(ch, unit.key, 'poor', `нужно ${g.price} 🪙, на балансе ${bal}`, { short: `${bal}/${g.price}` });
    }
    if (dry) {
      return rowOf(ch, unit.key, 'dry_run', `купится за ${g.price} 🪙 (баланс ${bal}) — покупку не делаем`, {
        short: `${g.price} 👁`,
        price: g.price
      });
    }
    const r = Math.random();
    if (r < 0.78) {
      ctx.balances[ch.id] = bal - g.price;
      return rowOf(ch, unit.key, 'ok', `куплено за ${g.price} 🪙, остаток ${bal - g.price}`, {
        short: `−${g.price}`,
        spent: g.price
      });
    }
    if (r < 0.86) return rowOf(ch, unit.key, 'already', 'такой подарок уже активен', { short: 'уже' });
    if (r < 0.93) return rowOf(ch, unit.key, 'challenge', 'сайт показал проверку безопасности');
    return rowOf(ch, unit.key, 'error', null, { error: 'timeout' });
  },
  chips(rows, dry) {
    if (dry) {
      return chipsHtml([
        { icon: '👁', label: 'Купится покупок', value: countOf(rows, 'dry_run'), tone: 'info' },
        { icon: '🪙', label: 'Сумма покупок', value: rows.reduce((a, r) => a + (r.price || 0), 0) },
        { icon: '🪙', label: 'Не хватит монет', value: countOf(rows, 'poor'), tone: 'warn' },
        { icon: '❌', label: 'Проблем', value: countOf(rows, ...PROBLEM), tone: 'warn' }
      ]);
    }
    return chipsHtml([
      {
        icon: '🪙',
        label: 'Потрачено монет',
        value: rows.reduce((a, r) => a + (r.spent || 0), 0),
        tone: 'ok',
        zero: true
      },
      { icon: '✅', label: 'Куплено', value: countOf(rows, 'ok'), tone: 'ok' },
      { icon: '♻️', label: 'Уже активен', value: countOf(rows, 'already') },
      { icon: '🪙', label: 'Не хватило', value: countOf(rows, 'poor'), tone: 'warn' },
      { icon: '❌', label: 'Проблем', value: countOf(rows, ...PROBLEM), tone: 'error' },
      { icon: '⏹', label: 'Не выполнено', value: countOf(rows, 'cancelled') }
    ]);
  },
  summaryLine(rows, dry, stopped) {
    const spent = rows.reduce((a, r) => a + (r.spent || 0), 0);
    const bad = countOf(rows, ...PROBLEM);
    if (dry) {
      return stopped
        ? `Пробный запуск остановлен: насчитали ${countOf(rows, 'dry_run')} покупок.`
        : `Насчитали ${countOf(rows, 'dry_run')} покупок на ${rows.reduce((a, r) => a + (r.price || 0), 0)} 🪙 — ничего не куплено.`;
    }
    if (stopped) return `Остановлено: потрачено ${spent} 🪙, не выполнено ${countOf(rows, 'cancelled')}.`;
    return `Куплено ${countOf(rows, 'ok')} подарков, потрачено ${spent} 🪙${
      countOf(rows, 'poor') ? `, не хватило у ${countOf(rows, 'poor')}` : ''
    }${bad ? `, проблем ${bad}` : ''}.`;
  },
  confirmText(st, chars, plan) {
    const max = plan.jobs.reduce((a, j) => a + giftByKey(j.unit.key).price, 0);
    return `Будут куплены: ${SHOP.paramsLine(st)}. Персонажей: ${chars.length}, покупок: ${plan.jobs.length}, до ${max} 🪙 суммарно. Монеты списываются безвозвратно.`;
  },
  consoleFlags(flags, st) {
    const f = flags.find(a => a.startsWith('--gifts='));
    if (!f) return null;
    const value = f.slice('--gifts='.length).trim();
    if (value === 'all') {
      GIFTS.forEach(g => st.gifts.add(g.key));
      return null;
    }
    const keys = value.split(/[,\s]+/).filter(Boolean);
    const known = keys.map(k => giftByKey(k)).filter(Boolean);
    if (!known.length) {
      return `Не знаю таких подарков: ${keys.join(', ')}. Доступны: ${GIFTS.map(g => g.key).join(', ')} или all.`;
    }
    st.gifts = new Set(known.map(g => g.key));
    return null;
  }
};

/* ============================================================================ */
/* Сценарий «Сундук караванщика»                                                */
/* ============================================================================ */

/** Демо-запас сундуков у каждого персонажа. */
const CHESTS = { c1: 4, c2: 7, c3: 2, c4: 5, c5: 1, c6: 9, c7: 3, c8: 6 };
const LOOT = [
  { icon: '🪙', text: 'Древние монеты ×500' },
  { icon: '☄️', text: 'Метеорит ×100' },
  { icon: '📜', text: 'Свиток опыта ×3' },
  { icon: '💠', text: 'Кристалл заточки ×1' },
  { icon: '🏅', text: 'Знак отличия ×2' },
  null // пустой сундук
];
const RARE = ['Крылья ветра 🪽', 'Корона караванщика 👑', 'Печать древних 🏺'];

const CARAVAN = {
  id: 'caravan',
  icon: '🧰',
  title: 'Сундук караванщика',
  titleShort: 'Сундук',
  cmd: 'caravan',
  howItWorks:
    'Приложение откроет сундуки караванщика в инвентаре каждого выбранного персонажа и заберет содержимое. Сколько сундуков открыть — выбираете вы (0 — открыть все). У кого сундуки кончились, те клетки будут пропущены. Пробный запуск только показывает, сколько сундуков открылось бы.',
  paramTitle: 'Сколько сундуков открыть',
  consolePlaceholder: 'caravan --count=3 --target=all --dry',
  consoleExample: 'caravan --count=2 --target=logged',
  consoleHelp: [
    'caravan [--count=N] [--target=…] [--dry] — открыть сундуки караванщика и забрать содержимое',
    '  --count=0…9 — сколько сундуков открыть у каждого; 0 — открыть все (по умолчанию 3)',
    '  --target=all | logged | none | party:ИМЯ | ник1+ник2 (по умолчанию all)',
    '  --dry — пробный запуск: показать, что открылось бы, ничего не нажимать'
  ],
  defaultState: () => ({ count: 3 }),
  paramForm(st) {
    return `<input class="input sc-count-input" type="number" min="0" max="9" value="${st.count}" data-carn aria-label="Сколько сундуков открыть у каждого">
    <p class="promo-muted">0 — открыть все. В демо запас у каждого свой: от 1 до 9 сундуков. У кого сундуки кончились — те клетки будут пропущены.</p>`;
  },
  bindParams(root, st, onChange) {
    if (root.dataset.scCaravan) return;
    root.dataset.scCaravan = 'true';
    root.addEventListener('input', e => {
      const input = e.target.closest?.('[data-carn]');
      if (!input) return;
      const v = Number.parseInt(input.value, 10);
      st.count = Number.isFinite(v) ? Math.min(9, Math.max(0, v)) : 0;
      onChange?.();
    });
  },
  paramsLine: st => (st.count > 0 ? `по ${st.count} сундука(ов) у каждого` : 'все сундуки до единого'),
  units(st, chars) {
    const maxHave = Math.max(1, ...chars.map(c => CHESTS[c.id] ?? 0));
    const n = st.count > 0 ? Math.min(st.count, maxHave) : maxHave;
    return Array.from({ length: n }, (_, i) => ({
      key: String(i + 1),
      icon: '🧰',
      label: `Сундук ${i + 1}`,
      short: String(i + 1)
    }));
  },
  validate: () => null,
  planRows(st, chars) {
    const skipped = [];
    const jobs = [];
    for (const ch of chars) {
      const have = CHESTS[ch.id] ?? 0;
      const need = st.count > 0 ? Math.min(st.count, have) : have;
      for (const unit of CARAVAN.units(st, chars)) {
        const no = Number(unit.key);
        if (no <= need) jobs.push({ ch, unit, chestNo: no, have });
        else {
          skipped.push({
            ...rowOf(ch, unit.key, 'skip', `сундуков всего ${have} — дальше открывать нечего`, { short: '—' }),
            unit
          });
        }
      }
    }
    return { skipped, jobs, total: skipped.length + jobs.length };
  },
  makeRow({ ch, unit, chestNo, have }, { dry }) {
    if (ch.isLoggedIn === false) {
      const r = Math.random();
      if (r < 0.5) return rowOf(ch, unit.key, 'not_logged_in', 'нет входа на сайт — сначала войдите на сайт игры');
      if (r < 0.75) return rowOf(ch, unit.key, 'challenge', 'сайт показал проверку безопасности');
      return rowOf(ch, unit.key, 'error', null, { error: 'timeout' });
    }
    if (dry) {
      return rowOf(ch, unit.key, 'dry_run', `сундук ${chestNo} из ${have}: открылся бы — не нажимаем`, {
        short: `${chestNo} 👁`
      });
    }
    const r = Math.random();
    if (r < 0.05) {
      const rare = pick(RARE);
      return rowOf(ch, unit.key, 'rare', `редкая находка: ${rare}`, { short: rare.split(' ')[0] });
    }
    if (r < 0.8) {
      const l = pick(LOOT);
      return l
        ? rowOf(ch, unit.key, 'ok', `выпало: ${l.text}`, { short: l.icon })
        : rowOf(ch, unit.key, 'empty', 'сундук оказался пуст', { short: '—' });
    }
    if (r < 0.9) return rowOf(ch, unit.key, 'challenge', 'сайт показал проверку безопасности');
    return rowOf(ch, unit.key, 'error', null, { error: 'timeout' });
  },
  chips(rows, dry) {
    const opened = countOf(rows, 'ok', 'rare', 'empty');
    if (dry) {
      return chipsHtml([
        { icon: '👁', label: 'Открылось бы', value: countOf(rows, 'dry_run'), tone: 'info' },
        { icon: '⏭', label: 'Пропустим', value: countOf(rows, 'skip') },
        { icon: '❌', label: 'Проблем', value: countOf(rows, ...PROBLEM), tone: 'warn' }
      ]);
    }
    return chipsHtml([
      { icon: '🧰', label: 'Открыто сундуков', value: opened, tone: 'ok', zero: true },
      { icon: '💎', label: 'Редких находок', value: countOf(rows, 'rare'), tone: 'ok' },
      { icon: '🎁', label: 'С добычей', value: countOf(rows, 'ok') },
      { icon: '📭', label: 'Пустых', value: countOf(rows, 'empty') },
      { icon: '⏭', label: 'Пропущено', value: countOf(rows, 'skip') },
      { icon: '❌', label: 'Проблем', value: countOf(rows, ...PROBLEM), tone: 'error' },
      { icon: '⏹', label: 'Не выполнено', value: countOf(rows, 'cancelled') }
    ]);
  },
  summaryLine(rows, dry, stopped) {
    const opened = countOf(rows, 'ok', 'rare', 'empty');
    const rare = countOf(rows, 'rare');
    const bad = countOf(rows, ...PROBLEM);
    if (dry) {
      return stopped
        ? `Пробный запуск остановлен: насчитали ${countOf(rows, 'dry_run')} открытий.`
        : `Открылось бы ${countOf(rows, 'dry_run')} сундуков — ничего не нажато.`;
    }
    if (stopped) return `Остановлено: открыто ${opened}, не выполнено ${countOf(rows, 'cancelled')}.`;
    return `Открыто ${opened} сундуков${rare ? `, редких находок ${rare}` : ''}${bad ? `, проблем ${bad}` : ''}.`;
  },
  confirmText(st, chars, plan) {
    return `У ${chars.length} персонажей откроется ${plan.jobs.length} сундуков${
      plan.skipped.length ? ` (ещё ${plan.skipped.length} пропустим — сундуки кончились)` : ''
    }. Содержимое сразу заберёт игра — отменить открытие нельзя.`;
  },
  consoleFlags(flags, st) {
    const f = flags.find(a => a.startsWith('--count='));
    if (!f) return null;
    const v = Number.parseInt(f.slice('--count='.length), 10);
    if (!Number.isFinite(v) || v < 0 || v > 9) return '--count принимает число от 0 до 9 (0 — открыть все).';
    st.count = v;
    return null;
  }
};

export const SCENARIOS = { transfer: TRANSFER, shop: SHOP, caravan: CARAVAN };
export const SCENARIO_LIST = [TRANSFER, SHOP, CARAVAN];

/* ============================================================================ */
/* Общие мелочи оболочек                                                        */
/* ============================================================================ */

/** Карта «плановых» строк: skipped уже имеют статус, будущие — «в плане». */
function plannedKeyMap(plan) {
  return byKeyOfRows([
    ...plan.skipped,
    ...plan.jobs.map(j => ({ charId: j.ch.id, unitKey: j.unit.key, planned: true }))
  ]);
}

function liveTable(sc, st, chars, byKey) {
  return gridTableHtml(sc.units(st, chars), chars, byKey, gridCellHtml);
}

function cssEscape(value) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
}

/** Обновить одну ячейку таблицы хода работы. */
function updateCell(dlg, row) {
  const td = dlg.body.querySelector(`[data-cell="${cssEscape(`${row.charId}|${row.unitKey}`)}"]`);
  if (td) td.innerHTML = gridCellHtml(row);
}

/** Проверки перед запуском; возвращает { chars, plan } или null (с тостом). */
function prepRun(sc, st, t) {
  const err = sc.validate(st);
  if (err) {
    toast(err, 'warning');
    return null;
  }
  const chars = targetChars(t);
  if (!chars.length) {
    toast('Под фильтр «кого запускать» никто не подошёл', 'warning');
    return null;
  }
  const plan = sc.planRows(st, chars);
  if (!plan.jobs.length) {
    toast('Запускать нечего — все строки пропущены', 'info');
    return null;
  }
  return { chars, plan };
}

async function confirmRun(sc, st, chars, plan) {
  return confirmModal({
    title: `${sc.icon} Запустить «${sc.title}»?`,
    text: sc.confirmText(st, chars, plan),
    okText: `Запустить (${plan.jobs.length})`,
    danger: true
  });
}

/* ============================================================================ */
/* Вариант 0 · Текущий диалог: форма → подтверждение → ход → итог               */
/* ============================================================================ */

function openGenericCurrent(sc) {
  const st = sc.defaultState();
  const t = defaultTarget();
  let running = null;
  let last = null;

  const dlg = openOverlay({
    title: `${sc.icon} ${sc.title}`,
    wide: true,
    onClose: () => {
      if (running) running.cancelled = true;
    }
  });
  dlg.foot.classList.add('sd-foot');
  const alive = () => dlg.el.isConnected;

  function renderForm() {
    dlg.sub.textContent = sc.howItWorks;
    dlg.body.innerHTML = `
      ${noteHtml({ icon: sc.icon, title: 'Что сделает этот скрипт', text: escapeHtml(sc.howItWorks) })}
      ${sectionHtml(sc.paramTitle, { step: '1', body: sc.paramForm(st) })}
      ${sectionHtml('Кого запускать', {
        step: '2',
        aside: '<span data-gcount></span>',
        body: targetHtml(t, 'cur')
      })}`;
    sc.bindParams(dlg.body, st, refreshCount);
    bindTarget(dlg.body, t, 'cur', refreshCount);
    refreshCount();
    dlg.foot.innerHTML = `
      <span class="promo-muted">Пробный запуск ничего не нажимает и не сохраняет.</span>
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="close">✕ Закрыть</button>
      <button class="btn secondary" data-act="dry">👁 Пробный запуск</button>
      <button class="btn primary" data-act="start">▶ Запустить</button>`;
  }

  function refreshCount() {
    const chars = targetChars(t);
    const plan = sc.planRows(st, chars);
    const c = dlg.body.querySelector('[data-gcount]');
    if (c) c.textContent = `Персонажей: ${chars.length} · в работу: ${plan.jobs.length}`;
  }

  function renderRunning(chars, plan, dry) {
    dlg.body.innerHTML = `
      ${progressHtml('gcur', plan.skipped.length, plan.total)}
      ${liveTable(sc, st, chars, plannedKeyMap(plan))}`;
    dlg.foot.innerHTML = `
      <span class="promo-muted">${
        dry
          ? 'Пробный запуск: только считаем, ничего не нажимаем.'
          : '«Стоп» не начинает новых действий; уже начатые завершатся.'
      }</span>
      <span class="sd-foot-spacer"></span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
  }

  function renderResults() {
    const { rows, chars, dry, stopped } = last;
    dlg.body.innerHTML = `
      ${sc.chips(rows, dry)}
      ${liveTable(sc, st, chars, byKeyOfRows(rows))}
      <p class="muted">${escapeHtml(sc.summaryLine(rows, dry, stopped))}</p>`;
    const rerun = dry ? [] : rerunCharsOfRows(rows);
    dlg.foot.innerHTML = `
      <span class="promo-muted">${stopped ? 'Остановлено вручную.' : dry ? 'Ничего не нажато и не сохранено.' : 'Готово.'}</span>
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="form">← К настройке</button>
      ${rerun.length ? `<button class="btn secondary" data-act="retry">🔁 Повторить ошибки (${rerun.length})</button>` : ''}
      <button class="btn ghost" data-act="close">Закрыть</button>`;
  }

  async function start(dry) {
    const prep = prepRun(sc, st, t);
    if (!prep) return;
    const { chars, plan } = prep;
    if (!dry && !(await confirmRun(sc, st, chars, plan))) return;
    renderRunning(chars, plan, dry);
    const signal = { cancelled: false };
    running = signal;
    const rows = await runPlan(plan, sc.makeRow, {
      dry,
      signal,
      onRow: (row, done, total) => {
        if (!alive()) return;
        updateCell(dlg, row);
        setProgress(dlg.body, 'gcur', done, total);
      }
    });
    running = null;
    if (!alive()) return;
    last = { rows, chars, dry, stopped: signal.cancelled };
    renderResults();
    toast(
      `${sc.icon} ${sc.titleShort}: ${sc.summaryLine(rows, dry, signal.cancelled)}`,
      signal.cancelled || countOf(rows, ...PROBLEM) ? 'warning' : 'success',
      4200
    );
  }

  dlg.foot.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act) return;
    if (act === 'close') return dlg.close();
    if (act === 'form') return renderForm();
    if (act === 'stop') {
      if (running) running.cancelled = true;
      btn.disabled = true;
      btn.textContent = '⏳ Останавливаю…';
      return;
    }
    if (act === 'dry' || act === 'start') return start(act === 'dry');
    if (act === 'retry' && last) {
      const chars = rerunCharsOfRows(last.rows);
      if (!chars.length) return toast('Повторять нечего', 'info');
      t.mode = 'manual';
      t.chars = new Set(chars.map(c => c.id));
      renderForm();
      return start(false);
    }
  });

  renderForm();
  return dlg;
}

/* ============================================================================ */
/* Вариант A · Мастер шагов: параметры → кого → проверка → выполнение           */
/* ============================================================================ */

function openGenericWizard(sc) {
  const st = sc.defaultState();
  const t = defaultTarget();
  let step = 1; // 1 параметры | 2 кого запускать | 3 проверка
  let phase = 'form'; // form | run | result
  let running = null;
  let last = null;

  const dlg = openOverlay({
    title: `${sc.icon} ${sc.title}`,
    wide: true,
    onClose: () => {
      if (running) running.cancelled = true;
    }
  });
  dlg.foot.classList.add('sd-foot');
  const alive = () => dlg.el.isConnected;
  const STEPS = ['Параметры', 'Кого запускать', 'Проверка', 'Выполнение'];

  function stepperHtml() {
    const active = phase === 'form' ? step : 4;
    const n = phase === 'result' ? 5 : active; // в результате все шаги «✓»
    const visible = phase === 'form' ? 3 : 4;
    return `<ol class="wz-steps">${STEPS.slice(0, visible)
      .map((label, i) => {
        const idx = i + 1;
        const done = idx < n;
        const cls = done ? 'is-done' : idx === n ? 'is-active' : '';
        const clickable = phase === 'form' && idx <= 3 ? `data-goto="${idx}"` : '';
        return `<li class="wz-step ${cls}" ${clickable}><span class="wz-step-n">${done ? '✓' : idx}</span><span>${label}</span></li>`;
      })
      .join('')}</ol>`;
  }

  function paneHtml() {
    if (step === 1) {
      return `<div class="wz-pane">${sectionHtml(sc.paramTitle, {
        hint: 'Шаг 1 из 3',
        body: sc.paramForm(st)
      })}</div>`;
    }
    if (step === 2) {
      return `<div class="wz-pane">${sectionHtml('Кого запускать', {
        aside: '<span data-gcount></span>',
        body: targetHtml(t, 'wz')
      })}</div>`;
    }
    const chars = targetChars(t);
    const plan = sc.planRows(st, chars);
    return `<div class="wz-pane">
      <div class="wz-review">
        <div class="wz-review-row"><span>Сценарий</span><span>${sc.icon} ${escapeHtml(sc.title)}</span></div>
        <div class="wz-review-row"><span>Параметры</span><span>${escapeHtml(sc.paramsLine(st))}</span></div>
        <div class="wz-review-row"><span>Персонажей</span><b>${chars.length}</b></div>
        <div class="wz-review-row wz-review-big"><span>Действий</span><b>${plan.jobs.length}</b></div>
        <div class="wz-review-row"><span>Пропустим</span><b>${plan.skipped.length}</b></div>
      </div>
      <div class="wz-nicks">${chars.map(c => `<span class="wz-nick">${dot(c)} ${escapeHtml(c.nick)}</span>`).join('')}</div>
    </div>`;
  }

  function renderForm() {
    phase = 'form';
    dlg.sub.textContent = `Шаг ${step} из 3 — ${STEPS[step - 1]}. Данные демо: ничего не уходит на сайт игры.`;
    dlg.body.innerHTML = `${stepperHtml()}${paneHtml()}`;
    sc.bindParams(dlg.body, st, refreshCount);
    bindTarget(dlg.body, t, 'wz', refreshCount);
    refreshCount();
    dlg.foot.innerHTML = `
      <span class="sd-foot-spacer"></span>
      ${
        step > 1
          ? '<button class="btn ghost" data-act="back">← Назад</button>'
          : '<button class="btn ghost" data-act="close">✕ Закрыть</button>'
      }
      ${
        step < 3
          ? '<button class="btn primary" data-act="next">Далее →</button>'
          : '<button class="btn secondary" data-act="dry">👁 Пробный запуск</button><button class="btn primary" data-act="start">▶ Запустить</button>'
      }`;
  }

  function refreshCount() {
    if (step !== 2 || phase !== 'form') return;
    const chars = targetChars(t);
    const plan = sc.planRows(st, chars);
    const c = dlg.body.querySelector('[data-gcount]');
    if (c) c.textContent = `Персонажей: ${chars.length} · в работу: ${plan.jobs.length}`;
  }

  function renderRunning(chars, plan, dry) {
    phase = 'run';
    dlg.sub.textContent = dry
      ? 'Пробный запуск: считаем, ничего не нажимаем.'
      : 'Идёт выполнение… «Стоп» не начинает новых действий.';
    dlg.body.innerHTML = `${stepperHtml()}${progressHtml('gwz', plan.skipped.length, plan.total)}${liveTable(
      sc,
      st,
      chars,
      plannedKeyMap(plan)
    )}`;
    dlg.foot.innerHTML = `<span class="sd-foot-spacer"></span><button class="btn danger" data-act="stop">⏹ Стоп</button>`;
  }

  function renderResults() {
    phase = 'result';
    const { rows, chars, dry, stopped } = last;
    dlg.sub.textContent = stopped
      ? 'Остановлено вручную.'
      : dry
        ? 'Пробный запуск завершён — ничего не нажато.'
        : 'Готово.';
    dlg.body.innerHTML = `${stepperHtml()}${sc.chips(rows, dry)}${liveTable(sc, st, chars, byKeyOfRows(rows))}
      <p class="muted">${escapeHtml(sc.summaryLine(rows, dry, stopped))}</p>`;
    const rerun = dry ? [] : rerunCharsOfRows(rows);
    dlg.foot.innerHTML = `
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="form">← К настройке</button>
      ${rerun.length ? `<button class="btn secondary" data-act="retry">🔁 Повторить ошибки (${rerun.length})</button>` : ''}
      <button class="btn ghost" data-act="close">Закрыть</button>`;
  }

  async function start(dry) {
    const prep = prepRun(sc, st, t);
    if (!prep) return;
    const { chars, plan } = prep;
    if (!dry && !(await confirmRun(sc, st, chars, plan))) return;
    renderRunning(chars, plan, dry);
    const signal = { cancelled: false };
    running = signal;
    const rows = await runPlan(plan, sc.makeRow, {
      dry,
      signal,
      onRow: (row, done, total) => {
        if (!alive()) return;
        updateCell(dlg, row);
        setProgress(dlg.body, 'gwz', done, total);
      }
    });
    running = null;
    if (!alive()) return;
    last = { rows, chars, dry, stopped: signal.cancelled };
    renderResults();
  }

  dlg.body.addEventListener('click', e => {
    const goto = e.target.closest('[data-goto]')?.dataset.goto;
    if (!goto || phase !== 'form') return;
    step = Number(goto);
    renderForm();
  });

  dlg.foot.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act) return;
    if (act === 'close') return dlg.close();
    if (act === 'form') {
      step = 1;
      return renderForm();
    }
    if (act === 'back') {
      step = Math.max(1, step - 1);
      return renderForm();
    }
    if (act === 'next') {
      if (step === 1) {
        const err = sc.validate(st);
        if (err) return toast(err, 'warning');
      }
      step = Math.min(3, step + 1);
      return renderForm();
    }
    if (act === 'stop') {
      if (running) running.cancelled = true;
      btn.disabled = true;
      btn.textContent = '⏳ Останавливаю…';
      return;
    }
    if (act === 'dry' || act === 'start') return start(act === 'dry');
    if (act === 'retry' && last) {
      const chars = rerunCharsOfRows(last.rows);
      if (!chars.length) return toast('Повторять нечего', 'info');
      t.mode = 'manual';
      t.chars = new Set(chars.map(c => c.id));
      step = 3;
      return start(false);
    }
  });

  renderForm();
  return dlg;
}

/* ============================================================================ */
/* Вариант B · Два столбца: настройка слева, живой ход справа                   */
/* ============================================================================ */

function openGenericSplit(sc) {
  const st = sc.defaultState();
  const t = defaultTarget();
  let running = null;
  let last = null;

  const dlg = openOverlay({
    title: `${sc.icon} ${sc.title} — настройка и ход работы`,
    wide: true,
    onClose: () => {
      if (running) running.cancelled = true;
    }
  });
  dlg.foot.classList.add('sd-foot');
  dlg.el.querySelector('.modal-container').classList.add('sp-container');
  const alive = () => dlg.el.isConnected;
  const $ = name => dlg.body.querySelector(`[data-${name}]`);

  function sideHtml() {
    return `
      <div class="sp-field">
        <label>${escapeHtml(sc.paramTitle)}</label>
        ${sc.paramForm(st)}
      </div>
      <div class="sp-field">
        <label>Кого запускать</label>
        ${targetHtml(t, 'gsp')}
      </div>
      <div class="sp-summary">
        <b data-gjobs>0</b>
        <span>действий у <b data-gchars>0</b> персонажей</span>
        <small class="muted" data-gskip></small>
      </div>`;
  }

  dlg.sub.textContent =
    'Слева — параметры и кого запускать, справа — живой план и ход работы. Ничего не переключается: план, ход и итог живут в одном виде.';
  dlg.body.innerHTML = `
    <div class="sp-body">
      <aside class="sp-side" data-gside>${sideHtml()}</aside>
      <div class="sp-main">
        <div class="sp-progress">
          <div class="sp-progress-top">
            <span class="sp-status" data-gstatus>Готов к запуску</span>
            <b data-gcount>план: 0</b>
          </div>
          <div class="sd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-gbar style="width:0%"></span></div>
        </div>
        <div data-gtable></div>
        <div data-gchips></div>
      </div>
    </div>`;

  function footFormHtml(jobs) {
    return `
      <span class="promo-muted">Изменения слева сразу пересчитывают план справа.</span>
      <span class="sd-foot-spacer"></span>
      <button class="btn secondary" data-act="dry">👁 Пробный</button>
      <button class="btn primary" data-act="start">▶ Запустить${jobs ? ` (${jobs})` : ''}</button>`;
  }

  function setBar(done, total) {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const bar = $('gbar');
    if (bar) bar.style.width = `${pct}%`;
    bar?.parentElement?.setAttribute('aria-valuenow', String(pct));
  }

  /** Пересчёт плана: числа слева, таблица справа (в состоянии «план»), подпись кнопки запуска. */
  function updatePlan() {
    if (running) return;
    // Правка параметров обнуляет прошлый итог: старый результат к новому плану не относится
    last = null;
    const chars = targetChars(t);
    const plan = sc.planRows(st, chars);
    $('gjobs').textContent = String(plan.jobs.length);
    $('gchars').textContent = String(chars.length);
    $('gskip').textContent = plan.skipped.length ? `ещё ${plan.skipped.length} пропустим` : '';
    $('gstatus').textContent = 'Готов к запуску';
    $('gstatus').classList.remove('is-running');
    $('gcount').textContent = `план: ${plan.total}`;
    setBar(0, plan.total);
    $('gchips').innerHTML = '';
    $('gtable').innerHTML = chars.length
      ? liveTable(sc, st, chars, plannedKeyMap(plan))
      : '<p class="muted">Выберите, кого запускать, — здесь появится план.</p>';
    dlg.foot.innerHTML = footFormHtml(plan.jobs.length);
  }

  async function start(dry) {
    const prep = prepRun(sc, st, t);
    if (!prep) return;
    const { chars, plan } = prep;
    if (!dry && !(await confirmRun(sc, st, chars, plan))) return;
    const signal = { cancelled: false };
    running = signal;
    last = null;
    $('gside').classList.add('is-locked');
    $('gstatus').textContent = dry ? '👁 Пробный запуск' : 'Идёт выполнение…';
    $('gstatus').classList.add('is-running');
    $('gchips').innerHTML = '';
    $('gtable').innerHTML = liveTable(sc, st, chars, byKeyOfRows(plan.skipped));
    setBar(plan.skipped.length, plan.total);
    dlg.foot.innerHTML = `
      <span class="promo-muted">«Стоп» не начинает новых действий; уже начатые завершатся.</span>
      <span class="sd-foot-spacer"></span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;

    const rows = await runPlan(plan, sc.makeRow, {
      dry,
      signal,
      onRow: (row, done, total) => {
        if (!alive()) return;
        updateCell(dlg, row);
        setBar(done, total);
        $('gcount').textContent = `${done} из ${total}`;
      }
    });
    running = null;
    if (!alive()) return;
    last = { rows, chars, dry, stopped: signal.cancelled };
    $('gside').classList.remove('is-locked');
    $('gstatus').classList.remove('is-running');
    $('gstatus').textContent = signal.cancelled ? '⏹ Остановлено' : dry ? '👁 Пробный завершён' : '✅ Завершено';
    $('gchips').innerHTML = sc.chips(rows, dry);
    const rerun = dry ? [] : rerunCharsOfRows(rows);
    dlg.foot.innerHTML = `
      <span class="promo-muted">${escapeHtml(sc.summaryLine(rows, dry, signal.cancelled))}</span>
      <span class="sd-foot-spacer"></span>
      ${rerun.length ? `<button class="btn secondary" data-act="retry">🔁 Повторить ошибки (${rerun.length})</button>` : ''}
      <button class="btn ghost" data-act="close">Закрыть</button>`;
  }

  sc.bindParams(dlg.body, st, updatePlan);
  bindTarget(dlg.body, t, 'gsp', updatePlan);

  dlg.foot.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act) return;
    if (act === 'close') return dlg.close();
    if (act === 'stop') {
      if (running) running.cancelled = true;
      btn.disabled = true;
      btn.textContent = '⏳ Останавливаю…';
      return;
    }
    if (act === 'dry' || act === 'start') return start(act === 'dry');
    if (act === 'retry' && last) {
      const chars = rerunCharsOfRows(last.rows);
      if (!chars.length) return toast('Повторять нечего', 'info');
      t.mode = 'manual';
      t.chars = new Set(chars.map(c => c.id));
      // Перерисовываем левый столбец: радио «вручную» и отметки должны совпасть с новым набором
      $('gside').innerHTML = sideHtml();
      bindTarget(dlg.body, t, 'gsp', updatePlan);
      updatePlan();
      return start(false);
    }
  });

  updatePlan();
  return dlg;
}

/* ============================================================================ */
/* Вариант C · Быстрый запуск + фоновый док                                     */
/* ============================================================================ */

function openGenericQuick(sc) {
  const st = sc.defaultState();
  const t = defaultTarget();
  const dlg = openOverlay({ title: `${sc.icon} ${sc.title} — быстрый запуск` });
  dlg.foot.classList.add('sd-foot');
  dlg.el.querySelector('.modal-container').classList.add('ql-container');

  dlg.sub.textContent =
    'Минимум полей: параметры, кого запускать — и «Запустить». Ход работы продолжится в плавающем доке: окно можно закрыть, приложение доделает само.';
  dlg.body.innerHTML = `
    <div class="ql-field">
      <label>${escapeHtml(sc.paramTitle)}</label>
      ${sc.paramForm(st)}
    </div>
    <div class="ql-field">
      <label>Кого запускать</label>
      <div class="ql-seg" data-qseg>
        <button type="button" data-t="all">Все <b>${CHARS.length}</b></button>
        <button type="button" data-t="logged" class="is-on">С входом <b>${CHARS.filter(c => c.isLoggedIn === true).length}</b></button>
        <button type="button" data-t="party">Пати <b>${PARTIES.length}</b></button>
        <button type="button" data-t="manual">Вручную <b data-gmn>${t.chars.size}</b></button>
      </div>
      ${targetListsHtml(t, 'ql')}
    </div>
    <div class="ql-summary" data-gsum></div>`;
  dlg.foot.innerHTML = `
    <button type="button" class="btn ghost" data-act="tune">⚙ Полная форма</button>
    <span class="sd-foot-spacer"></span>
    <button type="button" class="btn ghost" data-act="close">✕ Закрыть</button>
    <button type="button" class="btn primary" data-act="go">▶ Запустить</button>`;

  const syncLists = bindTarget(dlg.body, t, 'ql', updateSummary);
  sc.bindParams(dlg.body, st, updateSummary);

  function updateSummary() {
    const chars = targetChars(t);
    const plan = sc.planRows(st, chars);
    const mn = dlg.body.querySelector('[data-gmn]');
    if (mn) mn.textContent = String(t.chars.size);
    const sum = dlg.body.querySelector('[data-gsum]');
    if (sum) {
      sum.innerHTML = `<b>${plan.jobs.length}</b> действий у <b>${chars.length}</b> персонажей<span class="promo-muted"> · ${escapeHtml(
        sc.paramsLine(st)
      )}${plan.skipped.length ? ` · пропустим ${plan.skipped.length}` : ''}</span>`;
    }
  }

  dlg.body.addEventListener('click', e => {
    const seg = e.target.closest('[data-t]');
    if (!seg) return;
    t.mode = seg.dataset.t;
    dlg.body.querySelectorAll('[data-qseg] button').forEach(b => b.classList.toggle('is-on', b === seg));
    syncLists();
    updateSummary();
  });

  dlg.foot.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'tune') return toast('Здесь открылась бы полная форма — как варианты 0 или B', 'info');
    if (act === 'close') return dlg.close();
    if (act !== 'go') return;
    const prep = prepRun(sc, st, t);
    if (!prep) return;
    dlg.close();
    openGenericDock(sc, st, prep.chars);
  });

  updateSummary();
  return dlg;
}

/** Плавающий док: пилюля с прогрессом + раскрывающаяся панель хода работы. */
function openGenericDock(sc, st, chars) {
  document.querySelector('.ql-dock')?.remove(); // один док на демо
  const plan = sc.planRows(st, chars);
  const dock = el('div', 'ql-dock');
  dock.innerHTML = `
    <div class="ql-panel">
      <header>
        <b>${sc.icon} ${escapeHtml(sc.titleShort)} · <span data-dstate>в очереди</span></b>
        <span class="ql-panel-acts">
          <button type="button" class="btn ghost tiny" data-dstop hidden>⏹ Стоп</button>
          <button type="button" class="icon-btn" data-dtoggle title="Свернуть">▾</button>
        </span>
      </header>
      <div class="ql-events" data-devents></div>
      <div class="ql-panel-foot" data-dfoot></div>
    </div>
    <button type="button" class="ql-pill" data-dpill title="${escapeHtml(sc.titleShort)} — нажмите, чтобы развернуть/свернуть">
      <span class="ql-pill-ico" data-dico><span class="ql-spin"></span></span>
      <span class="ql-pill-copy"><b>${escapeHtml(sc.titleShort)}</b><small data-dsub>0 из ${plan.total}</small></span>
      <span class="ql-pill-bar"><i data-dbar style="width:0%"></i></span>
    </button>`;
  document.body.appendChild(dock);

  const $ = name => dock.querySelector(`[data-${name}]`);
  const panel = dock.querySelector('.ql-panel');
  const signal = { cancelled: false };

  $('dtoggle').onclick = () => {
    panel.hidden = !panel.hidden;
    $('dtoggle').textContent = panel.hidden ? '▴' : '▾';
  };
  $('dpill').onclick = () => $('dtoggle').click();
  $('dstop').onclick = e => {
    signal.cancelled = true;
    e.currentTarget.hidden = true;
  };

  function addEvents(rows) {
    const box = $('devents');
    rows.forEach(r =>
      box.insertAdjacentHTML(
        'beforeend',
        `<div class="ql-event ql-${statusMeta(r.status).level}"><time>${hhmmss()}</time><span>${eventLineHtml(r)}</span></div>`
      )
    );
    box.scrollTop = box.scrollHeight;
  }

  function setPill(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    $('dsub').textContent = `${done} из ${total} · ${pct}%`;
    $('dbar').style.width = `${pct}%`;
  }

  // Сразу показываем пропущенные строки плана
  $('dstate').textContent = 'идёт запуск';
  $('dstop').hidden = false;
  addEvents(plan.skipped);
  setPill(plan.skipped.length, plan.total);

  runPlan(plan, sc.makeRow, {
    signal,
    onRow: (row, done, total) => {
      addEvents([row]);
      setPill(done, total);
    }
  }).then(rows => {
    const stopped = signal.cancelled;
    const failed = countOf(rows, ...PROBLEM);
    $('dstate').textContent = stopped ? 'остановлено' : 'готово';
    $('dstop').hidden = true;
    const pill = $('dpill');
    pill.classList.toggle('is-done', !stopped && !failed);
    pill.classList.toggle('is-stopped', stopped);
    $('dico').innerHTML = stopped ? '⏹' : failed ? '⚠️' : '✅';
    $('dsub').textContent = stopped
      ? `Остановлено · ${rows.length} из ${plan.total}`
      : `Готово ${rows.length} из ${plan.total}${failed ? ` · проблем ${failed}` : ''}`;
    $('dbar').style.width = '100%';
    const rerun = rerunCharsOfRows(rows);
    $('dfoot').innerHTML = `
      ${sc.chips(rows, false)}
      <div class="ql-dock-btns">
        <button type="button" class="btn ghost small" data-dlog>📜 Открыть журнал</button>
        ${
          rerun.length
            ? `<button type="button" class="btn secondary small" data-drerun>🔁 Повторить ошибки (${rerun.length})</button>`
            : ''
        }
        <button type="button" class="btn ghost small" data-ddismiss>Скрыть</button>
      </div>`;
    dock.querySelector('[data-dlog]').onclick = () =>
      toast('В приложении здесь откроется журнал этого скрипта', 'info');
    const rerunBtn = dock.querySelector('[data-drerun]');
    if (rerunBtn) {
      rerunBtn.onclick = () => {
        dock.remove();
        toast('Повторяем для тех, у кого не получилось…', 'info');
        openGenericDock(sc, st, rerun);
      };
    }
    dock.querySelector('[data-ddismiss]').onclick = () => dock.remove();
    toast(
      `${sc.icon} ${sc.titleShort}: ${sc.summaryLine(rows, false, stopped)}`,
      stopped || failed ? 'warning' : 'success',
      4200
    );
  });
}

/* ============================================================================ */
/* Вариант D · Консоль скрипта                                                  */
/* ============================================================================ */

function openGenericConsole(sc) {
  const st = sc.defaultState();
  const dlg = openOverlay({ title: `⌨️ Консоль · ${sc.icon} ${sc.titleShort}` });
  dlg.foot.classList.add('sd-foot');
  dlg.el.querySelector('.modal-container').classList.add('cn-container');
  const alive = () => dlg.el.isConnected;
  let running = null; // { signal, text, done, total }
  let lastCmd = '';

  dlg.sub.textContent = `Демо-консоль сценария «${sc.titleShort}»: команды выполняются локально на фейковых данных. Enter — выполнить, ↑ — прошлая команда.`;
  dlg.body.innerHTML = `
    <div class="cn-log" data-clog role="log" aria-live="polite"></div>
    <form class="cn-input-row" data-cform>
      <span class="cn-prompt">${escapeHtml(sc.cmd)}❯</span>
      <input class="cn-input" data-cin autocomplete="off" spellcheck="false" aria-label="Команда консоли" placeholder="${escapeHtml(
        sc.consolePlaceholder
      )}">
    </form>`;
  dlg.foot.innerHTML = `
    <div class="cn-hints">
      <button type="button" class="btn ghost small" data-cmd="help">help</button>
      <button type="button" class="btn ghost small" data-cmd="${escapeHtml(sc.consoleExample)}">${escapeHtml(
        sc.cmd
      )} … (пример)</button>
      <button type="button" class="btn ghost small" data-cmd="status">status</button>
      <button type="button" class="btn ghost small" data-cmd="stop">stop</button>
      <button type="button" class="btn ghost small" data-cmd="clear">clear</button>
    </div>
    <span class="sd-foot-spacer"></span>
    <button type="button" class="btn ghost" data-act="close">✕ Закрыть</button>`;

  const log = dlg.body.querySelector('[data-clog]');
  const form = dlg.body.querySelector('[data-cform]');
  const input = dlg.body.querySelector('[data-cin]');

  function print(text, cls = '') {
    const line = el('div', `cn-line ${cls}`.trim());
    line.innerHTML = `<time>${hhmmss()}</time><span>${text}</span>`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    return line.querySelector('span');
  }

  function welcome() {
    log.innerHTML = '';
    print(`Твиноферма · консоль скриптов (демо) · сценарий «${escapeHtml(sc.title)}»`, 'cn-acc');
    print(`help — список команд. Пример: <b>${escapeHtml(sc.consoleExample)}</b>`, 'cn-dim');
  }

  function resolveTarget(value) {
    if (!value || value === 'all') return [...CHARS].sort(byNick);
    if (value === 'logged') return CHARS.filter(c => c.isLoggedIn === true).sort(byNick);
    if (value === 'none') return [];
    if (value.startsWith('party:')) {
      const name = value.slice(6);
      return CHARS.filter(c => c.party.toLowerCase() === name.toLowerCase()).sort(byNick);
    }
    // перечисление ников через «+»
    const nicks = value.split('+').map(s => s.trim().toLowerCase());
    return CHARS.filter(c => nicks.includes(String(c.nick).toLowerCase())).sort(byNick);
  }

  async function cmdRun(args) {
    if (running) {
      print('Уже идёт запуск — дождитесь окончания или введите stop.', 'cn-warn');
      return;
    }
    const flags = args.filter(a => a.startsWith('--'));
    const flagErr = sc.consoleFlags(flags, st);
    if (flagErr) {
      print(`⚠ ${escapeHtml(flagErr)}`, 'cn-warn');
      return;
    }
    const validateErr = sc.validate(st);
    if (validateErr) {
      print(`⚠ ${escapeHtml(validateErr)}`, 'cn-warn');
      return;
    }
    const dry = flags.some(f => f === '--dry');
    const targetFlag = flags.find(f => f.startsWith('--target='))?.slice('--target='.length) || 'all';
    const chars = resolveTarget(targetFlag);
    if (!chars.length) {
      print('Под фильтр --target никто не подошёл.', 'cn-warn');
      return;
    }
    const plan = sc.planRows(st, chars);
    if (!plan.jobs.length) {
      print('Запускать нечего: все строки пропущены.', 'cn-warn');
      return;
    }
    print(
      `▶ ${dry ? 'Пробный запуск' : 'Запуск'}: ${escapeHtml(sc.paramsLine(st))} · персонажей ${chars.length} · действий ${
        plan.jobs.length
      } · пропустим ${plan.skipped.length}`,
      'cn-acc'
    );
    plan.skipped.forEach(r => print(eventLineHtml(r), 'cn-dim'));

    const signal = { cancelled: false };
    const progressLine = print('', 'cn-progress');
    running = { signal, text: sc.cmd, done: plan.skipped.length, total: plan.total };
    const barText = (done, total) => {
      const pct = total > 0 ? done / total : 0;
      const filled = Math.round(pct * 24);
      return `[${'█'.repeat(filled)}${'░'.repeat(24 - filled)}] ${done}/${total}`;
    };
    progressLine.textContent = barText(plan.skipped.length, plan.total);

    const rows = await runPlan(plan, sc.makeRow, {
      dry,
      signal,
      speed: 1.4,
      onRow: (row, done, total) => {
        if (!alive()) return;
        running.done = done;
        progressLine.textContent = `${barText(done, total)} · ${row.nick}`;
        const level = statusMeta(row.status).level;
        const cls = level === 'ok' ? 'cn-ok' : level === 'error' ? 'cn-err' : level === 'warn' ? 'cn-warn' : 'cn-dim';
        print(eventLineHtml(row), cls);
      }
    });
    running = null;
    if (!alive()) return;
    progressLine.textContent = `${barText(rows.length, plan.total)} · ${signal.cancelled ? 'остановлено' : 'готово'}`;
    const failed = countOf(rows, ...PROBLEM);
    print(
      `${signal.cancelled ? '⏹' : failed ? '⚠️' : '✅'} ${escapeHtml(sc.summaryLine(rows, dry, signal.cancelled))}`,
      signal.cancelled || failed ? 'cn-warn' : 'cn-ok'
    );
    const rares = rows.filter(r => r.status === 'rare');
    if (rares.length) {
      print(
        `💎 Редкие находки: ${rares.map(r => `${escapeHtml(r.nick)} — ${escapeHtml(r.detail || '')}`).join('; ')}`,
        'cn-acc'
      );
    }
    const rerun = rerunCharsOfRows(rows);
    if (!dry && rerun.length) {
      print(
        `Повторить для проблемных: <b>${escapeHtml(sc.cmd)} --target=${escapeHtml(rerun.map(c => c.nick).join('+'))}</b>`,
        'cn-dim'
      );
    }
  }

  function submit(rawLine) {
    const line = rawLine.trim();
    if (!line) return;
    lastCmd = line;
    print(`❯ <b>${escapeHtml(line)}</b>`, 'cn-acc');
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    if (cmd === 'help') {
      print('Команды консоли (демо):', 'cn-acc');
      sc.consoleHelp.forEach(h => print(escapeHtml(h), 'cn-dim'));
      print('status — что сейчас идёт · stop — остановить · clear — очистить лог', 'cn-dim');
      return;
    }
    if (cmd === 'status') {
      if (!running) {
        print('Ничего не выполняется.', 'cn-dim');
        return;
      }
      print(`Выполняется ${escapeHtml(running.text)}: ${running.done} из ${running.total}.`, 'cn-progress');
      return;
    }
    if (cmd === 'stop') {
      if (!running) {
        print('Останавливать нечего.', 'cn-dim');
        return;
      }
      running.signal.cancelled = true;
      print('Останавливаю: новые действия не начинаются, уже начатые завершатся.', 'cn-warn');
      return;
    }
    if (cmd === 'clear') {
      welcome();
      return;
    }
    if (cmd === sc.cmd || cmd === 'run') {
      cmdRun(args);
      return;
    }
    print(`Не знаю команду «${escapeHtml(cmd)}». Введите help.`, 'cn-err');
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    submit(input.value);
    input.value = '';
    input.focus();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      input.value = lastCmd;
    }
  });
  dlg.foot.addEventListener('click', e => {
    const cmdBtn = e.target.closest('[data-cmd]');
    if (cmdBtn) {
      submit(cmdBtn.dataset.cmd);
      input.focus();
      return;
    }
    if (e.target.closest('[data-act="close"]')) dlg.close();
  });

  welcome();
  input.focus();
  return dlg;
}

/* ============================================================================ */
/* Точка входа: сценарий × вариант                                              */
/* ============================================================================ */

const BUILDERS = {
  current: openGenericCurrent,
  wizard: openGenericWizard,
  split: openGenericSplit,
  quick: openGenericQuick,
  console: openGenericConsole
};

/** Открыть окно сценария: openScenario('shop', 'split') → вариант B для «Подарков». */
export function openScenario(scriptId, variant) {
  const sc = SCENARIOS[scriptId];
  const build = BUILDERS[variant];
  if (!sc || !build) {
    toast('Не знаю такой сценарий или вариант окна', 'warning');
    return null;
  }
  return build(sc);
}

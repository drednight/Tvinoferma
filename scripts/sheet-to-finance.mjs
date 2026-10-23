// @ts-check
// Конвертирует «Банковские расчеты» (лист на месяц) в finance-операции приложения:
//   node scripts/sheet-to-finance.mjs <Банк.xlsx> [выходной.json]
//
// Модель таблицы (проверена по формулам листов, например «Сентябрь 2026» A9):
//   SUM(доход) − SUM(расход)
//   + SUMIFS(расход; «на что»="Торговля" И «статус»="Скуп")     ← выкуп возвращается в плюс
//   − SUMIFS(доход; «откуда»="Торговля" И «статус»="Продажа")   ← продажа по торговле в минус
// Строка «Перенос прошлого месяца» — это остаток прошлого месяца, а НЕ операция:
// в реестр она не попадает, а сохраняется как начальный остаток (settings.opening)
// от последнего переноса. Баланс приложения = начальный остаток + движения после него,
// поэтому в панели видно «сколько сейчас на руках», а не сумму всех месяцев.
//
// Раскладка колонок ищется по заголовкам (в 2025-м она сдвинута), даты бывают
// excel-серийниками и текстом, суммы — числом или текстом в двух локалях.

import XLSX from 'xlsx';
import fs from 'node:fs';

// SheetJS в ESM-сборке (0.20+) не трогает диск сам: без этого readFile падает «cannot read file».
XLSX.set_fs(fs);

const [file, outFile = 'C:/Users/mivlz/Downloads/tvinoferma_finance_all.json'] = process.argv.slice(2);
if (!file) {
  console.error('Использование: node scripts/sheet-to-finance.mjs <Банк.xlsx> [выходной.json]');
  process.exit(1);
}

const MONTHS = {
  январь: 1,
  февраль: 2,
  март: 3,
  апрель: 4,
  май: 5,
  июнь: 6,
  июль: 7,
  август: 8,
  сентябрь: 9,
  октябрь: 10,
  ноябрь: 11,
  декабрь: 12
};
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const serialToDate = s => new Date(Math.round((s - 25569) * 86400 * 1000));

/** Текст суммы в двух локалях → число. shortcut: форматы вроде «$1 234» сюда не попадали. */
function parseAmount(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[\s\u00A0']/g, '');
  if (!s) return 0;
  const lastComma = s.lastIndexOf(','),
    lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0)
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lastComma >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(v, sheetMonth) {
  if (v instanceof Date) return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number' && v > 40000) {
    const d = serialToDate(v);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const m = String(v ?? '')
    .trim()
    .match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : sheetMonth.year;
    return iso(year, +m[2], +m[1]);
  }
  return null;
}

/** Месяц из имени листа («Июнь-июль 2025» → июль — последний в диапазоне). */
function sheetMonth(name) {
  const parts = name
    .toLowerCase()
    .split(/[-–—\s]+/)
    .filter(Boolean);
  let year = new Date().getFullYear();
  const months = [];
  for (const p of parts) {
    if (MONTHS[p]) months.push(MONTHS[p]);
    else if (/^\d{4}$/.test(p)) year = +p;
  }
  return { year, month: months.at(-1) ?? 6 };
}

const wb = XLSX.readFile(file, { cellDates: true });
const operations = [];
const seq = { in: 0, out: 0 };
let lastRate = null;
let lastSheetTotal = 0; // итог последнего листа = сколько «сейчас» по таблице
const sheetTotals = {}; // итог каждого листа: { "2026-09": 3278083094 }
const monthAdjust = {}; // поправки по месяцам: { "2026-09": { gold: -260000000 } }
const monthCarry = {}; // перенос прошлого месяца внутри итога: { "2026-09": { gold: 1058494439 } }
let anyMismatch = false;

for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
  const sm = sheetMonth(name);
  const hIdx = rows.findIndex(r =>
    r.some(
      c =>
        String(c ?? '')
          .trim()
          .toLowerCase() === 'дата'
    )
  );
  if (hIdx === -1) {
    console.warn(`⚠ «${name}»: заголовок не найден, лист пропущен`);
    anyMismatch = true;
    continue;
  }
  const h = rows[hIdx].map(c =>
    String(c ?? '')
      .trim()
      .toLowerCase()
  );
  const find = (word, from) => h.indexOf(word, from);
  const incDate = find('дата', 0);
  const incFrom = find('откуда', 0);
  const incSum = find('сумма', incFrom);
  const expDate = find('дата', incDate + 1);
  const expWhat = find('на что', 0);
  const expSum = find('сумма', expWhat);
  const incNote = find('доп инфа', incSum);
  const incStatusRaw = find('статус', incSum);
  const incStatus = incStatusRaw >= 0 && incStatusRaw < expDate ? incStatusRaw : -1;
  const expNote = find('примечание', expSum);
  const expStatus = find('статус', expSum);
  if ([incDate, incFrom, incSum, expDate, expWhat, expSum].some(i => i < 0)) {
    console.warn(`⚠ «${name}»: колонки не найдены, лист пропущен`);
    anyMismatch = true;
    continue;
  }

  const lastDay = iso(sm.year, sm.month, daysInMonth(sm.year, sm.month));
  let sumIn = 0,
    sumOut = 0,
    skup = 0,
    prodazha = 0;
  let sheetCarry = 0; // перенос этого листа: входит в его итог, но не в реестр
  const body = rows.slice(hIdx + 1);
  for (const r of body) {
    if (!r || r.every(c => c == null || String(c).trim() === '')) continue;
    const from = String(r[incFrom] ?? '').trim();
    const what = String(r[expWhat] ?? '').trim();
    const inStatus = incStatus >= 0 ? String(r[incStatus] ?? '').trim() : '';
    const outStatus = String(r[expStatus] ?? '').trim();
    const inAmount = parseAmount(r[incSum]);
    const outAmount = parseAmount(r[expSum]);
    const isCarry = /^(перенос|банк)/i.test(from);

    if (isCarry) {
      // Перенос — остаток прошлого месяца, а НЕ приход этого: цепочка «перенос месяца
      // N+1 = итог месяца N» проверена по формулам листов. В реестр он не идёт.
      // Строка переноса может содержать и расход (в сентябре 2026 — «Голд» 40 млн):
      // приход пропускаем, расход обрабатываем ниже.
      if (inAmount > 0) sheetCarry = inAmount;
    } else if (inAmount > 0 && from) {
      const date = parseDate(r[incDate], sm) ?? lastDay;
      seq.in++;
      sumIn += inAmount;
      operations.push({
        id: `sh-in-${String(seq.in).padStart(3, '0')}`,
        date,
        currency: 'gold',
        kind: 'in',
        amount: inAmount,
        counterparty: from,
        note: String(r[incNote] ?? '').trim(),
        status: inStatus,
        source: 'manual',
        ref: null
      });
      if (from === 'Торговля' && inStatus === 'Продажа') prodazha += inAmount;
    }
    if (outAmount > 0) {
      seq.out++;
      sumOut += outAmount;
      operations.push({
        id: `sh-out-${String(seq.out).padStart(3, '0')}`,
        date: parseDate(r[expDate], sm) ?? lastDay,
        currency: 'gold',
        kind: 'out',
        amount: outAmount,
        counterparty: what,
        note: String(r[expNote] ?? '').trim(),
        status: outStatus,
        source: 'manual',
        ref: null
      });
      if (what === 'Торговля' && outStatus === 'Скуп') skup += outAmount;
    }
    const a = r[0];
    if (typeof a === 'number' && a > 10 && a < 100000 && String(a).split('.')[1]?.length > 2) {
      lastRate = { rate: Math.round(a * 100) / 100, at: lastDay };
    }
  }

  // Итог по формуле листа — он же колонка «Банк». Перенос в SUM(доход) входит,
  // а из реестра мы его убрали, поэтому возвращаем его в итог слагаемым.
  const sheetTotal = sumIn - sumOut + sheetCarry + skup - prodazha;
  const f = n => n.toLocaleString('ru-RU');
  console.log(
    `${name}: in ${f(sumIn)} + перенос ${f(sheetCarry)} − out ${f(sumOut)}${skup ? ` + скуп ${f(skup)}` : ''}${prodazha ? ` − торговля ${f(prodazha)}` : ''} = ${f(sheetTotal)}`
  );
  const monthKey = `${sm.year}-${pad(sm.month)}`;
  sheetTotals[monthKey] = sheetTotal;
  if (sheetCarry) monthCarry[monthKey] = { gold: sheetCarry };
  lastSheetTotal = sheetTotal;
}

// Поправка месяца = итог листа минус нетто записей, СГРУППИРОВАННЫХ ПО ДАТЕ (приложение
// группирует по дате, а не по листу). Часть строк лист датирует соседним месяцем,
// поэтому считать поправку от «нетто листа» нельзя — итог месяца разъедется.
const netByDate = new Map();
for (const op of operations) {
  const key = op.date.slice(0, 7);
  netByDate.set(key, (netByDate.get(key) ?? 0) + (op.kind === 'in' ? op.amount : -op.amount));
}
for (const [month, total] of Object.entries(sheetTotals)) {
  const fix = Math.round(total - (netByDate.get(month) ?? 0));
  if (fix) monthAdjust[month] = { gold: fix };
}
const f2 = n => n.toLocaleString('ru-RU');
console.log(`\nпоправки по месяцам (итог листа − нетто по дате):`);
for (const [month, amounts] of Object.entries(monthAdjust).sort()) {
  const parts = Object.entries(amounts).map(([id, n]) => `${id} ${f2(n)}`);
  console.log(`   ${month}: ${parts.join(', ')}`);
}

// Начальный остаток не нужен: итог каждого месяца уже включает перенос, поэтому
// месяцы живут поправками (monthAdjust), а не накопительным остатком.

const finance = {
  operations,
  shopItems: [],
  loans: [],
  settings: {
    goldRate: lastRate?.rate ?? 0,
    goldRateAt: lastRate?.at ?? null,
    commissionPct: 2,
    opening: { gold: 0, coins: 0 },
    monthAdjust,
    monthCarry
  }
};
fs.writeFileSync(outFile, JSON.stringify({ finance }, null, 1), 'utf8');
// «Сейчас» — итог последнего месяца (месяцы в таблице не сходятся между собой,
// поправки заданы как абсолютные итоги, поэтому суммировать их нельзя).
const newestMonth = Object.keys(monthAdjust).sort().at(-1);
const newestFix = monthAdjust[newestMonth]?.gold ?? 0;
const newestNet = operations
  .filter(o => o.date.slice(0, 7) === newestMonth)
  .reduce((s, o) => s + (o.kind === 'in' ? o.amount : -o.amount), 0);
const balanceNow = newestNet + newestFix;
console.log(`\n${operations.length} операций; поправок по месяцам: ${Object.keys(monthAdjust).length}`);
console.log(
  `баланс сейчас: ${balanceNow.toLocaleString('ru-RU')} золота (итог ${newestMonth}, цель ${lastSheetTotal.toLocaleString('ru-RU')})`
);
if (lastRate) console.log(`курс голда: ${lastRate.rate} на ${lastRate.at}`);
console.log(`-> ${outFile}`);
if (anyMismatch || balanceNow !== lastSheetTotal) process.exitCode = 1;

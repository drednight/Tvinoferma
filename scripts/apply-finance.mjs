// @ts-check
// Накатывает `finance` из JSON-файла в state.json десктоп-приложения.
// Нужен, когда приложение ещё старое и импорт-мастер финансы не применяет.
//
//   Закрой приложение, затем:
//   node scripts/apply-finance.mjs <finance.json> [путь\к\state.json]
//
// Перед записью делает бэкап state.json рядом. Дубликаты отсекаются по id,
// поэтому повторный запуск безопасен и ничего не размножает.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const [file, stateArg] = args.filter(a => !a.startsWith('--'));
if (!file) {
  console.error('Использование: node scripts/apply-finance.mjs <finance.json> [путь\\к\\state.json]');
  process.exit(1);
}
const statePath = stateArg ?? path.join(process.env.APPDATA, 'com.tvinoferma.desktop', 'tvinoferma_data', 'state.json');

const src = JSON.parse(fs.readFileSync(file, 'utf8')).finance;
if (!src || !Array.isArray(src.operations)) {
  console.error('В файле нет finance.operations — нечего накатывать');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const fin = (state.finance ??= { operations: [], shopItems: [], loans: [], settings: {} });
const union = (a = [], b = []) => {
  const m = new Map(a.map(x => [x.id, x]));
  for (const x of b) if (!m.has(x.id)) m.set(x.id, x);
  return [...m.values()];
};

const before = fin.operations.length;
// Записи таблицы (`sh-*`) — не пользовательские: их состав задаёт файл целиком.
// Иначе пересозданный конвертер оставлял бы в реестре то, что он уже не создаёт
// (напр. строки переноса, ныне уехавшие в monthCarry).
const fromSheet = op => /^sh-(in|out)-/.test(String(op.id || ''));
const keepIds = new Set(src.operations.filter(fromSheet).map(o => o.id));
const localKept = fin.operations.filter(o => !fromSheet(o) || keepIds.has(o.id));
const byId = new Map([...localKept, ...src.operations].map(o => [o.id, o]));
fin.operations = [...byId.values()];
fin.shopItems = union(fin.shopItems, src.shopItems);
fin.loans = union(fin.loans, src.loans);
// Настройки — из более свежего источника (как в импорт-мастере).
if (String(src.settings?.goldRateAt || '') >= String(fin.settings?.goldRateAt || '')) {
  fin.settings = { ...fin.settings, ...src.settings };
}
// opening, monthAdjust и monthCarry — часть импортируемых данных, а не рыночный
// курс: их переносим всегда, иначе баланс панели не сойдётся с таблицей.
if (src.settings?.opening) fin.settings.opening = src.settings.opening;
if (src.settings?.monthAdjust) fin.settings.monthAdjust = src.settings.monthAdjust;
if (src.settings?.monthCarry) fin.settings.monthCarry = src.settings.monthCarry;

const backup = `${statePath}.bak-${Date.now()}`;
fs.copyFileSync(statePath, backup);
fs.writeFileSync(statePath, JSON.stringify(state));

// «Сейчас» — итог последнего месяца с его поправкой (месяцы в таблице не сходятся
// между собой, поэтому суммировать движения за всю историю нельзя).
const adjust = fin.settings?.monthAdjust ?? {};
const newest = Object.keys(adjust).sort().at(-1);
const balance = newest
  ? fin.operations
      .filter(o => o.date.slice(0, 7) === newest)
      .reduce((s, o) => s + (o.kind === 'in' ? o.amount : -o.amount), 0) + (adjust[newest]?.gold ?? 0)
  : fin.operations.reduce((sum, o) => sum + (o.kind === 'in' ? o.amount : -o.amount), 0);
console.log(`Операций: было ${before}, стало ${fin.operations.length}`);
console.log(`Баланс сейчас (итог ${newest ?? '—'}): ${balance.toLocaleString('ru-RU')} золота`);
console.log(`Бэкап старого файла: ${backup}`);

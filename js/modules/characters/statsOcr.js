// js/modules/characters/statsOcr.js
// Разбор скриншота с окном характеристик персонажа.
//
// Как это работает: Rust (`stats_ocr.rs`) отдаёт строки, распознанные встроенным в Windows OCR,
// вместе с их координатами. Здесь строки превращаются в характеристики персонажа.
//
// Почему нужны координаты, а не порядок строк: распознаватель возвращает подписи и значения разными
// строками, и порядок в ответе не совпадает с порядком на экране — часто сначала идут все подписи,
// потом все значения. Поэтому каждая подпись связывается со значением, которое стоит **в той же строке
// и правее неё**. Такой разбор работает и на окне с одной колонкой характеристик, и на окне с двумя:
// в двухколоночном окне подпись из правой колонки просто не увидит значения левой.
//
// Модуль намеренно не зависит от DOM и от состояния приложения: на вход строки, на выход характеристики.

import { DEFAULT_STATS } from './stateManager.js';

/**
 * @typedef {{ text: string, x: number, y: number, w: number, h: number }} OcrLine координаты — доли 0…1
 * @typedef {{ key: string, label: string, kind?: 'int' | 'percent' | 'decimal', aliases?: string[], ignore?: boolean }} StatField
 */

/**
 * Какие характеристики распознаём и по каким словам узнаём их в тексте.
 * `kind` нужен, чтобы правильно прочитать значение: у процентов и скорости атаки своя форма записи.
 * `aliases` — как подпись может выглядеть на скриншоте (распознаватель видит и сокращения).
 */
export const STAT_FIELDS = /** @type {StatField[]} */ ([
  { key: 'endurance', label: 'Выносливость', aliases: ['выносливость', 'выносл'] },
  { key: 'intelligence', label: 'Интеллект', aliases: ['интеллект', 'интел'] },
  { key: 'strength', label: 'Сила', aliases: ['сила'] },
  { key: 'agility', label: 'Ловкость', aliases: ['ловкость', 'ловк'] },
  { key: 'hp', label: 'Здоровье', aliases: ['здоровье'] },
  { key: 'mp', label: 'Маг. энергия', aliases: ['маг энергия', 'магическая энергия', 'энергия'] },
  { key: 'levelBonus', label: 'Бонус к уровню', kind: 'percent', aliases: ['бонус к уровню', 'бонус уровню'] },
  { key: 'physAttack', label: 'Физ. атака', aliases: ['физическая атака', 'физ атака'] },
  { key: 'physDefense', label: 'Физ. защита', aliases: ['физическая защита', 'физ защита'] },
  { key: 'magAttack', label: 'Маг. атака', aliases: ['магическая атака', 'маг атака'] },
  { key: 'magDefense', label: 'Маг. защита', aliases: ['магическая защита', 'маг защита'] },
  { key: 'atkSpeed', label: 'Скорость атаки', kind: 'decimal', aliases: ['скорость атаки', 'скор атаки'] },
  { key: 'critChance', label: 'Шанс крит. удара', kind: 'percent', aliases: ['шанс крит удара', 'шанс крит'] },
  { key: 'critDamage', label: 'Крит. урон', kind: 'percent', aliases: ['крит урон', 'критический урон'] },
  { key: 'evasion', label: 'Уклонение', aliases: ['уклонение', 'уклон'] },
  { key: 'accuracy', label: 'Меткость', aliases: ['меткость', 'метк'] },
  { key: 'pa', label: 'Показатель атаки', aliases: ['показатель атаки'] },
  { key: 'pz', label: 'Показатель защиты', aliases: ['показатель защиты'] },
  { key: 'morale', label: 'Боевой дух', kind: 'percent', aliases: ['боевой дух'] },
  // Не переносится в карточку: подпись нужна, чтобы «Боевая сила» не принималась за «Силу».
  { key: 'power', label: 'Сила (боевая)', ignore: true, aliases: ['боевая сила', 'сила атаки'] },
  { key: 'pvePa', label: 'Урон по монстрам (PvE PA)', aliases: ['урон по монстрам', 'pve pa', 'пве па'] },
  { key: 'pvePz', label: 'Защита от монстров (PvE PZ)', aliases: ['защита от монстров', 'pve pz', 'пве пз'] },
  { key: 'physPenetration', label: 'Физ. пробивание', aliases: ['физическое пробивание', 'физ пробивание'] },
  { key: 'magPenetration', label: 'Маг. пробивание', aliases: ['магическое пробивание', 'маг пробивание'] }
]);

/** Приводим строку к «плоскому» виду: без знаков, лишних пробелов, в нижнем регистре. */
export function normalizeLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[·•:;|/\\()[\]{}.,!?"'«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Число из строки, как его показывает игра.
 * «42 350» → 42350, «12%» → 12, «0.80» → 0.8, «1,5» → 1.5.
 * Диапазоны и пары «текущее/максимальное» берутся по правому числу — это итоговое значение:
 *   «96587/96587» → 96587, «155668-166963» → 166963.
 * `null` — числа в строке нет (значит, это подпись или посторонний текст).
 */
export function parseNumber(text, kind = 'int') {
  const cleaned = String(text || '')
    .replace(/[^\d.,/-]/g, '')
    .replace(/\s/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  // Десятичные бывают только у дробных характеристик («0.80»): у остальных точка и запятая —
  // это разделители разрядов, которые надо убрать («1.234» в игре означало бы 1234).
  let normalized = cleaned;
  if (kind !== 'int') {
    const lastSep = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
    if (lastSep >= 0 && cleaned.length - lastSep <= 3) {
      normalized = `${cleaned.slice(0, lastSep).replace(/[.,]/g, '')}.${cleaned.slice(lastSep + 1)}`;
    }
  }
  // «a/b» и «a-b»: значение — правое число пары (итог или верхняя граница)
  const pair = /(\d[\d.,]*)[/-](\d[\d.,]*)$/.exec(normalized);
  if (pair) normalized = pair[2];
  const value = Number(normalized.replace(/[.,]/g, ''));
  const result = kind === 'int' ? value : Number(normalized);
  if (!Number.isFinite(result)) return null;
  if (kind === 'int') return Math.round(result);
  return Math.round(result * 100) / 100;
}

/**
 * Насколько похожи два текста (0…1). Нужна потому, что распознаватель ошибается в буквах:
 * на замерах «Физическая атака» приходит как «Фвическая атака» или «Фувическая атака».
 *
 * Сравниваются «скелеты» строк — без гласных и повторяющихся букв. Так «фвическая» и «физическая»
 * дают близкие скелеты, а разные характеристики («атака» и «защита») остаются далёкими.
 */
export function labelSimilarity(a, b) {
  const skel = (t) => normalizeLabel(t)
    .replace(/[^а-яёa-z0-9]/g, '')
    .replace(/[оеаиуыэюяё]/g, '')      // гласные распознаются хуже всего
    .replace(/(.)\1+/g, '$1');          // повторы букв — тоже частая ошибка
  const sa = skel(a);
  const sb = skel(b);
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  // Общая часть в процентах от длины более короткого скелета
  let same = 0;
  const common = Math.min(sa.length, sb.length);
  for (let i = 0; i < common; i++) if (sa[i] === sb[i]) same++;
  return same / Math.max(sa.length, sb.length);
}

/**
 * Отделяет значение от подписи, если распознаватель слил их в одну строку.
 * На реальных снимках встречается и «Здоровье 42 350», и «Меткость: 1 512».
 * @returns {{ label: string, value: string | null }}
 */
export function splitLabelAndValue(text) {
  const raw = String(text || '').trim();
  // Число с разрядами, процентами или дробью в конце строки
  const m = /^(.*?[\p{L})])\s*[:.]?\s*([+-]?\d[\d\s.,]*(?:%)?)$/u.exec(raw);
  if (!m) return { label: raw, value: null };
  const label = m[1].trim();
  const value = m[2].trim();
  // «0.80» и «12%» — значения; «PvE PA» — часть подписи, а не число
  if (!/\d/.test(value)) return { label: raw, value: null };
  return { label, value };
}

/**
 * Находит характеристику по подписи. Возвращает наиболее подходящее поле или null.
 * Сравнение идёт по «плоскому» тексту: «Здоровье (макс)» и «здоровье макс» — одно и то же.
 * Приоритет: точное совпадение, затем самое длинное совпадение по вхождению — так «боевая сила»
 * не превращается в «сила», а «показатель атаки» не путается с «атакой».
 *
 * Если точного совпадения нет, подпись сравнивается по «скелету» (см. `labelSimilarity`): это ловит
 * опечатки распознавания вида «Фвическая атака» вместо «Физическая атака». Порог подобран так, чтобы
 * «атака» и «защита» не смешивались.
 */
export function matchField(text, fields = STAT_FIELDS) {
  const t = normalizeLabel(text);
  if (!t) return null;
  /** @type {{ field: StatField, score: number } | null} */
  let best = null;
  for (const field of fields) {
    const aliases = [field.label, ...(field.aliases || [])].map(normalizeLabel).filter(Boolean);
    for (const alias of aliases) {
      const exact = t === alias;
      const contains = !exact && (t.startsWith(alias) || t.endsWith(alias) || t.includes(alias));
      if (!exact && !contains) continue;
      const score = (exact ? 1000 : 0) + alias.length;
      if (!best || score > best.score) best = { field, score };
    }
  }
  if (best) return best.field;

  // Точного совпадения нет: пробуем по «скелету», но только для достаточно длинных подписей —
  // короткие слова («сила», «меткость») слишком легко спутать.
  for (const field of fields) {
    const aliases = [field.label, ...(field.aliases || [])].map(normalizeLabel).filter(Boolean);
    for (const alias of aliases) {
      if (alias.length < 6) continue;
      const sim = labelSimilarity(t, alias);
      const score = sim * 100;
      if (sim >= 0.75 && (!best || score > best.score)) best = { field, score };
    }
  }
  return best?.field || null;
}

/**
 * Связывает подписи со значениями.
 *
 * Значение ищется в той же строке (вертикальные центры близко) и **правее подписи**.
 * Из подходящих берётся ближайшее по горизонтали. Каждое значение используется один раз.
 *
 * @param {OcrLine[]} lines координаты — доли 0…1
 * @param {{ fields?: StatField[], rowTolerance?: number }} [opts] `rowTolerance` — насколько центры
 *   строк могут разойтись по вертикали, чтобы считаться одной строкой (доля высоты картинки).
 * @returns {Array<{ key: string, label: string, value: number, line: string, confidence: number }>}
 */
export function joinByRow(lines, { fields = STAT_FIELDS, rowTolerance = 0.02 } = {}) {
  const all = (lines || []).filter(l => l && String(l.text || '').trim());
  if (!all.length) return [];

  const centerY = (l) => l.y + (l.h || 0) / 2;
  const out = [];

  // 1. Строки, где подпись и значение слиты в одну («Здоровье 42 350»): берём их сразу,
  //    иначе подпись осталась бы без значения, а число попало бы в общий список кандидатов.
  const merged = [];
  const rest = [];
  for (const line of all) {
    const { label, value } = splitLabelAndValue(line.text);
    const field = label ? matchField(label, fields) : null;
    if (field && value) {
      const num = parseNumber(value, field.kind || 'int');
      if (num !== null) {
        merged.push({ key: field.key, label: field.label, value: num, line: line.text.trim(), confidence: 1 });
        continue;
      }
    }
    rest.push(line);
  }

  /** Кандидаты в значения: строки, где есть число, но нет подписи характеристики. */
  const values = rest
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => parseNumber(line.text) !== null && !matchField(line.text, fields));

  const used = new Set();
  // Сверху вниз: одинаковые подписи разбираются предсказуемо
  const labels = rest.filter(l => matchField(l.text, fields)).sort((a, b) => a.y - b.y);

  for (const label of labels) {
    const field = matchField(label.text, fields);
    if (!field) continue;
    const cy = centerY(label);
    const labelHeight = label.h || rowTolerance;
    const tolerance = Math.max(rowTolerance, labelHeight);
    let bestIdx = -1;
    let bestDx = Infinity;
    for (const { line, idx } of values) {
      if (used.has(idx)) continue;
      // Значение должно быть правее подписи (в двухколоночном окне это отсекает левую колонку)
      const dx = line.x - (label.x + (label.w || 0));
      if (dx < -0.01) continue;
      if (Math.abs(centerY(line) - cy) > tolerance) continue;
      if (dx < bestDx) { bestDx = dx; bestIdx = idx; }
    }
    if (bestIdx < 0) continue;
    const valueLine = values.find(v => v.idx === bestIdx).line;
    const value = parseNumber(valueLine.text, field.kind || 'int');
    if (value === null) continue;
    used.add(bestIdx);
    const dist = Math.abs(centerY(valueLine) - cy);
    out.push({
      key: field.key,
      label: field.label,
      value,
      line: valueLine.text.trim(),
      // Чем точнее строка совпала по вертикали, тем выше уверенность
      confidence: dist <= rowTolerance ? 1 : Math.max(0.4, 1 - dist)
    });
  }
  // Слитные строки идут первыми: их разбор надёжнее, чем сопоставление по координатам.
  // Если характеристика нашлась обоими способами, оставляем слитную (она точнее).
  const byKey = new Map();
  for (const item of [...merged, ...out]) {
    if (!byKey.has(item.key)) byKey.set(item.key, item);
  }
  // Поля с `ignore` служат только «заглушкой» для подписи и в результат не попадают
  const ignored = new Set(fields.filter(f => f.ignore).map(f => f.key));
  return [...byKey.values()].filter(item => !ignored.has(item.key));
}

/**
 * Полный разбор: строки OCR → найденные характеристики.
 * @param {OcrLine[]} lines
 * @returns {{ found: Array<{key: string, label: string, value: number, line: string, confidence: number}>, missed: string[], stats: Record<string, number> }}
 */
export function readStats(lines) {
  const found = joinByRow(lines);
  /** @type {Record<string, number>} */
  const stats = {};
  for (const item of found) stats[item.key] = item.value;
  const missed = STAT_FIELDS.filter(f => !f.ignore && !(f.key in stats)).map(f => f.label);
  return { found, missed, stats };
}

/**
 * Готовые характеристики для формы: распознанное поверх текущих значений.
 * Поля, которые не распознали, не обнуляются — остаётся то, что было.
 * @param {Record<string, number>} current текущие характеристики персонажа
 * @param {Array<{key: string, value: number}>} found распознанные значения
 */
export function mergeStats(current, found) {
  const out = { ...DEFAULT_STATS, ...(current || {}) };
  for (const item of found || []) {
    if (!item || !(item.key in out)) continue;
    out[item.key] = item.value;
  }
  return out;
}

/** Короткая сводка для интерфейса: «Распознано 6 характеристик, не найдено: 21». */
export function readSummary(found, missed) {
  const n = (found || []).length;
  const m = (missed || []).length;
  const mod100 = n % 100;
  const mod10 = n % 10;
  const word = mod100 > 10 && mod100 < 20 ? 'характеристик'
    : mod10 === 1 ? 'характеристика'
      : mod10 >= 2 && mod10 <= 4 ? 'характеристики'
        : 'характеристик';
  return n
    ? `Распознано ${n} ${word}${m ? `, не найдено: ${m}` : ''}`
    : 'Характеристики на скриншоте не распознаны';
}

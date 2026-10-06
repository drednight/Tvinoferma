// Разбор скриншота окна характеристик (js/modules/characters/statsOcr.js).
//
// Координаты в тестах — доли 0…1, как их отдаёт Rust. Раскладка взята из настоящего снимка окна
// характеристик: подписи стоят колонкой слева (x ≈ 0.03), значения — справа (x ≈ 0.6), и распознаватель
// возвращает их отдельными строками. В одном из тестов порядок строк намеренно перепутан так, как это
// делает настоящий OCR: сначала все подписи, потом все значения.
import { describe, it, expect } from 'vitest';

import {
  STAT_FIELDS, normalizeLabel, parseNumber, matchField, joinByRow, readStats, mergeStats, readSummary,
  labelSimilarity, splitLabelAndValue
} from '../js/modules/characters/statsOcr.js';

/** Строка OCR: текст и место на картинке (доли 0…1). */
const line = (text, x, y, w = 0.2, h = 0.02) => ({ text, x, y, w, h });

describe('распознавание подписей', () => {
  it('узнаёт подпись по точному названию и по псевдониму', () => {
    expect(matchField('Здоровье')?.key).toBe('hp');
    expect(matchField('Маг. энергия')?.key).toBe('mp');
    expect(matchField('Бонус к уровню')?.key).toBe('levelBonus');
    expect(matchField('Физическая атака')?.key).toBe('physAttack');
    expect(matchField('Показатель атаки')?.key).toBe('pa');
  });

  it('длинное название важнее короткого: «боевая сила» не превращается в «сила»', () => {
    expect(matchField('Боевая сила')?.key).toBe('power');
    expect(matchField('Сила')?.key).toBe('strength');
  });

  it('«Боевая сила» не переносится в характеристики и не подменяет «Силу»', () => {
    const res = readStats([
      line('Сила', 0.03, 0.10, 0.2), line('1 500', 0.62, 0.10, 0.15),
      line('Боевая сила', 0.03, 0.15, 0.2), line('99 999', 0.62, 0.15, 0.15)
    ]);
    expect(res.stats).toEqual({ strength: 1500 });
    expect(res.missed).not.toContain('Сила (боевая)');
  });

  it('«показатель атаки» не путается с «атакой»', () => {
    expect(matchField('Показатель атаки')?.key).toBe('pa');
    expect(matchField('Магическая атака')?.key).toBe('magAttack');
  });

  it('посторонний текст подписью не считается', () => {
    expect(matchField('Окно персонажа')).toBeNull();
    expect(matchField('')).toBeNull();
    expect(matchField('42 350')).toBeNull();
  });

  it('знаки и регистр не мешают', () => {
    expect(normalizeLabel('  Здоровье:  ')).toBe('здоровье');
    expect(matchField('ЗДОРОВЬЕ:')?.key).toBe('hp');
  });
});

describe('подписи с ошибками распознавания', () => {
  // Наблюдаемые искажения подписей при мелком шрифте: буквы внутри слова распознаются неверно
  it.each([
    ['Фвическая атака', 'physAttack'],
    ['Фувическая атака', 'physAttack'],
    ['Фвическая защита', 'physDefense'],
    ['Здоровье', 'hp'],
    ['Скорость атаки', 'atkSpeed'],
    ['Магическая атака', 'magAttack'],
    ['Показатель защиты', 'pz'],
    ['Меткость', 'accuracy']
  ])('«%s» узнаётся как %s', (text, key) => {
    expect(matchField(text)?.key).toBe(key);
  });

  it('похожие характеристики не путаются между собой', () => {
    // «атака» и «защита» отличаются одной буквой в скелете — их нельзя смешивать
    expect(matchField('Физическая атака')?.key).toBe('physAttack');
    expect(matchField('Физическая защита')?.key).toBe('physDefense');
    expect(matchField('Магическая атака')?.key).toBe('magAttack');
    expect(matchField('Магическая защита')?.key).toBe('magDefense');
  });

  it('короткие слова не подбираются по похожести: слишком легко ошибиться', () => {
    // «сила» и «мила» одинаковой длины — по скелету их не различить, поэтому точное совпадение
    expect(matchField('мила')).toBeNull();
    expect(matchField('Сила')?.key).toBe('strength');
  });

  it('посторонний текст по-прежнему не подпись', () => {
    expect(matchField('Окно персонажа')).toBeNull();
    expect(matchField('42 350')).toBeNull();
  });

  it('похожесть считается по скелету строки', () => {
    expect(labelSimilarity('Физическая атака', 'Фвическая атака')).toBeGreaterThan(0.75);
    expect(labelSimilarity('Физическая атака', 'Магическая защита')).toBeLessThan(0.75);
    expect(labelSimilarity('', '')).toBe(0);
  });
});

describe('подпись и значение в одной строке', () => {
  it('разделяет «Здоровье 42 350» и «Меткость: 1 512»', () => {
    expect(splitLabelAndValue('Здоровье 42 350')).toEqual({ label: 'Здоровье', value: '42 350' });
    expect(splitLabelAndValue('Меткость: 1 512')).toEqual({ label: 'Меткость', value: '1 512' });
    expect(splitLabelAndValue('Крит. урон 250%')).toEqual({ label: 'Крит. урон', value: '250%' });
  });

  it('строка без числа остаётся подписью целиком', () => {
    expect(splitLabelAndValue('Показатель атаки')).toEqual({ label: 'Показатель атаки', value: null });
  });

  it('слитная строка разбирается даже без второй колонки', () => {
    const res = readStats([
      line('Здоровье 42 350', 0.03, 0.10, 0.5),
      line('Меткость: 1 512', 0.03, 0.15, 0.5)
    ]);
    expect(res.stats).toEqual({ hp: 42350, accuracy: 1512 });
  });

  it('слитная строка не мешает разбору двух колонок', () => {
    const res = readStats([
      line('Здоровье 42 350', 0.03, 0.10, 0.5),
      line('Физическая атака', 0.03, 0.15, 0.25),
      line('1 245', 0.62, 0.15, 0.15)
    ]);
    expect(res.stats).toEqual({ hp: 42350, physAttack: 1245 });
  });
});

describe('чтение чисел', () => {  it('разряды через пробел, неразрывный пробел и точку', () => {
    expect(parseNumber('42 350')).toBe(42350);
    expect(parseNumber('42\u00a0350')).toBe(42350);
    expect(parseNumber('1.245')).toBe(1245);
    expect(parseNumber('2 105')).toBe(2105);
  });

  it('пара «текущее/макс» и диапазон: берётся правое число', () => {
    // «96587/96587» — берём число после «/»; «155668-166963» — после «-»
    expect(parseNumber('96587/96587')).toBe(96587);
    expect(parseNumber('155668-166963')).toBe(166963);
    expect(parseNumber('42 350 / 47 900')).toBe(47900);
    // одиночный «-» перед числом — знак, не диапазон
    expect(parseNumber('-350')).toBe(-350);
  });

  it('проценты и знаки вокруг числа', () => {
    expect(parseNumber('12%')).toBe(12);
    expect(parseNumber('250%')).toBe(250);
    expect(parseNumber('+350')).toBe(350);
  });

  it('дробные значения читаются только там, где дробь уместна', () => {
    expect(parseNumber('0.80', 'decimal')).toBe(0.8);
    expect(parseNumber('0,80', 'decimal')).toBe(0.8);
    expect(parseNumber('1.5', 'percent')).toBe(1.5);
    // у целых характеристик точка — разделитель разрядов
    expect(parseNumber('1.245', 'int')).toBe(1245);
  });

  it('без числа возвращается null', () => {
    expect(parseNumber('Здоровье')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('%')).toBeNull();
  });

  it('искажение OCR «з 680» всё равно читается как число', () => {
    // В потоке символов буква вместо цифры: число берём из цифр, которые распознались
    expect(parseNumber('з 680')).toBe(680);
  });
});

describe('сопоставление подписи и значения', () => {
  // Раскладка как в настоящем окне: подписи слева, значения справа, строки по вертикали совпадают
  const pairs = (items) => items.flatMap(([label, value], i) => {
    const y = 0.1 + i * 0.05;
    return [line(label, 0.03, y, 0.25), line(value, 0.62, y, 0.15)];
  });

  it('находит значения для подписей по строке', () => {
    const found = joinByRow(pairs([
      ['Здоровье', '42 350'],
      ['Физическая атака', '1 245'],
      ['Меткость', '1 512']
    ]));
    const byKey = Object.fromEntries(found.map(f => [f.key, f.value]));
    expect(byKey).toEqual({ hp: 42350, physAttack: 1245, accuracy: 1512 });
    expect(found.every(f => f.confidence === 1)).toBe(true);
  });

  it('порядок строк от OCR не важен: подписи и значения могут идти блоками', () => {
    // Именно так ведёт себя настоящий OCR: сначала все подписи, потом все значения
    const lines = [
      line('Здоровье', 0.03, 0.10, 0.25),
      line('Физическая атака', 0.03, 0.15, 0.25),
      line('Меткость', 0.03, 0.20, 0.25),
      line('42 350', 0.62, 0.10, 0.15),
      line('1 245', 0.62, 0.15, 0.15),
      line('1 512', 0.62, 0.20, 0.15)
    ];
    const byKey = Object.fromEntries(joinByRow(lines).map(f => [f.key, f.value]));
    expect(byKey).toEqual({ hp: 42350, physAttack: 1245, accuracy: 1512 });
  });

  it('значение из другой строки не подставляется', () => {
    const found = joinByRow([
      line('Здоровье (макс)', 0.03, 0.10, 0.25),
      line('1 245', 0.62, 0.40, 0.15)   // далеко по вертикали
    ]);
    expect(found).toHaveLength(0);
  });

  it('значение левее подписи не берётся: так не путаются две колонки окна', () => {
    const found = joinByRow([
      line('Здоровье', 0.55, 0.10, 0.25),
      line('42 350', 0.05, 0.10, 0.15)   // слева, из левой колонки окна
    ]);
    expect(found).toHaveLength(0);
  });

  it('одно значение не достаётся двум подписям', () => {
    const found = joinByRow([
      line('Меткость', 0.03, 0.10, 0.25),
      line('Уклонение', 0.03, 0.11, 0.25),
      line('760', 0.62, 0.105, 0.15)
    ]);
    expect(found).toHaveLength(1);
    expect(['accuracy', 'evasion']).toContain(found[0].key);
  });

  it('подпись без значения пропускается', () => {
    const found = joinByRow([
      line('Меткость', 0.03, 0.10, 0.25),
      line('Здоровье', 0.03, 0.15, 0.25),
      line('42 350', 0.62, 0.15, 0.15)
    ]);
    expect(found.map(f => f.key)).toEqual(['hp']);
  });

  it('пустой ввод не ломает разбор', () => {
    expect(joinByRow([])).toEqual([]);
    expect(joinByRow(null)).toEqual([]);
    expect(joinByRow([null, { text: '' }])).toEqual([]);
  });
});

describe('полный разбор скриншота', () => {
  it('возвращает найденное, непонятое и готовые характеристики', () => {
    const lines = [
      line('Здоровье', 0.03, 0.10, 0.25),
      line('42 350', 0.62, 0.10, 0.15),
      line('Скорость атаки', 0.03, 0.15, 0.25),
      line('0.80', 0.62, 0.15, 0.15),
      line('Шанс крит. удара', 0.03, 0.20, 0.25),
      line('12%', 0.62, 0.20, 0.15)
    ];
    const res = readStats(lines);
    expect(res.stats).toEqual({ hp: 42350, atkSpeed: 0.8, critChance: 12 });
    expect(res.missed).toHaveLength(STAT_FIELDS.length - 3);
    expect(res.missed).toContain('Меткость');
  });

  it('искажённое значение всё равно попадает в разбор', () => {
    // Наблюдаемое искажение: «3 680» распознано как «з 680»
    const res = readStats([
      line('Физическая защита', 0.03, 0.10, 0.25),
      line('з 680', 0.62, 0.10, 0.15)
    ]);
    expect(res.stats.physDefense).toBe(680);
  });
});

describe('перенос в форму персонажа', () => {
  it('распознанное перекрывает текущее, остальное сохраняется', () => {
    const current = { hp: 100, accuracy: 500, pa: 1 };
    const merged = mergeStats(current, [{ key: 'hp', value: 42350 }]);
    expect(merged.hp).toBe(42350);
    expect(merged.accuracy).toBe(500);   // не распознали — не обнуляем
    expect(merged.pa).toBe(1);
  });

  it('неизвестные ключи игнорируются, пустой список ничего не меняет', () => {
    const merged = mergeStats({ hp: 5 }, [{ key: 'нетТакого', value: 1 }]);
    expect(merged.hp).toBe(5);
    expect(merged).not.toHaveProperty('нетТакого');
    expect(mergeStats({ hp: 5 }, [])).toMatchObject({ hp: 5 });
    expect(mergeStats({ hp: 5 }, null)).toMatchObject({ hp: 5 });
  });

  it('сводка склоняет слова и сообщает о пустом результате', () => {
    expect(readSummary([{ key: 'a' }], ['b'])).toBe('Распознано 1 характеристика, не найдено: 1');
    expect(readSummary([{ key: 'a' }, { key: 'b' }], [])).toBe('Распознано 2 характеристики');
    expect(readSummary([{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }, { key: 'e' }], [])).toContain('5 характеристик');
    expect(readSummary([], ['x'])).toBe('Характеристики на скриншоте не распознаны');
  });
});

import { describe, it, expect } from 'vitest';
import { launchStageSummary, stageSec } from '../js/modules/launcher/launch.js';

// Разбивка времени по этапам — ответ на вопрос «долго запускается»:
// без неё пользователь не знает, что именно тормозит, и настройку подобрать нечем.
describe('итог запуска по этапам', () => {
  it('секунды округляются до десятых и не показывают нули у целых чисел', () => {
    expect(stageSec(4500)).toBe('4.5 с');
    expect(stageSec(12000)).toBe('12 с');
    expect(stageSec(300)).toBe('0.3 с');
    expect(stageSec(0)).toBe('0 с');
  });

  it('итог собирается из этапов: закрытие, запись входа, ожидание окна, паузы', () => {
    const text = launchStageSummary({
      gcClose: 2100, account: 120, clientWait: 15400, delay: 9000, total: 26620
    });
    expect(text).toBe('Итого 26.6 с: закрытие GameCenter 2.1 с, запись входа в GameCenter.ini 0.1 с, ожидание окна игры 15.4 с, пауза между запусками 9 с.');
  });

  it('нулевые этапы не показываются: иначе строка засоряется нолями', () => {
    const text = launchStageSummary({ gcClose: 0, account: 0, clientWait: 5000, delay: 0, total: 5000 });
    expect(text).toBe('Итого 5 с: ожидание окна игры 5 с.');
    expect(text).not.toContain('пауза');
    expect(text).not.toContain('закрытие');
  });

  it('без замеров строка не появляется вовсе', () => {
    expect(launchStageSummary(null)).toBeNull();
    expect(launchStageSummary({ gcClose: 0, account: 0, clientWait: 0, delay: 0, total: 0 })).toBeNull();
  });

  it('время ожидания окна игры видно отдельной строкой: это обычно и есть причина', () => {
    // Пользователю нужен ответ «где тормозит», поэтому самый долгий этап должен быть виден
    const text = launchStageSummary({ gcClose: 100, account: 50, clientWait: 30000, delay: 0, total: 30150 });
    expect(text).toContain('ожидание окна игры 30 с');
  });
});
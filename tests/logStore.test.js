// Хранилище журналов (js/core/logStore.js): журнал не растёт бесконечно, но и не теряется.
//
// Регрессия, ради которой модуль и написан: `writeJson` в пяти журналах гасил
// `QuotaExceededError` пустым `catch`. LocalStorage общий на все журналы, и при заполнении
// новая запись просто не писалась — без ошибки. После перезапуска её действительно не было,
// и это выглядело как «логи удаляются».
import { describe, it, expect, beforeEach } from 'vitest';
import { readLog, writeLogBounded, pushLog, clearLog } from '../js/core/logStore.js';

const KEY = 'tf_test_log';

/** localStorage, который начинает отказывать после заданного числа записей. */
function storageWithQuota(limitBytes) {
  const used = new Map();
  return {
    getItem: (k) => (used.has(k) ? used.get(k) : null),
    setItem(k, v) {
      const bytes = [...used].filter(([key]) => key !== k).reduce((n, [, val]) => n + val.length, 0) + v.length;
      if (bytes > limitBytes) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      used.set(k, v);
    },
    removeItem: (k) => used.delete(k),
    get size() { return used.size; }
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('журнал: чтение', () => {
  it('пустое хранилище даёт пустой журнал, а не ошибку', () => {
    expect(readLog(KEY)).toEqual([]);
    expect(readLog(KEY, 'запасное')).toBe('запасное');
  });

  it('битое содержимое не роняет чтение', () => {
    window.localStorage.setItem(KEY, '{не json');
    expect(readLog(KEY)).toEqual([]);
  });
});

describe('журнал: запись без переполнения', () => {
  it('запись ложится и читается обратно', () => {
    writeLogBounded(KEY, [{ id: 1 }, { id: 2 }]);
    expect(readLog(KEY)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('очистка убирает журнал целиком', () => {
    writeLogBounded(KEY, [{ id: 1 }]);
    clearLog(KEY);
    expect(readLog(KEY)).toEqual([]);
  });
});

describe('журнал: переполнение хранилища', () => {
  it('не хватило места — вытесняются самые старые, а свежая запись остаётся', () => {
    // Места хватает на пару записей. Пишем много раз: в какой-то момент места перестанет
    // хватать, и важно, что при этом происходит.
    const small = storageWithQuota(400);
    const backup = window.localStorage;
    Object.defineProperty(window, 'localStorage', { value: small, configurable: true });
    try {
      for (let i = 0; i < 8; i++) {
        writeLogBounded(KEY, [{ id: `запись${i}`, payload: 'x'.repeat(90) }, ...readLog(KEY)]);
      }
      const log = readLog(KEY);
      // Самая свежая запись на месте — именно её и ждали, и не молча пропала
      expect(log[0].id).toBe('запись7');
      // Хвост обрезан вместо потери записи: журнал ужался, но не опустел и не помещается в лимит
      expect(log.length).toBeGreaterThan(0);
      expect(log.length).toBeLessThan(8);
    } finally {
      Object.defineProperty(window, 'localStorage', { value: backup, configurable: true });
    }
  });

  it('место кончилось совсем — запись не должна приводить к исключению', () => {
    const tiny = storageWithQuota(10);
    const backup = window.localStorage;
    Object.defineProperty(window, 'localStorage', { value: tiny, configurable: true });
    try {
      expect(() => writeLogBounded(KEY, [{ id: 'a' }, { id: 'b' }])).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', { value: backup, configurable: true });
    }
  });

  it('ошибка не из-за квоты не маскируется под успешную запись', () => {
    const broken = {
      getItem: () => null,
      setItem() { const e = new Error('сломан'); e.name = 'UnknownError'; throw e; },
      removeItem: () => {}
    };
    const backup = window.localStorage;
    Object.defineProperty(window, 'localStorage', { value: broken, configurable: true });
    try {
      expect(writeLogBounded(KEY, [{ id: 'a' }])).toBe(false);
    } finally {
      Object.defineProperty(window, 'localStorage', { value: backup, configurable: true });
    }
  });
});

describe('журнал: добавление записи', () => {
  it('новые сверху, лимит соблюдается, старые вытесняются', () => {
    for (let i = 0; i < 6; i++) pushLog(KEY, { i }, 3);
    const log = readLog(KEY);
    expect(log.map((e) => e.i)).toEqual([5, 4, 3]);
  });

  it('пустое хранилище и битая запись не ломают добавление', () => {
    expect(pushLog(KEY, { i: 1 }, 3)[0]).toEqual({ i: 1 });
    window.localStorage.setItem(KEY, 'не массив');
    expect(pushLog(KEY, { i: 2 }, 3)[0]).toEqual({ i: 2 });
  });

  it('лимит меньше единицы всё равно оставляет хоть одну запись', () => {
    expect(pushLog(KEY, { i: 1 }, 0)).toHaveLength(1);
  });
});

describe('журналы приложения пишутся через logStore', () => {
  // Регрессия против возврата к `writeJson`: в журналах молча гасилась квота, и новые
  // записи пропадали, а это и выглядело как «логи удаляются при перезапуске».
  const modules = {
    'js/modules/launcher/launchLog.js': 'recordLaunchRun',
    'js/modules/automation/transferStore.js': 'recordTransfer',
    'js/modules/automation/shopStore.js': 'recordShopRow',
    'js/modules/automation/collectionStore.js': 'recordCollectionReports',
    'js/core/taskLog.js': 'saveJournal'
  };
  for (const file of Object.keys(modules)) {
    it(`${file} пишет журнал через writeLogBounded`, async () => {
      const fs = await import('node:fs');
      const source = fs.readFileSync(file, 'utf8');
      // Ни одна запись журнала не должна идти через writeJson: он квоту глушит
      expect(source.split('\n').filter((l) => /writeJson\(\s*(LOG_KEY|STORAGE_KEY)/.test(l))).toHaveLength(0);
      expect(source).toContain('writeLogBounded(');
    });
  }

  it('панель журналов показывает историю по умолчанию', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync('js/core/logHub.js', 'utf8');
    expect(source).toMatch(/mountLogHub[\s\S]{0,120}sessionOnly = false/);
    expect(source).toMatch(/logHubSummary[\s\S]{0,80}sessionOnly = false/);
  });
});
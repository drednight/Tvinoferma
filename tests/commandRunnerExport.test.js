// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandRunner } from '../js/core/commandRunner.js';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('экспорт из командной палитры', () => {
  it('использует общую кнопку настроек и её предупреждение вместо отдельного чтения файла', async () => {
    document.body.innerHTML = '<button id="export-all-btn">Экспорт</button>';
    const switchTab = vi.fn();
    const onClick = vi.fn();
    document.getElementById('export-all-btn').addEventListener('click', onClick);
    await createCommandRunner({ switchTab })('export');
    expect(switchTab).toHaveBeenCalledWith('settings');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('не экспортирует молча, если кнопка недоступна', async () => {
    document.body.innerHTML = '<div id="toast-root"></div>';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await createCommandRunner({ switchTab: vi.fn() })('export');
    expect(document.body.textContent).toContain('Кнопка экспорта недоступна');
  });
});

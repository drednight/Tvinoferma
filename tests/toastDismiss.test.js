import { expect, it, vi } from 'vitest';
import { toast } from '../js/core/ui.js';
it('allows dismissing a warning immediately and removes it automatically after the duration', () => {
  vi.useFakeTimers();
  try {
    document.body.innerHTML = '<div id="toast-root"></div>';
    toast('Слияние остановлено', 'warning', 8000);
    document.querySelector('[aria-label="Закрыть уведомление"]').click();
    expect(document.querySelector('.toast')).toBeNull();
    toast('Слияние остановлено', 'warning', 8000);
    vi.advanceTimersByTime(8301);
    expect(document.querySelector('.toast')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

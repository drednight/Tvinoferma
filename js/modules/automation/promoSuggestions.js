import { state } from '../../core/state.js';
import { loadLog } from './promoLog.js';
import { parseCodes } from './promoCore.js';
import { promoDiscovery, promoCoverage } from './promoDiscovery.js';

export function renderPromoSuggestions(dlg) {
  const field = dlg.body.querySelector('#promo-code')?.parentElement;
  if (!field) return;
  field.querySelector('[data-promo-discovery]')?.remove();
  const section = document.createElement('section');
  section.dataset.promoDiscovery = '';
  const service = promoDiscovery(),
    cache = service.snapshot();
  const label = document.createElement('p');
  label.className = 'muted';
  label.textContent =
    cache.status === 'checking'
      ? `Новости: проверено ${cache.checked} из ${cache.total || '…'}`
      : cache.status === 'partial'
        ? 'Новости проверены не полностью. Ранее найденные коды сохранены.'
        : cache.lastCompleteAt
          ? `Новости проверены ${new Date(cache.lastCompleteAt).toLocaleString('ru-RU')} · ${(cache.durationMs / 1000).toFixed(1)} с`
          : 'Промокоды из двух последних страниц новостей. Проверка фоновая, не чаще раза в сутки.';
  if (cache.errors?.length) label.textContent += ' Причины: ' + cache.errors.join(', ');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'btn ghost small';
  refresh.textContent = 'Проверить новости сейчас';
  refresh.disabled = cache.status === 'checking' || !window.__TAURI_INTERNALS__;
  refresh.onclick = () => {
    void service.check({ force: true });
  };
  section.append(label, refresh);
  for (const row of promoCoverage(cache.codes, state.characters, loadLog())) {
    const card = document.createElement('div');
    card.className = 'promo-news-option';
    const title = document.createElement('b');
    title.textContent = row.code;
    const info = document.createElement('small');
    info.textContent = `${row.expiresText || 'Срок в новости не найден'} · нет подтверждения ввода в местном журнале: ${row.remaining} из ${state.characters.length}`;
    const source = document.createElement('span');
    source.textContent = row.title;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn secondary small';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
    add.disabled = !!row.expiresOn && row.expiresOn < today;
    add.textContent = add.disabled ? 'Срок из новости истёк' : 'Добавить код';
    add.onclick = () => {
      const input = dlg.body.querySelector('#promo-code');
      if (!input) return;
      const parsed = parseCodes(input.value);
      if (!parsed.codes.some(c => c.toUpperCase() === row.code) && parsed.codes.length < 10) {
        input.value = [input.value.trim(), row.code].filter(Boolean).join('\n');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    card.append(title, source, info, add);
    section.append(card);
  }
  if (cache.status === 'checked' && !cache.codes.length) {
    const p = document.createElement('p');
    p.textContent = 'На проверенных страницах ссылок активации промокодов не найдено.';
    section.append(p);
  }
  field.append(section);
}
export function bindPromoSuggestions(dlg) {
  const update = () => {
    if (dlg.el.isConnected) renderPromoSuggestions(dlg);
  };
  window.addEventListener('tf-promo-news-changed', update);
  const close = dlg.close;
  dlg.close = () => {
    window.removeEventListener('tf-promo-news-changed', update);
    close();
  };
  if (window.__TAURI_INTERNALS__) void promoDiscovery().check();
}

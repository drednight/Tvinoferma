import { dockCurrentTask, onTaskChange } from '../../core/taskLog.js';
import { state } from '../../core/state.js';
import { loadLog } from './promoLog.js';
import { parseCodes } from './promoCore.js';
import { promoDiscovery, promoCoverage } from './promoDiscovery.js';

let viewerRequested = false;
const closeViewer = async () => {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('close_promo_news_article');
};
// Discovery stays parallel. Only an owned modal article must not obscure Stop.
const unsubscribe = onTaskChange(() => {
  const active = !!dockCurrentTask();
  document.querySelectorAll('[data-promo-news-open]').forEach(button => {
    button.disabled = active || !window.__TAURI_INTERNALS__;
  });
  if (active && viewerRequested) {
    viewerRequested = false;
    void closeViewer().catch(() => {});
  }
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

export function renderPromoSuggestions(dlg) {
  const field = dlg.body.querySelector('#promo-code')?.parentElement;
  if (!field) return;
  const previous = field.querySelector('[data-promo-discovery]');
  const expanded = previous?.open === true;
  previous?.remove();
  const section = document.createElement('details');
  section.open = expanded;
  section.dataset.promoDiscovery = '';
  const service = promoDiscovery(),
    cache = service.snapshot();
  const visible = cache.codes.filter(c => !cache.hiddenCodes?.includes(c.code));
  const heading = document.createElement('summary');
  heading.textContent =
    cache.status === 'checking'
      ? 'Проверка новостей…'
      : cache.status === 'partial'
        ? `Новости: проверка не завершена${cache.errors?.includes('news_http_403') ? ' (HTTP 403)' : ''}`
        : `Промокоды из новостей: ${visible.length}`;
  section.append(heading);
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
  if (cache.errors?.includes('news_http_403'))
    label.textContent += ' Сайт отказал в доступе (HTTP 403); это не означает, что кодов нет.';
  if (cache.errors?.includes('news_challenge'))
    label.textContent += ' Сайт требует проверку безопасности. Автоматического обхода защиты нет.';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn ghost small';
  open.textContent = 'Открыть новости в браузере';
  open.disabled = !window.__TAURI_INTERNALS__;
  open.onclick = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open('https://pwonline.ru/news.php');
    } catch {
      label.textContent = 'Не удалось открыть браузер. Адрес: https://pwonline.ru/news.php';
    }
  };
  const newsActions = document.createElement('div');
  newsActions.className = 'promo-news-actions';
  newsActions.append(refresh, open);
  section.append(label, newsActions);
  for (const row of promoCoverage(visible, state.characters, loadLog())) {
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
    add.textContent = '+';
    add.title = add.disabled ? 'Срок из новости истёк' : 'Добавить промокод';
    add.setAttribute('aria-label', add.title);
    add.onclick = () => {
      const input = dlg.body.querySelector('#promo-code');
      if (!input) return;
      const parsed = parseCodes(input.value);
      if (!parsed.codes.some(c => c.toUpperCase() === row.code) && parsed.codes.length < 10) {
        input.value = [input.value.trim(), row.code].filter(Boolean).join('\n');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    const server = document.createElement('small');
    server.textContent = row.serverRestriction
      ? `Только сервер «${row.serverRestriction}»`
      : 'Ограничение по серверу в новости не найдено — проверьте источник';
    const rewards = document.createElement('details');
    const caption = document.createElement('summary');
    caption.textContent = `Содержимое промокода (${row.rewards?.length || 0})`;
    rewards.append(caption);
    if (row.rewards?.length) {
      const list = document.createElement('ul');
      for (const name of row.rewards) {
        const item = document.createElement('li');
        item.textContent = name;
        list.append(item);
      }
      rewards.append(list);
    } else {
      rewards.append('Список предметов не распознан — откройте новость.');
    }
    const browser = document.createElement('button');
    browser.type = 'button';
    browser.className = 'btn ghost small';
    browser.textContent = '↗';
    browser.title = 'Открыть статью';
    browser.setAttribute('aria-label', browser.title);
    browser.dataset.promoNewsOpen = '';
    browser.disabled = !window.__TAURI_INTERNALS__ || !!dockCurrentTask();
    browser.title =
      'Окно источника доступно, когда скрипт не выполняется, чтобы кнопка Стоп оставалась доступна. Поиск новостей продолжается фоном.';
    browser.onclick = async () => {
      if (dockCurrentTask()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const id = new URL(row.sourceUrl).searchParams.get('article');
        if (!/^\d{1,12}$/.test(id || '')) throw Error();
        viewerRequested = true;
        await invoke('open_promo_news_article', { article: id });
        if (dockCurrentTask()) {
          viewerRequested = false;
          await closeViewer();
        }
      } catch {
        viewerRequested = false;
        info.textContent = 'Не удалось открыть новость в WebView.';
      }
    };
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'btn ghost small';
    hide.textContent = '⊘';
    hide.title = 'Скрыть промокод';
    hide.setAttribute('aria-label', hide.title);
    hide.onclick = () => service.setHidden(row.code);
    const actions = document.createElement('div');
    actions.className = 'promo-news-actions';
    actions.append(browser, add, hide);
    card.append(title, source, info, server, rewards, actions);
    section.append(card);
  }
  if (cache.status === 'checked' && !cache.codes.length) {
    const p = document.createElement('p');
    p.textContent = 'На проверенных страницах ссылок активации промокодов не найдено.';
    section.append(p);
  }
  if (cache.hiddenCodes?.length) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn ghost small';
    restore.textContent = `Вернуть скрытые промокоды (${cache.hiddenCodes.length})`;
    restore.style.marginTop = '16px';
    restore.onclick = () => service.restoreHidden();
    section.append(restore);
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

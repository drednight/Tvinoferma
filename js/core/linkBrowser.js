// One entry point for ordinary web links. Account OAuth and filesystem actions
// keep their dedicated flows; no credentials are copied or injected here.
import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { toast } from './ui.js';

export function webLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
export function linkProfile(appState = state) {
  const id = appState.settings?.browser?.linkCharacterId;
  const character = appState.characters?.find(c => c.id === id);
  return character ? { charId: character.id, charNick: character.nick } : { charId: null, charNick: null };
}
export function linkProfileOptions(appState = state) {
  const selected = appState.settings?.browser?.linkCharacterId || '';
  return (
    '<option value="">Без персонажа — отдельный профиль</option>' +
    (appState.characters || [])
      .map(
        c => `<option value="${escapeHtml(c.id)}" ${c.id === selected ? 'selected' : ''}>${escapeHtml(c.nick)}</option>`
      )
      .join('') +
    (selected && !appState.characters?.some(c => c.id === selected)
      ? `<option value="${escapeHtml(selected)}" selected>Персонаж недоступен — используется отдельный профиль</option>`
      : '')
  );
}
export async function openWebLink(value) {
  const url = webLink(value);
  if (!url) throw new Error('Допустимы только ссылки http/https без встроенного логина и пароля.');
  if (window.__TAURI_INTERNALS__ && state.settings?.browser?.linkOpenMode === 'system') {
    const { open } = await import('@tauri-apps/plugin-shell');
    return open(url); // OS default browser; never fall back to another profile on error
  }
  if (window.__TAURI_INTERNALS__) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('open_link_browser', { url, ...linkProfile() });
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
let bound = false;
export function bindWebLinks() {
  if (bound) return;
  bound = true;
  const follow = event => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const a = event.target.closest?.('a[href]');
    if (!a || a.hasAttribute('download') || a.hasAttribute('data-system-browser')) return;
    const raw = a.getAttribute('href');
    if (!/^https?:\/\//i.test(raw || '')) return; // local routes and file actions stay local
    event.preventDefault();
    event.stopImmediatePropagation();
    void openWebLink(raw).catch(error => toast(`Не удалось открыть ссылку: ${error.message || error}`, 'warning'));
  };
  document.addEventListener('click', follow, true);
  document.addEventListener('auxclick', follow, true);
}

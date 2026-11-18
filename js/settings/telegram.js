// js/settings/telegram.js
// Настройки Telegram-бота: токен бота хранится в хранилище ОС (как контакты
// персонажей), chat id — в настройках. Отправка идёт через Rust-команду
// `telegram_send_message`, поэтому CSP веб-контента не касается запроса к API.

import { state } from '../core/state.js';
import { isTauri } from '../core/storage.js';
import { toast } from '../core/ui.js';

const BOT_TOKEN_KEY = 'telegram.botToken';

async function invoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

/** Статус в панели: краткая подпись под кнопками отправки. */
function setStatus(text, ok = null) {
  const row = document.getElementById('telegram-status-row');
  const label = document.getElementById('telegram-status-text');
  if (!row || !label) return;
  row.hidden = !text;
  label.textContent = text;
  label.classList.toggle('ok', ok === true);
  label.classList.toggle('err', ok === false);
}

/** Токен в хранилище ОС, не в state.json. Возвращает, задан ли он. */
async function readTokenSaved() {
  if (!isTauri()) return false;
  try {
    const rec = await invoke('secrets_get_many', { keys: [BOT_TOKEN_KEY] });
    return typeof rec?.[BOT_TOKEN_KEY] === 'string' && rec[BOT_TOKEN_KEY].length > 0;
  } catch {
    return false;
  }
}

async function saveToken() {
  const input = document.getElementById('telegram-bot-token');
  const token = input?.value?.trim() || '';
  if (!token) {
    // Пустое значение удаляет запись — очистить токен тоже можно
    await invoke('secrets_delete_many', { keys: [BOT_TOKEN_KEY] });
    input.value = '';
    setStatus('Токен бота удалён.', true);
    toast('Токен бота удалён из хранилища.', 'info');
    return;
  }
  await invoke('secrets_set_many', { items: { [BOT_TOKEN_KEY]: token } });
  input.value = '';
  setStatus('Токен бота сохранён в хранилище ОС (не в файлах приложения).', true);
  toast('Токен бота сохранён в хранилище ОС.', 'success');
}

async function sendMessage({ text, withDiagnostics }) {
  const chatId = String(state.settings?.telegram?.chatId || '').trim();
  if (!isTauri()) {
    setStatus('Отправка работает только в приложении (не в браузере).', false);
    toast('Telegram-отправка доступна только в приложении.', 'warning');
    return;
  }
  if (!chatId) {
    setStatus('Сначала укажите чат для отправки.', false);
    toast('Сначала укажите чат для отправки.', 'warning');
    return;
  }
  setStatus('Отправляю в Telegram…', null);
  try {
    const result = await invoke('telegram_send_message', {
      chatId,
      text,
      withDiagnostics: withDiagnostics === true
    });
    const id = result?.messageId ? ` (id ${result.messageId})` : '';
    setStatus(`Отправлено в чат ${result?.chatId || chatId}${id}.`, true);
    toast('Сообщение отправлено в Telegram.', 'success');
  } catch (error) {
    setStatus(String(error?.message || error), false);
    toast('Telegram: отправка не прошла.', 'error');
  }
}

/** Предложения по оптимизации: диагностика приложения + текст пользователя. */
function suggestionsText(userText) {
  const head = `Предложения по оптимизации приложения\n\n${userText.trim() || '(текст предложений не указан — опишите, что хотите предложить)'}`;
  return head;
}

export function bindTelegramSettings() {
  const tokenInput = document.getElementById('telegram-bot-token');
  const tokenSave = document.getElementById('telegram-token-save');
  const messageInput = document.getElementById('telegram-message');

  // При открытии панели показываем, задан ли уже токен (значение не выведем)
  readTokenSaved().then(saved => {
    setStatus(saved ? 'Токен бота уже сохранён в хранилище ОС.' : 'Токен бота ещё не задан.', saved);
  });

  tokenSave?.addEventListener('click', async () => {
    try {
      await saveToken();
    } catch (error) {
      setStatus(String(error?.message || error), false);
      toast('Не удалось сохранить токен бота.', 'error');
    }
  });

  document.getElementById('telegram-send-test')?.addEventListener('click', () =>
    sendMessage({ text: 'Тестовое сообщение из Tvinoferma: бот и чат настроены.' })
  );

  document.getElementById('telegram-send-message')?.addEventListener('click', () => {
    const text = messageInput?.value?.trim() || '';
    sendMessage({ text: text || '(пустое сообщение)' });
  });

  document.getElementById('telegram-send-suggestions')?.addEventListener('click', () => {
    const text = suggestionsText(messageInput?.value || '');
    sendMessage({ text, withDiagnostics: true });
  });
}

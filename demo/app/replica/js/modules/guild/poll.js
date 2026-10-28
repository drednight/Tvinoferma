// Опрос кланового сайта: безопасный текст со ссылками, нормализация кэша и разметка.
// Сайт подгружает варианты отдельно из handlers/get_poll.php; разбор ответа в окне сайта
// повторяет эту модель в src-tauri/src/scripts/guild.js.
import { escapeHtml as esc } from '../../core/utils.js';

const ID = /^\d{1,12}$/;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT']);

/** Только обычные ссылки, без встроенных учётных данных и исполняемых схем. */
export function safePollLink(value, base) {
  if (!value || String(value).length > 2048) return '';
  try {
    const url = new URL(String(value), base || undefined);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

/** Части сохраняют пробелы между словами и ссылками, но не хранят HTML с сайта. */
function normalizeParts(value) {
  const source = typeof value === 'string' ? [{ text: value }] : Array.isArray(value) ? value : [];
  const parts = source.slice(0, 100).flatMap(part => {
    const text = String(part?.text ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 1000);
    if (!text) return [];
    const href = safePollLink(part?.href);
    return [href ? { text, href } : { text }];
  });
  if (parts.length) {
    parts[0].text = parts[0].text.trimStart();
    parts[parts.length - 1].text = parts[parts.length - 1].text.trimEnd();
  }
  return parts.filter(part => part.text);
}

/** Из DOM берём только текст и безопасные ссылки, не переносим произвольную разметку. */
export function pollTextParts(root) {
  if (!root) return [];
  const parts = [];
  const visit = node => {
    if (node.nodeType === 3) {
      parts.push({ text: node.textContent || '' });
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1 && SKIP_TAGS.has(node.tagName)) return;
    if (node.nodeType === 1 && node.tagName === 'BR') {
      parts.push({ text: ' ' });
      return;
    }
    if (node.nodeType === 1 && node.tagName === 'A') {
      parts.push({
        text: node.textContent || '',
        href: safePollLink(node.getAttribute('href'), node.ownerDocument?.baseURI)
      });
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return normalizeParts(parts);
}

/** Данные из DOM страницы: вариантов там ещё нет, их подгружает API сайта. */
export function parseGuildPoll(document) {
  const root = document.querySelector('#mainPoll');
  const id = String(root?.getAttribute('data-poll-id') || '').trim();
  if (!root || !ID.test(id)) return null;
  return {
    id,
    title: pollTextParts(root.querySelector('.poll__title')),
    type: 'single',
    options: [],
    loadError: false
  };
}

/** Отбрасываем опасные ссылки, некорректные идентификаторы и лишние поля даже из кэша. */
export function normalizeGuildPoll(raw) {
  const id = String(raw?.id ?? '').trim();
  if (!ID.test(id)) return null;
  const seen = new Set();
  const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, 200).flatMap(option => {
    const optionId = String(option?.id ?? '').trim();
    if (!ID.test(optionId) || seen.has(optionId)) return [];
    seen.add(optionId);
    return [{ id: optionId, text: normalizeParts(option.text), selected: option.selected === true }];
  });
  return {
    id,
    title: normalizeParts(raw.title),
    type: raw.type === 'multiple' ? 'multiple' : 'single',
    options,
    loadError: raw.loadError === true
  };
}

/** Разметка без доверенного HTML: ссылки работают в браузере и обрабатываются Tauri. */
export function pollPartsHtml(parts) {
  return normalizeParts(parts)
    .map(part =>
      part.href
        ? `<a href="${esc(part.href)}" target="_blank" rel="noopener noreferrer" data-guild-poll-link>${esc(part.text)}</a>`
        : esc(part.text)
    )
    .join('');
}

/** Никакого блока при отсутствии опроса; форма остаётся видимой при ошибке загрузки. */
export function guildPollHtml(raw) {
  const poll = normalizeGuildPoll(raw);
  if (!poll) return '';
  const multiple = poll.type === 'multiple';
  const options = poll.options
    .map(option => {
      const id = `guild-poll-${poll.id}-${option.id}`;
      return `<label class="guild-poll-option" for="${id}">
        <input id="${id}" type="${multiple ? 'checkbox' : 'radio'}" name="guild-poll-option" value="${option.id}"${option.selected ? ' checked' : ''}>
        <span>${pollPartsHtml(option.text)}</span>
      </label>`;
    })
    .join('');
  const hint = poll.loadError
    ? 'Не удалось загрузить варианты. Обновите сводку клана и проверьте вход на сайт.'
    : !poll.options.length
      ? 'Варианты пока недоступны. Обновите сводку клана.'
      : multiple
        ? 'Можно выбрать несколько вариантов.'
        : 'Выберите один вариант.';
  return `
    <section class="guild-poll" aria-labelledby="guild-poll-title">
      <h3 id="guild-poll-title">Опрос</h3>
      <div class="guild-poll-title">${pollPartsHtml(poll.title) || 'Голосование'}</div>
      <form data-guild-poll data-poll-id="${poll.id}">
        <p class="muted guild-poll-hint">${hint}</p>
        <fieldset class="guild-poll-options" aria-label="Варианты ответа">${options}</fieldset>
        <button class="btn primary small" type="submit"${poll.loadError || !poll.options.length ? ' disabled' : ''}>${poll.options.some(option => option.selected) ? 'Изменить голос' : 'Проголосовать'}</button>
      </form>
    </section>`;
}

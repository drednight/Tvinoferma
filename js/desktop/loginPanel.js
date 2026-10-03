// Панель «Помощник входа» и тулбар навигации (issue #54): скрипт, который рисует сворачиваемую карточку с контактами
// поверх страницы в окне браузера персонажа. Rust вшивает его в окно как initialization_script,
// поэтому панель переживает переходы между страницами (вход через VK Play и возврат).
//
// Защита данных: контакты лежат только в замыкании скрипта (не в глобальных переменных и не в атрибутах),
// разметка — в «closed» shadow DOM, а нужные методы браузера запоминаются до загрузки скриптов сайта.
// Копируется значение только по клику пользователя.

export function panelDataFor(char) {
  const c = char?.contacts || {};
  return {
    nick: char?.nick || '',
    contacts: { email: c.email || '', password: c.password || '', recoveryEmail: c.recoveryEmail || '', phone: c.phone || '' }
  };
}

/**
 * Тело панели. Выполняется в странице сайта, поэтому должна быть самодостаточной:
 * ничего из внешнего модуля внутри неё использовать нельзя (она передаётся строкой через toString).
 * Кнопки действий (Issue #54-2) НЕ вызывают команды приложения: страница только переходит на служебный
 * адрес `tf-panel://<действие>`. Rust перехватывает переход (`on_navigation`), отменяет его и шлёт событие
 * в основное окно; персонаж определяется по окну, а не по странице. Ответ приложение пишет в панель
 * событием `tf-panel-notify` на её host-элементе.
 * @param {{ nick: string, contacts: Record<string, string> }} DATA
 * @param {(url: string) => void} [nav] переход (в тестах подменяется)
 */
export function panelBootstrap(DATA, nav) {
  if (window.top !== window) return;
  const HOST_ID = '__tf_login_panel__';
  const STORE_KEY = '__tf_lp_collapsed';
  const doc = document;
  const create = Document.prototype.createElement;
  const attach = Element.prototype.attachShadow;
  const later = window.setTimeout.bind(window);
  const clip = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText.bind(navigator.clipboard) : null;
  const go = nav || ((url) => { window.location.href = url; });
  const ACTIONS = [
    ['balance', '💰 Баланс', 'Обновить баланс древних монет этого персонажа', false],
    ['parties', '👥 Партии', 'Показать статус партий персонажа', false],
    ['promo', '🎟 Промокод', 'Появится вместе с активацией промокодов (Issue #25)', true]
  ];
  const FIELDS = [
    ['email', 'Email / Логин', false],
    ['password', 'Пароль', true],
    ['recoveryEmail', 'Recovery Email', false],
    ['phone', 'Телефон', false]
  ];
  const CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif}',
    '.card{width:250px;background:#1c1f26;color:#e8e8ea;border:1px solid #3a3f4b;border-left:none;border-radius:0 10px 10px 0;padding:10px;box-shadow:0 4px 18px rgba(0,0,0,.45);font-size:12px}',
    '.tab{background:#1c1f26;color:#e8e8ea;border:1px solid #3a3f4b;border-left:none;border-radius:0 8px 8px 0;padding:10px 6px;cursor:pointer;font-size:12px;writing-mode:vertical-rl}',
    '.head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:8px}',
    '.title{font-weight:700;color:#f0b84a;font-size:13px;word-break:break-word}',
    '.lbl{color:#9aa0ad;font-size:11px;margin-top:6px}',
    '.line{display:flex;gap:4px}',
    '.val{flex:1;min-width:0;background:#262a33;border:1px solid #3a3f4b;border-radius:5px;padding:4px 6px;font-family:Consolas,monospace;word-break:break-all}',
    '.val.clickable{cursor:pointer}',
    '.val.clickable:hover{border-color:#f0b84a}',
    '.val.empty{color:#7c8190;font-style:italic;font-family:inherit}',
    'button{background:#2d323d;color:#e8e8ea;border:1px solid #444a58;border-radius:5px;cursor:pointer;padding:2px 7px;font-size:12px}',
    'button:hover{border-color:#f0b84a}',
    '.acts{display:flex;flex-wrap:wrap;gap:4px;margin-top:10px}',
    'button:disabled{opacity:.45;cursor:not-allowed}',
    '.status{margin-top:6px;padding:4px 6px;background:#262a33;border-radius:5px;color:#b9e6b9;white-space:pre-line;word-break:break-word}',
    'details{margin-top:8px;color:#e6c25a;font-size:11px}',
    'summary{cursor:pointer}'
  ].join('');
  let collapsed = false;
  try { collapsed = window.localStorage.getItem(STORE_KEY) === '1'; } catch (e) { collapsed = false; }
  let revealed = false;
  let status = '';

  const make = (tag, cls, text) => {
    const n = create.call(doc, tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const mount = () => {
    const old = doc.getElementById(HOST_ID);
    if (old) old.remove();
    const host = make('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:90px;left:0;z-index:2147483647;';
    const root = attach.call(host, { mode: 'closed' });
    const style = make('style');
    style.textContent = CSS;
    root.appendChild(style);
    const box = make('div');
    root.appendChild(box);

    const copy = async (value, btn) => {
      let ok = false;
      try { if (clip) { await clip(value); ok = true; } } catch (e) { ok = false; }
      if (!ok) {
        try {
          const ta = make('textarea');
          ta.value = value;
          ta.style.cssText = 'position:fixed;opacity:0;';
          box.appendChild(ta);
          ta.select();
          ok = doc.execCommand('copy');
          ta.remove();
        } catch (e) { ok = false; }
      }
      btn.textContent = ok ? '✔' : '⚠';
      later(() => { btn.textContent = '📋'; }, 900);
    };

    const setCollapsed = (v) => {
      collapsed = v;
      try { window.localStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch (e) { /* не критично */ }
      draw();
    };

    const draw = () => {
      box.textContent = '';
      if (collapsed) {
        const tab = make('button', 'tab', '🔑 Помощник входа');
        tab.title = 'Развернуть';
        tab.addEventListener('click', () => setCollapsed(false));
        box.appendChild(tab);
        return;
      }
      const card = make('div', 'card');
      const head = make('div', 'head');
      head.appendChild(make('div', 'title', '🔑 ' + DATA.nick));
      const min = make('button', '', '–');
      min.title = 'Свернуть';
      min.addEventListener('click', () => setCollapsed(true));
      head.appendChild(min);
      card.appendChild(head);
      FIELDS.forEach((f) => {
        const value = DATA.contacts[f[0]];
        card.appendChild(make('div', 'lbl', f[1]));
        if (!value) { card.appendChild(make('div', 'val empty', 'Не указано')); return; }
        const line = make('div', 'line');
        const val = make('div', 'val clickable', f[2] && !revealed ? '••••••••' : value);
        val.title = 'Нажмите, чтобы скопировать';
        line.appendChild(val);
        if (f[2]) {
          const eye = make('button', '', revealed ? '🙈' : '👁');
          eye.title = 'Показать/скрыть';
          eye.addEventListener('click', () => { revealed = !revealed; draw(); });
          line.appendChild(eye);
        }
        const cp = make('button', '', '📋');
        cp.title = 'Скопировать';
        cp.addEventListener('click', () => copy(value, cp));
        val.addEventListener('click', () => copy(value, cp));
        line.appendChild(cp);
        card.appendChild(line);
      });
      const acts = make('div', 'acts');
      ACTIONS.forEach((a) => {
        const btn = make('button', '', a[1]);
        btn.title = a[2];
        btn.disabled = a[3];
        if (!a[3]) {
          btn.addEventListener('click', () => {
            status = '⏳ Запрос отправлен в приложение…';
            draw();
            go('tf-panel://' + a[0]);
          });
        }
        acts.appendChild(btn);
      });
      card.appendChild(acts);
      if (status) card.appendChild(make('div', 'status', status));
      const hint = make('details');
      hint.appendChild(make('summary', '', 'ℹ️ Если после входа белый экран'));
      hint.appendChild(make('div', '', 'Если после входа через VK Play появился белый экран: 1) закройте это окно браузера; 2) в Tvinoferma нажмите «Проверить авторизацию»; 3) статус должен стать 🟢.'));
      card.appendChild(hint);
      box.appendChild(card);
    };

    // Ответ приложения: только текст (textContent), HTML не разбирается
    host.addEventListener('tf-panel-notify', (e) => {
      status = String((e.detail && e.detail.text) || '').slice(0, 600);
      draw();
    });
    draw();
    (doc.body || doc.documentElement).appendChild(host);
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

/** Разделы сайта для тулбара: [подпись, адрес, путь для подсветки]. Только pwonline.ru, без параметров. */
export const SITE_LINKS = [
  ['🏠', 'https://pwonline.ru/', '/'],
  ['Профиль', 'https://pwonline.ru/usercp.php', '/usercp.php'],
  ['Сундуки', 'https://pwonline.ru/chests2.php', '/chests2.php'],
  ['Марафон', 'https://pwonline.ru/supermarathon.php', '/supermarathon.php'],
  ['Новости', 'https://pwonline.ru/news.php', '/news.php']
];

/**
 * Тулбар навигации (Issue #54-3): компактная плашка внизу по центру окна браузера персонажа.
 * Назад / вперёд / обновить, быстрые ссылки на разделы сайта и домен текущей страницы
 * (видно, что вход идёт на pwonline.ru, а не на посторонний адрес). Сворачивается в значок.
 * Как и панель: самодостаточная функция, closed shadow DOM, ничего не знает о командах приложения.
 * @param {Array<[string, string, string]>} LINKS
 * @param {{ go: (url: string) => void, back: () => void, forward: () => void, reload: () => void }} [api] подменяется в тестах
 */
export function toolbarBootstrap(LINKS, api) {
  if (window.top !== window) return;
  const HOST_ID = '__tf_toolbar__';
  const STORE_KEY = '__tf_tb_collapsed';
  const doc = document;
  const create = Document.prototype.createElement;
  const attach = Element.prototype.attachShadow;
  const nav = api || {
    go: (url) => { window.location.href = url; },
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    reload: () => window.location.reload()
  };
  const CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif}',
    '.bar{display:flex;align-items:center;gap:4px;background:#1c1f26;color:#e8e8ea;border:1px solid #3a3f4b;border-radius:10px 10px 0 0;border-bottom:none;padding:4px 6px;box-shadow:0 -2px 14px rgba(0,0,0,.4);font-size:12px}',
    '.sep{width:1px;height:16px;background:#3a3f4b;margin:0 2px}',
    '.site{color:#9aa0ad;font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.site.foreign{color:#e6c25a}',
    'button{background:#2d323d;color:#e8e8ea;border:1px solid #444a58;border-radius:5px;cursor:pointer;padding:2px 8px;font-size:12px;white-space:nowrap}',
    'button:hover{border-color:#f0b84a}',
    'button.on{border-color:#f0b84a;color:#f0b84a}'
  ].join('');
  let collapsed = false;
  try { collapsed = window.localStorage.getItem(STORE_KEY) === '1'; } catch (e) { collapsed = false; }

  const make = (tag, cls, text) => {
    const n = create.call(doc, tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const mount = () => {
    const old = doc.getElementById(HOST_ID);
    if (old) old.remove();
    const host = make('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:2147483646;';
    const root = attach.call(host, { mode: 'closed' });
    const style = make('style');
    style.textContent = CSS;
    root.appendChild(style);
    const box = make('div');
    root.appendChild(box);

    const setCollapsed = (v) => {
      collapsed = v;
      try { window.localStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch (e) { /* не критично */ }
      draw();
    };
    const btn = (label, title, fn, cls) => {
      const b = make('button', cls || '', label);
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };

    const draw = () => {
      box.textContent = '';
      const bar = make('div', 'bar');
      if (collapsed) {
        bar.appendChild(btn('🧭', 'Развернуть навигацию', () => setCollapsed(false)));
        box.appendChild(bar);
        return;
      }
      bar.appendChild(btn('◀', 'Назад', () => nav.back()));
      bar.appendChild(btn('▶', 'Вперёд', () => nav.forward()));
      bar.appendChild(btn('⟳', 'Обновить страницу', () => nav.reload()));
      bar.appendChild(make('div', 'sep'));
      LINKS.forEach((l) => {
        const here = window.location.hostname === 'pwonline.ru' && window.location.pathname === l[2];
        bar.appendChild(btn(l[0], l[1], () => nav.go(l[1]), here ? 'on' : ''));
      });
      bar.appendChild(make('div', 'sep'));
      const foreign = window.location.hostname !== 'pwonline.ru';
      const site = make('div', foreign ? 'site foreign' : 'site', window.location.hostname || '—');
      site.title = foreign ? 'Это не pwonline.ru (например, страница входа)' : 'Вы на pwonline.ru';
      bar.appendChild(site);
      bar.appendChild(btn('⌄', 'Свернуть', () => setCollapsed(true)));
      box.appendChild(bar);
    };

    draw();
    (doc.body || doc.documentElement).appendChild(host);
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

/** Готовый скрипт для внедрения в окно браузера персонажа: панель контактов + тулбар навигации. */
export function buildPanelScript(data) {
  return `(${panelBootstrap.toString()})(${JSON.stringify(data)});`
    + `(${toolbarBootstrap.toString()})(${JSON.stringify(SITE_LINKS)});`;
}

// Панель «Помощник входа» (issue #54): скрипт, который рисует сворачиваемую карточку с контактами
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
 * @param {{ nick: string, contacts: Record<string, string> }} DATA
 */
export function panelBootstrap(DATA) {
  if (window.top !== window) return;
  const HOST_ID = '__tf_login_panel__';
  const STORE_KEY = '__tf_lp_collapsed';
  const doc = document;
  const create = Document.prototype.createElement;
  const attach = Element.prototype.attachShadow;
  const later = window.setTimeout.bind(window);
  const clip = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText.bind(navigator.clipboard) : null;
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
    'details{margin-top:8px;color:#e6c25a;font-size:11px}',
    'summary{cursor:pointer}'
  ].join('');
  let collapsed = false;
  try { collapsed = window.localStorage.getItem(STORE_KEY) === '1'; } catch (e) { collapsed = false; }
  let revealed = false;

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
      const hint = make('details');
      hint.appendChild(make('summary', '', 'ℹ️ Если после входа белый экран'));
      hint.appendChild(make('div', '', 'Если после входа через VK Play появился белый экран: 1) закройте это окно браузера; 2) в Tvinoferma нажмите «Проверить авторизацию»; 3) статус должен стать 🟢.'));
      card.appendChild(hint);
      box.appendChild(card);
    };

    draw();
    (doc.body || doc.documentElement).appendChild(host);
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

/** Готовый скрипт для внедрения в окно браузера персонажа. */
export function buildPanelScript(data) {
  return `(${panelBootstrap.toString()})(${JSON.stringify(data)});`;
}

// src-tauri/src/scripts/guild.js
// Скрипт окна клана Guild (pw-eternals.ru). Внедряется во все страницы этого окна.
//
// 1) Панель навигации сверху: назад, вперёд, обновить страницу.
// 2) На странице профиля разбирает события, пати и опрос, загружая варианты из API сайта,
//    и отдаёт их в hash адреса: #TFETE1_<encodeURIComponent({"data":{...},"error":null})>.
// 3) По запросу приложения отмечает событие (handlers/event_response.php, #TFETA1_)
//    или голосует в опросе (handlers/vote.php, #TFETV1_).
//
// Hash меняется через history.replaceState, а не location.hash: иначе каждая сводка
// добавляла бы запись в историю, и кнопка «назад» переключала бы hash вместо страниц.
//
// Разбор повторяет js/modules/guild/core.js: этот файл выполняется в окне сайта,
// модули приложения там недоступны.

(function () {
  if (window.__tfGuildInstalled) return;
  window.__tfGuildInstalled = true;

  const NAV_ID = 'tf-guild-nav';
  const NAV_HEIGHT = 36;

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const validId = (value) => /^\d{1,12}$/.test(String(value));
  // Адрес задаётся Rust при создании окна; сторонняя страница не должна получать запросы клана.
  const isGuildOrigin = () => !!window.__tfGuildOrigin && location.origin === window.__tfGuildOrigin;

  /* ---------------------------- панель навигации ---------------------------- */

  function mountNavBar() {
    if (document.getElementById(NAV_ID)) return;

    const style = document.createElement('style');
    style.id = 'tf-guild-nav-style';
    style.textContent = `
      #${NAV_ID} { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646; display: flex; align-items: center; gap: 6px;
        height: ${NAV_HEIGHT}px; padding: 0 10px; box-sizing: border-box; background: #1d2420; color: #e8efe9;
        border-bottom: 1px solid #3a4a40; font: 14px system-ui, sans-serif; }
      #${NAV_ID} button { min-width: 34px; height: 26px; padding: 0 8px; border: 1px solid #3a4a40; border-radius: 6px;
        background: #27322c; color: inherit; font: inherit; cursor: pointer; }
      #${NAV_ID} button:hover { background: #34443b; }
      #${NAV_ID} .tf-guild-title { margin-left: 8px; font-size: 12px; opacity: 0.7; }
      html { scroll-padding-top: ${NAV_HEIGHT}px; }
      body { padding-top: ${NAV_HEIGHT}px !important; }`;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = NAV_ID;
    bar.innerHTML = `
      <button type="button" data-tf-nav="back" title="Назад" aria-label="Назад">←</button>
      <button type="button" data-tf-nav="forward" title="Вперёд" aria-label="Вперёд">→</button>
      <button type="button" data-tf-nav="reload" title="Обновить страницу" aria-label="Обновить страницу">⟳</button>
      <span class="tf-guild-title">Guild Clan · Твиноферма</span>`;
    bar.addEventListener('click', (e) => {
      const act = e.target.closest('[data-tf-nav]')?.dataset.tfNav;
      if (act === 'back') history.back();
      else if (act === 'forward') history.forward();
      else if (act === 'reload') location.reload();
    });
    document.body.appendChild(bar);
  }

  /* ------------------------------- разбор ------------------------------- */

  function parseEvents(doc) {
    return [...doc.querySelectorAll('.user__event')].map((el) => {
      const form = el.querySelector('form.event-response-form');
      const checked = el.querySelector('input[type="radio"]:checked');
      return {
        id: clean(form?.dataset?.eventId),
        title: clean(el.querySelector('.user__event-title')?.textContent),
        when: clean(el.querySelector('.user__event-date')?.textContent),
        comment: clean(el.querySelector('.user__event-comment')?.textContent),
        response: checked?.value === 'yes' || checked?.value === 'no' ? checked.value : ''
      };
    }).filter((e) => e.id);
  }

  function parsePartyName(col) {
    const title = col.querySelector('.user__party-title');
    if (!title) return '';
    // Собственный текст заголовка, без «(5 чел.)» в подписи
    const own = [...title.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
    return clean(own) || clean(title.textContent);
  }

  // Участники пати: строки таблицы, где ник — ссылка .table-username с иконкой класса.
  // Если таблицы нет, ники берём из data-users — без иконок, но лучше чем ничего.
  function parsePartyMembers(col) {
    const members = [];
    for (const link of col.querySelectorAll('a.table-username')) {
      const nick = clean(link.textContent).replace(/\s*\([^)]*\)\s*$/, '');
      if (!nick) continue;
      const img = link.querySelector('img');
      const src = clean(img?.getAttribute('src'));
      members.push({
        nick,
        cls: (src.match(/\/classes\/([a-z0-9_-]+)\.[a-z0-9]+$/i) || [])[1] || '',
        title: clean(img?.getAttribute('alt'))
      });
    }
    if (members.length) return members;
    const raw = clean(col.getAttribute('data-users'));
    return raw ? raw.split(/\s+/).map((nick) => ({ nick, cls: '', title: '' })) : [];
  }

  function parseParties(column) {
    if (!column) return [];
    const parties = [];
    for (const col of column.querySelectorAll('.user__party-col')) {
      const name = parsePartyName(col);
      if (!name) continue;
      const members = parsePartyMembers(col);
      if (!members.length && /нет активных пати/i.test(name)) continue;
      parties.push({ name, members });
    }
    return parties;
  }

  // HTML заголовка и вариантов сводим к тексту и http(s)-ссылкам: никакие теги
  // и обработчики сайта не передаются в приложение. См. js/modules/guild/poll.js.
  function safePollLink(value, base) {
    if (!value || String(value).length > 2048) return '';
    try {
      const url = new URL(String(value), base || undefined);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch (e) { return ''; }
  }

  function pollTextParts(root) {
    if (!root) return [];
    const parts = [];
    const skip = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT']);
    const visit = (node) => {
      if (node.nodeType === 3) { parts.push({ text: node.textContent || '' }); return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1 && skip.has(node.tagName)) return;
      if (node.nodeType === 1 && node.tagName === 'BR') { parts.push({ text: ' ' }); return; }
      if (node.nodeType === 1 && node.tagName === 'A') {
        parts.push({ text: node.textContent || '', href: safePollLink(node.getAttribute('href'), document.baseURI) });
        return;
      }
      for (const child of node.childNodes) visit(child);
    };
    visit(root);
    const normalized = parts.slice(0, 100).flatMap((part) => {
      const text = String(part.text || '').replace(/\s+/g, ' ').slice(0, 1000);
      if (!text) return [];
      const href = safePollLink(part.href);
      return [href ? { text, href } : { text }];
    });
    if (normalized.length) {
      normalized[0].text = normalized[0].text.trimStart();
      normalized[normalized.length - 1].text = normalized[normalized.length - 1].text.trimEnd();
    }
    return normalized.filter((part) => part.text);
  }

  function parsePoll(doc) {
    const root = doc.querySelector('#mainPoll');
    const id = clean(root?.getAttribute('data-poll-id'));
    if (!root || !validId(id)) return null;
    return { id, title: pollTextParts(root.querySelector('.poll__title')), type: 'single', options: [], loadError: false };
  }

  // Варианты и уже выбранные ответы сайт возвращает отдельным JSON-запросом.
  async function fetchPoll(id) {
    if (!isGuildOrigin() || !validId(id)) throw new Error('wrong_site');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const reply = await fetch(`/handlers/get_poll.php?poll_id=${encodeURIComponent(id)}`, {
        credentials: 'include', cache: 'no-store', signal: controller.signal
      });
      if (!reply.ok) throw new Error('poll_unavailable');
      const data = await reply.json();
      if (!data?.poll || !Array.isArray(data.options) || !Array.isArray(data.user_vote)) throw new Error('poll_invalid');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function applyPollOptions(poll, data) {
    const selected = new Set(data.user_vote.map(String));
    const seen = new Set();
    const options = data.options.slice(0, 200).flatMap((option) => {
      const id = clean(option?.id);
      if (!validId(id) || seen.has(id)) return [];
      seen.add(id);
      const template = document.createElement('template');
      template.innerHTML = String(option.option_text || '');
      return [{ id, text: pollTextParts(template.content), selected: selected.has(id) }];
    });
    return { ...poll, type: data.poll.poll_type === 'multiple' ? 'multiple' : 'single', options, loadError: false };
  }

  function parseProfile(doc) {
    const partiesColumn = [...doc.querySelectorAll('.user__col')]
      .find((el) => clean(el.querySelector('.title')?.textContent) === 'Пати в которых вы состоите');
    return {
      events: parseEvents(doc),
      parties: parseParties(partiesColumn),
      selfNick: clean(doc.querySelector('#updateUserInfoForm input[name="username"]')?.value),
      poll: parsePoll(doc)
    };
  }

  function publish(prefix, payload) {
    const hash = '#' + prefix + encodeURIComponent(JSON.stringify(payload));
    history.replaceState(null, '', location.pathname + location.search + hash);
  }

  // Повторный разбор отменяет публикацию предыдущего: медленный ответ API не должен
  // затереть более свежую сводку после нажатия «Обновить».
  let scrapeSequence = 0;
  window.__tfGuildScrape = function () {
    const sequence = ++scrapeSequence;
    if (document.querySelector('.user__events, .user__col')) {
      const data = parseProfile(document);
      if (!data.poll) {
        publish('TFETE1_', { data, error: null });
      } else {
        fetchPoll(data.poll.id)
          .then((reply) => { data.poll = applyPollOptions(data.poll, reply); })
          .catch(() => { data.poll.loadError = true; })
          .finally(() => { if (sequence === scrapeSequence) publish('TFETE1_', { data, error: null }); });
      }
      return true;
    }
    if (document.querySelector('input[type="password"]')) {
      publish('TFETE1_', { data: null, error: 'login' });
    }
    return false;
  };

  // Отметка на ивенте тем же запросом, что у формы сайта.
  // Вердикт читаем мягко: сайт отвечает `{ status: 'success' | 'error', message }`, но если
  // разметка ответа поменяется, не хочется врать «не принял» на уже применённой отметке.
  window.__tfGuildRespond = async function (eventId, response) {
    const result = { ok: false, eventId: String(eventId), response: String(response), message: '', detail: '' };
    try {
      const body = new FormData();
      body.append('event_id', String(eventId));
      body.append('response', String(response));
      const reply = await fetch('handlers/event_response.php', { method: 'POST', body, credentials: 'include' });
      const text = await reply.text();
      let json = null;
      try {
        json = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch (e) { /* ответ не JSON — вердикт по нему прочитать нельзя */ }
      const verdict = json && typeof json === 'object' ? json : null;
      const refused = verdict && (verdict.status === 'error' || verdict.success === false || verdict.ok === false);
      // Запрос дошёл, сервер ответил 2xx и не сказал «нет» — отметка принята.
      result.ok = reply.ok && !refused;
      result.message = clean(verdict?.message || '');
      result.detail = clean(text).slice(0, 200);
    } catch (e) {
      result.message = 'Сайт не ответил. Проверьте, что вы вошли в окне клана.';
      result.detail = clean(e?.message || e);
    }
    console.log('[TF clan] отметка', result.eventId, '→', result.response, '| ok:', result.ok, '| ответ:', result.detail);
    publish('TFETA1_', result);
    return result.ok;
  };

  // Голос идёт только на тот опрос, который сейчас открыт на странице клана.
  // Перед POST перечитываем варианты: устаревший кэш не должен отправить чужой голос.
  window.__tfGuildVote = async function (pollId, optionIds) {
    const id = String(pollId || '');
    const selected = Array.isArray(optionIds) ? optionIds.map(String) : [];
    const result = { ok: false, pollId: id, message: '' };
    try {
      if (!isGuildOrigin()) throw new Error('Откройте страницу профиля клана и обновите сводку.');
      if (!validId(id) || !selected.length || selected.length > 200 ||
          selected.some((value) => !validId(value)) || new Set(selected).size !== selected.length) {
        throw new Error('Выберите корректные варианты ответа.');
      }
      const currentPoll = () => clean(document.querySelector('#mainPoll')?.getAttribute('data-poll-id'));
      if (currentPoll() !== id) throw new Error('Опрос изменился. Обновите сводку клана.');
      const poll = await fetchPoll(id);
      const available = new Set(poll.options.map((option) => String(option.id)));
      if (selected.some((value) => !available.has(value)) ||
          (poll.poll.poll_type !== 'multiple' && selected.length !== 1)) {
        throw new Error('Варианты опроса изменились. Обновите сводку клана.');
      }
      if (!isGuildOrigin() || currentPoll() !== id) throw new Error('Опрос изменился. Обновите сводку клана.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const reply = await fetch('/handlers/vote.php', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poll_id: id, option_ids: selected.map(Number) }), signal: controller.signal
        });
        const data = await reply.json();
        result.ok = reply.ok && data?.success === true;
        result.message = result.ok ? '' : clean(data?.error || 'Сайт не подтвердил голос.').slice(0, 200);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      result.message = clean(e?.message || e);
      if (!result.message || ['AbortError', 'TypeError', 'SyntaxError'].includes(e?.name)) {
        result.message = 'Не удалось подтвердить голос. Обновите сводку перед повторной попыткой.';
      }
    }
    publish('TFETV1_', { data: result, error: null });
    return result.ok;
  };

  /* ------------------------------ диагностика ------------------------------ */

  // Если страница не отрисовалась (белый экран), показываем это прямо в окне и пишем в консоль.
  // Панель навигации при этом должна быть видна: если её нет, скрипт вообще не выполнился.
  function checkRendered() {
    const body = document.body;
    const text = clean(body?.innerText);
    console.log('[TF clan] адрес:', location.href, '| readyState:', document.readyState, '| символов текста:', text.length);
    if (text.length > 40) return;
    const box = document.createElement('div');
    box.id = 'tf-guild-diag';
    box.style.cssText = 'position:fixed;top:50px;left:16px;right:16px;z-index:2147483646;padding:14px 16px;'
      + 'background:#2a1f1f;color:#f5e6e6;border:1px solid #6b3a3a;border-radius:8px;font:14px system-ui,sans-serif';
    box.innerHTML = '<b>Страница клана не отобразилась.</b><br>'
      + 'Адрес: ' + location.href + '<br>'
      + 'Проверьте интернет и доступность сайта. Подробности — в консоли окна (Ctrl+Shift+I).';
    (body || document.documentElement).appendChild(box);
  }

  window.addEventListener('error', (e) => console.log('[TF clan] ошибка скрипта страницы:', e.message));

  function start() {
    mountNavBar();
    window.__tfGuildScrape();
    // Даём сайту время отрисоваться, потом проверяем содержимое
    setTimeout(checkRendered, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

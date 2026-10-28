// demo/scenarios.js
// Интерактивные макеты варианта B. ВНИМАНИЕ: сканирование и действия имитируются,
// настоящих запросов к сайту и изменений в приложении нет. Данные каждого окна
// существуют только в памяти этого окна. Правила планирования покупок/передач
// используются из релизных shopCore.js и transferCore.js.

import { openOverlay } from '../js/modules/marathons/overlay.js';
import { toast, confirmModal } from '../js/core/ui.js';
import { escapeHtml } from '../js/core/utils.js';
import { formatCoins } from '../js/core/coins.js';
import { SHOP_ITEMS, groupAccounts, pickRepresentative, planAccount } from '../js/modules/automation/shopCore.js';
import { planTransfer, statusInfo as transferStatusInfo } from '../js/modules/automation/transferCore.js';
import {
  CHARS,
  sleep,
  defaultTarget,
  targetChars,
  targetHtml,
  bindTarget,
  closeTargetPicker,
  classIconHtml,
  stripeCls,
  statusTitle
} from './lab-data.js';
import { createDemoSite, demoAccountName, demoRoster } from './scenario-fixtures.js';

const SCAN_DELAY = 110;
const ACTION_DELAY = 180;
const clone = value => JSON.parse(JSON.stringify(value));
const esc = escapeHtml;
const fmt = formatCoins;
let sequence = 0;

/** Общий каркас: существующий openOverlay отвечает за Esc, крестик и стек модалок. */
function splitFrame(title, sub) {
  let signal = null;
  const dlg = openOverlay({
    title,
    wide: true,
    onClose: () => {
      if (signal) signal.cancelled = true;
      closeTargetPicker(dlg.body);
    }
  });
  dlg.el.querySelector('.modal-container').classList.add('sp-container');
  dlg.foot.classList.add('sd-foot');
  dlg.sub.textContent = `${sub} Демо: данные вымышлены, запросов к сайту нет.`;
  dlg.body.innerHTML = `
    <div class="sp-body">
      <aside class="sp-side" data-side></aside>
      <div class="sp-main">
        <div class="sp-progress">
          <div class="sp-progress-top"><span class="sp-status" data-status aria-live="polite">Подготовка…</span><b data-count></b></div>
          <div class="sd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-bar style="width:0%"></span></div>
        </div>
        <div data-table></div>
        <div class="sc-result" data-result aria-live="polite"></div>
      </div>
    </div>`;
  const $ = selector => dlg.body.querySelector(selector);
  return {
    dlg,
    id: `sc${++sequence}`,
    side: $('[data-side]'),
    table: $('[data-table]'),
    result: $('[data-result]'),
    alive: () => dlg.el.isConnected,
    get busy() {
      return !!signal;
    },
    begin(kind) {
      if (signal) return null;
      signal = { kind, cancelled: false };
      dlg.body.setAttribute('aria-busy', 'true');
      return signal;
    },
    end(operation) {
      if (signal === operation) signal = null;
      dlg.body.removeAttribute('aria-busy');
    },
    stop() {
      if (signal) signal.cancelled = true;
    },
    status(text, running = false) {
      if (!dlg.el.isConnected) return;
      $('[data-status]').textContent = text;
      $('[data-status]').classList.toggle('is-running', running);
    },
    progress(done, total) {
      if (!dlg.el.isConnected) return;
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      $('[data-count]').textContent = total ? `${done} из ${total}` : '';
      $('[data-bar]').style.width = `${pct}%`;
      $('[data-bar]').parentElement.setAttribute('aria-valuenow', String(pct));
    }
  };
}

function targetSide(frame, target, extra, onChange) {
  frame.side.innerHTML = `
    <fieldset class="sc-fields" ${frame.busy ? 'disabled' : ''}>
      <div class="sp-field"><label>Кого запускать</label>${targetHtml(target, frame.id)}</div>
      ${extra}
    </fieldset>`;
  bindTarget(frame.dlg.body, target, frame.id, onChange);
}

function footer(frame, { ready = false, canRun = false, startLabel = 'Запустить', confirming = false } = {}) {
  frame.dlg.foot.innerHTML = frame.busy
    ? `<span class="promo-muted">Демо · кнопка «Стоп» не начинает новые действия.</span><span class="sd-foot-spacer"></span>
       <button class="btn danger" data-act="stop">⏹ Стоп</button>`
    : `<button class="btn secondary" data-act="refresh" ${confirming ? 'disabled' : ''}>🔄 Обновить данные</button>
       <span class="sd-foot-spacer"></span>
       <button class="btn ghost" data-act="close">Закрыть</button>
       <button class="btn secondary" data-act="dry" ${ready && canRun && !confirming ? '' : 'disabled'}>👁 Пробный</button>
       <button class="btn primary" data-act="start" ${ready && canRun && !confirming ? '' : 'disabled'}>${esc(startLabel)}</button>`;
}

function bindFooter(frame, handlers) {
  frame.dlg.foot.addEventListener('click', e => {
    const button = e.target.closest('button[data-act]');
    if (!button || button.disabled) return;
    switch (button.dataset.act) {
      case 'close':
        frame.dlg.close();
        break;
      case 'refresh':
        void handlers.scan();
        break;
      case 'dry':
        void handlers.run(true);
        break;
      case 'start':
        void handlers.run(false);
        break;
      case 'stop':
        frame.stop();
        button.disabled = true;
        button.textContent = '⏳ Останавливаю…';
        break;
    }
  });
}

async function confirmDemo(title, text) {
  return confirmModal({
    title,
    text: `${text} Это демонстрация: на сайт ничего не отправляется.`,
    okText: 'Продолжить',
    danger: true
  });
}

function characterHtml(char, account = '') {
  return `<span class="sc-character ${stripeCls(char)}" title="${esc(statusTitle(char))}">
    ${classIconHtml(char)}<span class="sc-character-copy"><b>${esc(char.nick)}</b>${account ? `<small class="sc-acc" title="${esc(account)}">${esc(account)}</small>` : ''}</span>
  </span>`;
}

// Стопка растягивается на всю высоту ячейки: при общем аккаунте полоса каждого
// персонажа занимает свою часть, а не окрашивает весь аккаунт одним статусом.
function characterCell(characters, account) {
  return `<td class="sc-character-cell" style="--sc-cell-min-height:${characters.length * 56}px"><div class="sc-character-stack">${characters
    .map((char, i) => characterHtml(char, i === 0 ? account : ''))
    .join('')}</div></td>`;
}

function emptyOrError(record) {
  if (!record) return '<span class="promo-muted">⏳ Ожидает проверки</span>';
  if (record.status === 'nologin') return '<span class="sc-warn">Нет входа на сайт — проверить не удалось</span>';
  return '';
}

/* ==================== Передача предметов ==================== */

export function openTransferSplit() {
  const frame = splitFrame('📦 Передача предметов', 'Проверка инвентаря → сервер и получатель → план передачи.');
  const site = createDemoSite();
  const st = {
    target: defaultTarget(),
    reads: {},
    shards: {},
    picks: {},
    results: {},
    scanned: false,
    stale: false,
    confirming: false
  };
  const chosen = () => targetChars(st.target);
  const plans = () => {
    const rosters = Object.fromEntries(
      Object.entries(st.reads)
        .filter(([, r]) => r.status === 'ok')
        .map(([id, r]) => [id, r.roster])
    );
    return planTransfer(chosen(), rosters, { shards: st.shards, picks: st.picks });
  };

  function targetChanged() {
    st.results = {};
    renderTable();
    renderFooter();
  }

  function renderSide() {
    targetSide(
      frame,
      st.target,
      `
      <div class="sp-note">Автоматический скрипт отмечает все доступные предметы на странице аккаунта. Заблокированные строки и запомненные ограничения учитываются отдельно; сундуки с выбором награды не открываются.</div>
      <div class="sp-note">В ручном окне сайта есть группировка по типам и акциям, но автоматический план категории не выбирает. После проверки выберите сервер и получателя. Общий аккаунт обрабатывается один раз.</div>`,
      targetChanged
    );
  }

  function itemsHtml(record) {
    if (!record || record.status !== 'ok') return emptyOrError(record);
    const { items, chests, locked } = record.roster.pending;
    const list = items.length
      ? `<div class="sc-roster">${items.map(i => `<span class="sc-roster-item">${esc(i.name)} ×${esc(i.qty)}</span>`).join('')}</div>`
      : '<span class="promo-muted">Нет предметов к передаче</span>';
    return `${list}${chests ? `<div class="promo-muted">Сундуков с выбором награды: ${chests} — не открываются</div>` : ''}${locked ? `<div class="sc-warn">Заблокировано: ${locked}</div>` : ''}`;
  }

  function serverHtml(char, record) {
    if (!record || record.status !== 'ok') return '<span class="promo-muted">Нет данных</span>';
    const sid = st.shards[char.id] || '';
    const roster = record.roster;
    const server = roster.shards.find(s => s.id === sid);
    const recipient = st.picks[char.id]?.[sid] || '';
    const disabled = frame.busy ? 'disabled' : '';
    return `<select class="input sc-select" data-server="${esc(char.id)}" aria-label="Сервер для ${esc(char.nick)}" ${disabled}>
      <option value="">— Выберите сервер —</option>${roster.shards.map(s => `<option value="${esc(s.id)}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <select class="input sc-select" data-recipient="${esc(char.id)}" aria-label="Получатель для ${esc(char.nick)}" ${!server || frame.busy ? 'disabled' : ''}>
      <option value="">${server?.chars.length === 1 ? `Авто: ${esc(server.chars[0].name)}` : '— Выберите получателя —'}</option>
      ${(server?.chars || []).map(c => `<option value="${esc(c.key)}" ${recipient === c.key ? 'selected' : ''}>${esc(c.name)} · ${esc(c.cls)}</option>`).join('')}</select>`;
  }

  function renderTable() {
    const list = chosen();
    if (!list.length) {
      frame.table.innerHTML = '<p class="sp-note">Выберите персонажей, чтобы увидеть их данные.</p>';
      return;
    }
    const byId = new Map(plans().map(p => [p.char.id, p]));
    frame.table.innerHTML = `<div class="promo-scroll"><table class="promo-table sc-scan-table">
      <thead><tr><th>Персонаж / вход</th><th>Ожидает передачи</th><th>Сервер и получатель</th><th>План / результат</th></tr></thead>
      <tbody>${list
        .map(c => {
          const r = st.reads[c.id];
          const plan = byId.get(c.id);
          const status =
            st.results[c.id] ||
            (r?.status === 'nologin'
              ? 'Нет входа на сайт'
              : !r
                ? 'Ожидание проверки'
                : plan.run
                  ? '✅ Готово к передаче'
                  : `${transferStatusInfo(plan.status).icon} ${transferStatusInfo(plan.status).label}`);
          return `<tr class="${stripeCls(c)}">${characterCell([c], demoAccountName(c.account))}
          <td>${itemsHtml(r)}</td><td>${serverHtml(c, r)}</td><td data-transfer-result="${esc(c.id)}">${esc(status)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  }

  function renderFooter() {
    footer(frame, {
      ready: st.scanned && !st.stale,
      canRun: plans().some(p => p.run),
      startLabel: '📦 Передать',
      confirming: st.confirming
    });
  }

  async function scan() {
    if (frame.busy || st.confirming) return;
    const op = frame.begin('scan');
    st.scanned = false;
    st.reads = {};
    st.results = {};
    frame.result.innerHTML = '';
    renderSide();
    renderTable();
    renderFooter();
    for (let i = 0; i < CHARS.length; i++) {
      frame.status(`🔄 Демо-проверка инвентаря: ${CHARS[i].nick}`, true);
      await sleep(SCAN_DELAY);
      if (!frame.alive() || op.cancelled) break;
      const c = CHARS[i];
      st.reads[c.id] =
        c.isLoggedIn === false ? { status: 'nologin' } : { status: 'ok', roster: demoRoster(c, site[c.account]) };
      frame.progress(i + 1, CHARS.length);
      renderTable();
    }
    frame.end(op);
    if (!frame.alive()) return;
    st.scanned = !op.cancelled;
    if (st.scanned) st.stale = false;
    frame.status(
      op.cancelled
        ? '⏹ Проверка остановлена — обновите данные'
        : '✅ Демо-проверка завершена. Выберите сервер и получателя.'
    );
    renderSide();
    renderTable();
    renderFooter();
  }

  async function run(dry) {
    if (frame.busy || st.confirming || !st.scanned || st.stale || !plans().some(p => p.run)) return;
    if (!dry) {
      st.confirming = true;
      renderFooter();
      const ok = await confirmDemo(
        'Передать предметы?',
        'Передача необратима; будут использованы выбранные серверы и получатели.'
      );
      st.confirming = false;
      if (!frame.alive()) return;
      if (!ok) {
        renderFooter();
        return;
      }
    }
    const work = plans();
    const op = frame.begin('run');
    st.results = {};
    frame.result.innerHTML = '';
    renderSide();
    renderTable();
    renderFooter();
    let sent = 0;
    for (let i = 0; i < work.length; i++) {
      const p = work[i];
      if (op.cancelled || !frame.alive()) break;
      if (p.run) {
        frame.status(`${dry ? '👁 Пробная проверка' : '📦 Демо-передача'}: ${p.char.nick}`, true);
        await sleep(ACTION_DELAY);
        if (op.cancelled || !frame.alive()) break;
        st.results[p.char.id] = dry ? '👁 Найдено, ничего не передано' : '✅ Передано в демо';
        if (!dry) {
          site[p.char.account].pending = [];
          sent++;
        }
      }
      frame.progress(i + 1, work.length);
      renderTable();
    }
    frame.end(op);
    if (!frame.alive()) return;
    st.stale = sent > 0;
    frame.status(op.cancelled ? '⏹ Остановлено' : dry ? '👁 Пробная проверка завершена' : '✅ Демо-передача завершена');
    frame.result.textContent = dry
      ? 'Пробный запуск: инвентарь не изменился.'
      : sent
        ? 'Данные изменились в макете. Обновите список перед повторным запуском.'
        : '';
    renderSide();
    renderTable();
    renderFooter();
  }

  frame.dlg.body.addEventListener('change', e => {
    const input = e.target;
    if (frame.busy || st.confirming) return;
    if (input.matches('[data-server]')) {
      st.shards[input.dataset.server] = input.value;
      st.results = {};
      renderTable();
      renderFooter();
    } else if (input.matches('[data-recipient]')) {
      const id = input.dataset.recipient;
      const sid = st.shards[id];
      st.picks[id] ||= {};
      st.picks[id][sid] = input.value;
      st.results = {};
      renderTable();
      renderFooter();
    }
  });
  bindFooter(frame, { scan, run });
  renderSide();
  renderTable();
  renderFooter();
  void scan();
  return frame.dlg;
}

/* ==================== Подарки и Древние монеты ==================== */

/** Описание берётся из примера ответа сайта; для отсутствующих товаров не придумываем эффект. */
function openItemInfo(def, item) {
  const dlg = openOverlay({ title: `${def.icon} ${def.name}` });
  dlg.sub.textContent = 'Описание из демонстрационного снимка магазина; на настоящем сайте сведения могут измениться.';
  dlg.body.innerHTML = `<div class="sc-info-body"><p>${esc(item?.desc || 'В демонстрационном снимке товар отсутствует. Его описание появится после чтения страницы магазина.')}</p>
    <p class="promo-muted">${item?.found ? `Пример цены: ${esc(fmt(item.price))} мон. ${item.available == null ? 'Лимит в примере не указан.' : `Доступно в примере: ${item.available} шт.`}` : 'В этом примере сейчас недоступен.'}</p></div>`;
  dlg.foot.innerHTML = '<button class="btn primary" data-info-close>Понятно</button>';
  dlg.foot.querySelector('[data-info-close]').addEventListener('click', () => dlg.close());
  return dlg;
}

export function openShopSplit() {
  const frame = splitFrame(
    '🪙 Активация подарков',
    'Сначала проверяем Древние монеты, цены и лимиты; затем рассчитываем количество для каждого аккаунта.'
  );
  const site = createDemoSite();
  const charSite = Object.fromEntries(CHARS.map(c => [c.id, `acc:${c.account}`]));
  const groups = groupAccounts(CHARS, charSite);
  const st = {
    target: defaultTarget(),
    reads: {},
    selected: new Set(['light', 'valor']),
    qty: new Map(),
    results: {},
    scanned: false,
    stale: false,
    confirming: false
  };
  const selectedIds = () => new Set(targetChars(st.target).map(c => c.id));
  const selectedGroups = () => {
    const ids = selectedIds();
    return groups.filter(g => g.members.some(c => ids.has(c.id)));
  };
  const defs = () => SHOP_ITEMS.filter(i => st.selected.has(i.key));
  const recordOf = group => st.reads[group.siteKey];
  const qtyOf = (group, key) => st.qty.get(`${group.siteKey}|${key}`) || 0;
  const itemForCard = key =>
    Object.values(st.reads).find(r => r.status === 'ok' && r.data.items[key]?.found)?.data.items[key];

  function planFor(group) {
    const record = recordOf(group);
    if (record?.status !== 'ok') return null;
    const { balance, items } = record.data;
    return planAccount({
      balance,
      orders: defs().map(def => ({
        key: def.key,
        requested: qtyOf(group, def.key),
        price: items[def.key]?.buyable ? items[def.key].price : null,
        available: items[def.key]?.available ?? null
      }))
    });
  }

  function targetChanged() {
    st.results = {};
    frame.result.textContent = '';
    renderTable();
    renderFooter();
  }

  function catalogHtml() {
    return `<div class="sp-field"><label>Закреплённые предметы</label><div class="sc-catalog">${SHOP_ITEMS.map(def => {
      const item = itemForCard(def.key);
      const unavailable = st.scanned && !item;
      const price = item ? `${fmt(item.price)} мон. · пример` : st.scanned ? 'Нет в примере' : 'Проверяется…';
      const description =
        item?.desc ||
        (st.scanned
          ? 'Описание появится, если товар есть на странице магазина.'
          : 'Описание и цена появятся после проверки.');
      return `<div class="sc-cat-row${unavailable ? ' is-blocked' : ''}">
        <label class="sc-cat-pick"><input type="checkbox" data-item="${esc(def.key)}" ${st.selected.has(def.key) ? 'checked' : ''} ${unavailable ? 'disabled' : ''}>
          <span>${def.icon} ${esc(def.name)}</span></label>
        <span class="promo-muted">${esc(price)}</span>
        <button type="button" class="sc-info-btn" data-info="${esc(def.key)}" aria-label="Подробнее: ${esc(def.name)}" title="Подробнее">ⓘ</button>
        <p class="sc-cat-desc">${esc(description)}</p></div>`;
    }).join('')}</div></div>`;
  }

  function renderSide() {
    targetSide(
      frame,
      st.target,
      `${catalogHtml()}
      <div class="sp-note">У персонажей одного аккаунта сайта общий баланс и лимиты: количество задаётся один раз на аккаунт. Цены и описания на настоящем сайте могут отличаться от примера.</div>`,
      targetChanged
    );
  }

  function calculationHtml(row) {
    if (!row || !row.requested) return '<span class="promo-muted">Не заказано</span>';
    if (!(row.price > 0)) return '<span class="sc-warn">Недоступно</span>';
    const restriction =
      row.qty < row.requested
        ? ` · купится ${row.qty} из ${row.requested} (${row.cap === 'limit' ? 'лимит' : 'не хватает монет'})`
        : '';
    return `<span>${fmt(row.price)} × ${row.qty} = <b>${fmt(row.cost)}</b> мон.</span>${restriction ? `<div class="sc-warn">${esc(restriction.slice(3))}</div>` : ''}`;
  }

  function sumHtml(plan) {
    return plan ? `Потратить: <b>${fmt(plan.spent)}</b><br>Останется: <b>${fmt(plan.left)}</b> мон.` : '—';
  }

  function renderTable() {
    const list = selectedGroups();
    const products = defs();
    if (!list.length) {
      frame.table.innerHTML = '<p class="sp-note">Выберите персонажей, чтобы увидеть аккаунты.</p>';
      return;
    }
    frame.table.innerHTML = `<div class="promo-scroll"><table class="promo-table sc-shop-table">
      <thead><tr><th>Персонажи / аккаунт</th><th>Древние монеты</th>${products.map(d => `<th>${d.icon} ${esc(d.name)}</th>`).join('')}<th>Расчёт</th></tr></thead>
      <tbody>${list
        .map(g => {
          const record = recordOf(g);
          const rep = pickRepresentative(g.members, selectedIds()) || g.members[0];
          const plan = planFor(g);
          const account = demoAccountName(g.members[0].account);
          const memberCell = characterCell(g.members, account);
          if (!plan)
            return `<tr class="${stripeCls(rep)}">${memberCell}<td colspan="${products.length + 2}">${emptyOrError(record)}</td></tr>`;
          return `<tr class="${stripeCls(rep)}">${memberCell}<td>${fmt(record.data.balance)} мон.</td>
          ${products
            .map(def => {
              const item = record.data.items[def.key];
              if (!item?.buyable) return '<td><span class="sc-warn">🔒 Недоступно</span></td>';
              const row = plan.rows.find(r => r.key === def.key);
              const key = `${g.siteKey}|${def.key}`;
              return `<td><label class="sc-qty-label">Количество <input class="input sc-qty-input" type="number" min="0" max="999" step="1" value="${qtyOf(g, def.key)}" data-qty="${esc(key)}" aria-label="${esc(def.name)} — ${esc(account)}" ${frame.busy ? 'disabled' : ''}></label>
              <div class="sc-calc" data-calc="${esc(key)}">${calculationHtml(row)}</div></td>`;
            })
            .join('')}
          <td><div data-shop-sum="${esc(g.siteKey)}">${sumHtml(plan)}</div><div class="promo-muted" data-shop-result="${esc(g.siteKey)}">${esc(st.results[g.siteKey] || '')}</div></td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  }

  // Во время ввода обновляем расчёты, не пересоздавая поля и не теряя курсор.
  function updateCalculations() {
    for (const group of selectedGroups()) {
      const plan = planFor(group);
      if (!plan) continue;
      for (const row of plan.rows) {
        const key = `${group.siteKey}|${row.key}`;
        const box = [...frame.table.querySelectorAll('[data-calc]')].find(el => el.dataset.calc === key);
        if (box) box.innerHTML = calculationHtml(row);
      }
      const sum = [...frame.table.querySelectorAll('[data-shop-sum]')].find(el => el.dataset.shopSum === group.siteKey);
      if (sum) sum.innerHTML = sumHtml(plan);
      const result = [...frame.table.querySelectorAll('[data-shop-result]')].find(
        el => el.dataset.shopResult === group.siteKey
      );
      if (result) result.textContent = '';
    }
  }

  function renderFooter() {
    const canRun = selectedGroups().some(g => (planFor(g)?.qty || 0) > 0);
    footer(frame, { ready: st.scanned && !st.stale, canRun, startLabel: '🪙 Купить', confirming: st.confirming });
  }

  async function scan() {
    if (frame.busy || st.confirming) return;
    const op = frame.begin('scan');
    st.scanned = false;
    st.reads = {};
    st.results = {};
    frame.result.innerHTML = '';
    renderSide();
    renderTable();
    renderFooter();
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      frame.status(`🔄 Демо-проверка баланса: ${demoAccountName(group.members[0].account)}`, true);
      await sleep(SCAN_DELAY);
      if (!frame.alive() || op.cancelled) break;
      const rep = pickRepresentative(group.members, selectedIds());
      st.reads[group.siteKey] = rep ? { status: 'ok', data: clone(site[rep.account]) } : { status: 'nologin' };
      frame.progress(i + 1, groups.length);
      renderTable();
    }
    frame.end(op);
    if (!frame.alive()) return;
    st.scanned = !op.cancelled;
    if (st.scanned) st.stale = false;
    frame.status(
      op.cancelled
        ? '⏹ Проверка остановлена — обновите данные'
        : '✅ Демо-проверка завершена. Укажите количество для каждого аккаунта.'
    );
    renderSide();
    renderTable();
    renderFooter();
  }

  async function run(dry) {
    if (frame.busy || st.confirming || !st.scanned || st.stale) return;
    const work = selectedGroups()
      .map(group => ({ group, plan: planFor(group) }))
      .filter(x => x.plan?.qty > 0);
    if (!work.length) return;
    if (!dry) {
      st.confirming = true;
      renderFooter();
      const ok = await confirmDemo(
        'Купить подарки?',
        `В плане ${work.length} аккаунтов; количество и остаток показаны в таблице.`
      );
      st.confirming = false;
      if (!frame.alive()) return;
      if (!ok) {
        renderFooter();
        return;
      }
    }
    const op = frame.begin('run');
    st.results = {};
    frame.result.innerHTML = '';
    renderSide();
    renderTable();
    renderFooter();
    let completed = 0;
    for (let i = 0; i < work.length; i++) {
      const { group, plan } = work[i];
      if (op.cancelled || !frame.alive()) break;
      frame.status(
        `${dry ? '👁 Пробная проверка' : '🪙 Демо-покупка'}: ${demoAccountName(group.members[0].account)}`,
        true
      );
      await sleep(ACTION_DELAY);
      if (op.cancelled || !frame.alive()) break;
      st.results[group.siteKey] = dry
        ? `Пробный: баланс не изменён, прогноз ${fmt(plan.left)} мон.`
        : `В демо куплено ${plan.qty} шт.; осталось ${fmt(plan.left)} мон.`;
      if (!dry) {
        const account = site[group.members[0].account];
        account.balance = plan.left;
        for (const row of plan.rows)
          if (account.items[row.key].available != null) account.items[row.key].available -= row.qty;
        completed++;
      }
      frame.progress(i + 1, work.length);
      renderTable();
    }
    frame.end(op);
    if (!frame.alive()) return;
    st.stale = completed > 0;
    frame.status(op.cancelled ? '⏹ Остановлено' : dry ? '👁 Пробная проверка завершена' : '✅ Демо-покупка завершена');
    frame.result.textContent = dry
      ? 'Пробный запуск: монеты и наличие не изменились.'
      : completed
        ? 'Баланс изменён только в макете. Обновите данные перед повторной покупкой.'
        : '';
    renderSide();
    renderTable();
    renderFooter();
  }

  frame.dlg.body.addEventListener('change', e => {
    const input = e.target;
    if (frame.busy || st.confirming) return;
    if (input.matches('[data-item]')) {
      if (input.checked) st.selected.add(input.dataset.item);
      else st.selected.delete(input.dataset.item);
      st.results = {};
      frame.result.textContent = '';
      renderTable();
      renderFooter();
    }
  });
  frame.dlg.body.addEventListener('input', e => {
    const input = e.target;
    if (!input.matches('[data-qty]') || frame.busy || st.confirming) return;
    st.qty.set(input.dataset.qty, Math.max(0, Math.min(999, Math.floor(Number(input.value) || 0))));
    st.results = {};
    frame.result.textContent = '';
    updateCalculations();
    renderFooter();
  });
  frame.dlg.body.addEventListener('click', e => {
    const button = e.target.closest('[data-info]');
    if (!button || frame.busy) return;
    const def = SHOP_ITEMS.find(i => i.key === button.dataset.info);
    if (def) openItemInfo(def, itemForCard(def.key));
  });
  bindFooter(frame, { scan, run });
  renderSide();
  renderTable();
  renderFooter();
  void scan();
  return frame.dlg;
}

/* ==================== Сундук караванщика ==================== */

export function openCaravanSplit() {
  const frame = splitFrame('🧰 Сундук караванщика', 'Проверка инвентарей → найденные сундуки → открытие.');
  const site = createDemoSite();
  const st = { target: defaultTarget(), reads: {}, results: {}, scanned: false, stale: false, confirming: false };
  const chosen = () => targetChars(st.target);

  function targetChanged() {
    st.results = {};
    frame.result.textContent = '';
    renderTable();
    renderFooter();
  }
  function renderSide() {
    targetSide(
      frame,
      st.target,
      `<div class="sp-note">В настоящем скрипте открываются все найденные «Сундуки караванщика»; другие виды сундуков не затрагиваются.
      Персонажи одного аккаунта сайта используют общий инвентарь.</div>`,
      targetChanged
    );
  }
  function plan() {
    const seen = new Set();
    return chosen().map(c => {
      const record = st.reads[c.id];
      if (!record || record.status !== 'ok')
        return { c, run: false, text: record ? 'Нет входа на сайт' : 'Ожидание проверки' };
      if (seen.has(c.account)) return { c, run: false, text: '↪️ Общий инвентарь: уже в плане' };
      seen.add(c.account);
      return record.count
        ? { c, run: true, text: `К открытию: ${record.count}` }
        : { c, run: false, text: 'Сундуков нет' };
    });
  }
  function renderTable() {
    const list = plan();
    if (!list.length) {
      frame.table.innerHTML = '<p class="sp-note">Выберите персонажей, чтобы увидеть их инвентарь.</p>';
      return;
    }
    frame.table.innerHTML = `<div class="promo-scroll"><table class="promo-table sc-scan-table"><thead><tr><th>Персонаж / вход</th><th>Найдено сундуков</th><th>План / результат</th></tr></thead>
      <tbody>${list
        .map(
          p => `<tr class="${stripeCls(p.c)}">${characterCell([p.c], demoAccountName(p.c.account))}
        <td>${st.reads[p.c.id]?.status === 'ok' ? st.reads[p.c.id].count : emptyOrError(st.reads[p.c.id])}</td><td>${esc(st.results[p.c.id] || p.text)}</td></tr>`
        )
        .join('')}</tbody></table></div>`;
  }
  function renderFooter() {
    footer(frame, {
      ready: st.scanned && !st.stale,
      canRun: plan().some(p => p.run),
      startLabel: '📦 Открыть сундуки',
      confirming: st.confirming
    });
  }
  async function scan() {
    if (frame.busy || st.confirming) return;
    const op = frame.begin('scan');
    st.scanned = false;
    st.reads = {};
    st.results = {};
    frame.result.textContent = '';
    renderSide();
    renderTable();
    renderFooter();
    for (let i = 0; i < CHARS.length; i++) {
      const c = CHARS[i];
      frame.status(`🔄 Демо-проверка сундуков: ${c.nick}`, true);
      await sleep(SCAN_DELAY);
      if (!frame.alive() || op.cancelled) break;
      st.reads[c.id] = c.isLoggedIn === false ? { status: 'nologin' } : { status: 'ok', count: site[c.account].chests };
      frame.progress(i + 1, CHARS.length);
      renderTable();
    }
    frame.end(op);
    if (!frame.alive()) return;
    st.scanned = !op.cancelled;
    if (st.scanned) st.stale = false;
    frame.status(op.cancelled ? '⏹ Проверка остановлена — обновите данные' : '✅ Демо-проверка сундуков завершена');
    renderSide();
    renderTable();
    renderFooter();
  }
  async function run(dry) {
    if (frame.busy || st.confirming || !st.scanned || st.stale) return;
    const work = plan().filter(p => p.run);
    if (!work.length) return;
    if (!dry) {
      st.confirming = true;
      renderFooter();
      const ok = await confirmDemo('Открыть сундуки?', 'Все найденные «Сундуки караванщика» будут открыты.');
      st.confirming = false;
      if (!frame.alive()) return;
      if (!ok) {
        renderFooter();
        return;
      }
    }
    const op = frame.begin('run');
    st.results = {};
    frame.result.textContent = '';
    renderSide();
    renderTable();
    renderFooter();
    let opened = 0;
    for (let i = 0; i < work.length; i++) {
      const { c } = work[i];
      if (op.cancelled || !frame.alive()) break;
      frame.status(`${dry ? '👁 Пробная проверка' : '📦 Демо-открытие'}: ${c.nick}`, true);
      await sleep(ACTION_DELAY);
      if (op.cancelled || !frame.alive()) break;
      const n = site[c.account].chests;
      st.results[c.id] = dry ? `👁 Найдено ${n}, ничего не открыто` : `✅ Открыто в демо: ${n}`;
      if (!dry) {
        site[c.account].chests = 0;
        opened += n;
      }
      frame.progress(i + 1, work.length);
      renderTable();
    }
    frame.end(op);
    if (!frame.alive()) return;
    st.stale = opened > 0;
    frame.status(op.cancelled ? '⏹ Остановлено' : dry ? '👁 Пробная проверка завершена' : '✅ Демо-открытие завершено');
    frame.result.textContent = dry
      ? 'Пробный запуск: сундуки не изменились.'
      : opened
        ? 'Инвентарь изменён только в макете. Обновите данные перед повторным запуском.'
        : '';
    renderSide();
    renderTable();
    renderFooter();
  }
  bindFooter(frame, { scan, run });
  renderSide();
  renderTable();
  renderFooter();
  void scan();
  return frame.dlg;
}

/** В лаборатории все операции открываются только в варианте B. */
export function openScenario(id) {
  const open = { transfer: openTransferSplit, shop: openShopSplit, caravan: openCaravanSplit }[id];
  if (!open) {
    toast('Неизвестный сценарий', 'warning');
    return null;
  }
  return open();
}

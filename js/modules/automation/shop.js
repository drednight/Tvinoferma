// js/modules/automation/shop.js
// 🪙 Покупка за Древние монеты (магазин подарков, chests2.php): диалог «предметы → аккаунты и количество → запуск → итоги».
// Цены, наличие, описание и лимиты всегда читаются с сайта при открытии окна (команда read_shop); данные прошлого чтения
// показываются сразу, пока идёт новое. Покупка: shopRunner.js (команда buy_shop_item), хранение: shopStore.js,
// чистая логика: shopCore.js. Правила: docs/COMPLIANCE.md.

import { state } from '../../core/state.js';
import { toast, confirmModal } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { startTask } from '../../core/taskLog.js';
import { errorText } from '../../core/errorCodes.js';
import { formatCoins, applyCoinBalance, roundCoins } from '../../core/coins.js';
import { persist } from '../../core/storage.js';
import { openOverlay } from '../marathons/overlay.js';
import { partiesOf, NO_PARTY, NO_PARTY_LABEL } from '../parties/membership.js';
import { runQueue, isRetryableCode } from '../sync/queue.js';
import {
  SHOP_ITEMS, wantedNames, normalizeScan, groupAccounts, pickRepresentative, planAccount, canAffordAny, sortByAffordability,
  limitView, resultInfo, resultLabel, summarizeRows, isTransient
} from './shopCore.js';
import {
  charSiteMap, loadCatalog, saveScan, getAccount, applyHistory, accountNeedsHistory, recordPurchase, setAccountBalance, pruneShopState, recordShopRow
} from './shopStore.js';
import { runShopBatch } from './shopRunner.js';
import { openShopLog } from './shopLogView.js';

const dot = (c) => (c.isLoggedIn === true ? '🟢' : c.isLoggedIn === false ? '🔴' : '⚪');
const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');
const fmt = (n) => formatCoins(n);
const clock = (d) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const MAX_QTY = 999;
const unitOf = (def, item) => ((def?.chest || item?.kind === 'chest') ? 'сундук.' : 'шт.');

const SCAN_FAIL = {
  nologin: 'нет входа на сайт',
  challenge: 'сайт показал проверку безопасности',
  error: 'не удалось прочитать магазин'
};

/**
 * Открывает диалог покупки за Древние монеты.
 * @param {{ ids?: string[] }} [opts] ids — персонажи, отмеченные заранее (например, в режиме «Выбрать»)
 */
export function openShopDialog({ ids = [] } = {}) {
  if (!state.characters.length) { toast('Сначала добавьте персонажей', 'info'); return null; }

  const preset = new Set(ids.filter(id => state.characters.some(c => c.id === id)));
  const accSel = new Set(preset);          // отмеченные персонажи; аккаунт отмечен, если отмечен любой его персонаж
  const picked = new Set();                // выбранные предметы (ключи SHOP_ITEMS)
  const qtyMap = new Map();                // `${id персонажа}|${ключ предмета}` → количество (запоминается для всех персонажей аккаунта)
  const scanInfo = new Map();              // id персонажа → { status: pending|ok|nologin|challenge|error, error }
  let party = '';
  let search = '';
  let phase = 'pick';                      // pick | running | results
  let view = [];                           // аккаунты, показанные в таблице (индекс = data-g)
  let lastScan = null;                     // последнее успешное чтение магазина: цены и наличие предметов
  let scanning = false;
  let scanDone = 0;
  let scanTotal = 0;
  let scanAt = null;
  let scanSignal = null;
  let running = null;                      // { cancelled } пока идёт покупка
  let renderTimer = null;
  let closed = false;
  let last = null;                         // итог последнего запуска: { rows, accounts, dry, stopped, checking, balances }

  const dlg = openOverlay({
    title: '🪙 Покупка за Древние монеты', wide: true,
    onClose: () => { closed = true; clearTimeout(renderTimer); if (running) running.cancelled = true; if (scanSignal) scanSignal.cancelled = true; }
  });
  dlg.body.classList.add('shop-body');
  const alive = () => !closed && dlg.el.isConnected;
  const q = (sel) => dlg.body.querySelector(sel);

  /* ----------------------- данные об аккаунтах ----------------------- */

  const anyMember = (g, set) => g.members.some(m => set.has(m.id));
  const getQty = (g, key) => { for (const m of g.members) { const v = qtyMap.get(`${m.id}|${key}`); if (v != null) return v; } return 0; };
  const setQty = (g, key, n) => g.members.forEach(m => qtyMap.set(`${m.id}|${key}`, n));
  const setSel = (g, on) => g.members.forEach(m => { if (on) accSel.add(m.id); else accSel.delete(m.id); });
  const isSel = (g) => anyMember(g, accSel);
  const pickedDefs = () => SHOP_ITEMS.filter(d => picked.has(d.key));

  function infoOf(g) {
    const list = g.members.map(m => scanInfo.get(m.id)).filter(Boolean);
    return list.find(i => i.status === 'ok') || list.find(i => i.status === 'pending') || list[0] || null;
  }

  /** Состояние аккаунта в таблице: ready — можно покупать; pending — читается; nologin/challenge/error — нельзя; nodata — данных нет. */
  function buildGroup(g) {
    const rep = pickRepresentative(g.members, preset);
    const acct = getAccount(g.siteKey);
    const info = infoOf(g);
    let st;
    if (!rep) st = 'nologin';
    else if (info && !['ok', 'pending'].includes(info.status)) st = info.status;
    else if (info?.status === 'pending' && !acct) st = 'pending';
    else if (acct) st = 'ready';
    else st = scanning ? 'pending' : 'nodata';
    const fresh = info?.status === 'ok';
    const latest = [...g.members].sort((a, b) => String(b.lastCoinUpdate || '').localeCompare(String(a.lastCoinUpdate || '')))[0];
    const shown = rep || g.members[0];
    return {
      ...g, rep, acct, state: st, fresh, error: info?.error || null,
      nick: shown.nick, others: g.members.filter(m => m !== shown).map(m => m.nick),
      account: acct?.account || '',
      items: acct?.items || {}, tracks: acct?.tracks || {},
      balance: acct ? acct.balance : roundCoins(latest?.ancientCoins || 0),
      balanceSite: !!acct
    };
  }

  const allGroups = () => groupAccounts(state.characters, charSiteMap()).map(buildGroup);

  const partyNames = (g) => [...new Set(g.members.flatMap(m => partiesOf(m, state.parties).map(p => p.name)))];

  function matches(g) {
    if (party === NO_PARTY) { if (!g.members.some(m => partiesOf(m, state.parties).length === 0)) return false; }
    else if (party && !g.members.some(m => partiesOf(m, state.parties).some(p => p.id === party))) return false;
    const text = search.trim().toLowerCase();
    if (!text) return true;
    const hay = [g.account, ...g.members.flatMap(m => [m.nick, m.className, m.cls, ...(m.tags || [])]), ...partyNames(g)].join(' ').toLowerCase();
    return hay.includes(text);
  }

  const canBuyAny = (g) => g.state === 'ready' && canAffordAny(g.balance, SHOP_ITEMS.map(d => g.items[d.key]));

  /**
   * Порядок строк: сначала те, кому хватает монет хотя бы на один предмет списка, затем остальные; внутри групп — по балансу
   * (больше монет — выше, чем меньше, тем ниже), при равенстве — по нику. Аккаунты без входа и с ошибкой чтения — внизу.
   */
  function sortGroups(list) {
    const ready = list.filter(g => g.state === 'ready');
    const rest = list.filter(g => g.state !== 'ready').sort((a, b) => {
      const rank = (g) => (g.state === 'pending' || g.state === 'nodata' ? 0 : 1);
      return rank(a) - rank(b) || b.balance - a.balance || byNick(a, b);
    });
    return [...sortByAffordability(ready, { can: canBuyAny, nick: (g) => g.nick, balance: (g) => g.balance }), ...rest];
  }

  /** Данные предмета с сайта: свежее чтение, иначе то, что запомнено с прошлого раза. */
  function siteItem(key) {
    const def = SHOP_ITEMS.find(d => d.key === key);
    const cat = loadCatalog()[key];
    if (lastScan) {
      const it = lastScan.items[key];
      return { ...it, desc: it.desc || cat?.desc || '', fresh: true };
    }
    if (cat) return { key, name: def.name, found: true, price: cat.price ?? null, desc: cat.desc || '', kind: cat.kind || '', fresh: false };
    return null;
  }

  /* ----------------------------- чтение сайта ----------------------------- */

  const scheduleRender = () => {
    if (!alive() || phase !== 'pick') return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      if (!alive() || phase !== 'pick') return;
      const a = document.activeElement;
      if (a && dlg.body.contains(a) && a.matches('input.shop-qty, input[data-all]')) { scheduleRender(); return; }   // не сбиваем ввод
      renderDynamic();
    }, 120);
  };

  async function scanAll() {
    if (scanSignal) scanSignal.cancelled = true;
    const signal = scanSignal = { cancelled: false };
    const groups = groupAccounts(state.characters, charSiteMap());
    const targets = groups.map(g => ({ g, rep: pickRepresentative(g.members, preset) })).filter(t => t.rep)
      .sort((a, b) => Number(anyMember(b.g, accSel)) - Number(anyMember(a.g, accSel)));
    scanInfo.clear();
    lastScan = null;
    targets.forEach(t => t.g.members.forEach(m => scanInfo.set(m.id, { status: 'pending' })));
    scanning = targets.length > 0;
    scanDone = 0;
    scanTotal = targets.length;
    scanAt = null;
    renderDynamic();
    if (!targets.length) return;

    const { invoke } = await import('@tauri-apps/api/core');
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    await runQueue(targets, async (t, attempt) => {
      if (signal.cancelled) return { skipped: true };
      const res = await invoke('read_shop', { charId: t.rep.id, wanted: wantedNames(), timeoutSeconds: 20 + attempt * 10, closeAfter: true });
      const scan = normalizeScan(res);
      if (scan && !signal.cancelled) {
        const { siteKey } = saveScan([t.rep.id, ...t.g.members.map(m => m.id).filter(id => id !== t.rep.id)], scan);
        if (accountNeedsHistory(siteKey)) {
          // Лимит тронут, а когда была последняя покупка — неизвестно: срок обновления берётся из «Истории монет»
          try {
            const h = await invoke('read_shop_history', { charId: t.rep.id, timeoutSeconds: 20, closeAfter: true });
            if (h?.status === 'ok' && Array.isArray(h.rows)) applyHistory(siteKey, h.rows);
          } catch { /* история не обязательна: срок просто останется неизвестным */ }
        }
      }
      return { res, scan };
    }, {
      retries, retryDelayMs, signal,
      shouldRetry: (r, err) => !!err || (!r?.skipped && r?.res?.status === 'error' && (isRetryableCode(r.res.error) || isTransient(r.res.error))),
      onDone: ({ item, result, error }) => {
        if (result?.skipped || signal.cancelled) return;
        scanDone++;
        const res = result?.res;
        let info;
        if (result?.scan) { info = { status: 'ok' }; lastScan = result.scan; scanAt = new Date(); }
        else if (res?.status === 'not_logged_in') info = { status: 'nologin' };
        else if (res?.status === 'challenge') info = { status: 'challenge' };
        else info = { status: 'error', error: error ? String(error?.message || error) : (res?.error || (res?.status === 'ok' ? 'bad_response' : null)) };
        item.g.members.forEach(m => scanInfo.set(m.id, info));
        scheduleRender();
      }
    });
    if (signal.cancelled || !alive()) return;
    scanning = false;
    // Предметы, которых больше нет на сайте, из выбора убираются
    picked.forEach(key => { const it = siteItem(key); if (lastScan && !it?.found) picked.delete(key); });
    if (phase === 'pick') renderDynamic();
  }

  /* ------------------------------ вид выбора ------------------------------ */

  function cardHtml(def, groups) {
    const it = siteItem(def.key);
    const known = !!it;
    const found = !!it?.found;
    const locked = !found;
    const exhausted = groups.filter(g => g.state === 'ready' && g.fresh && g.items[def.key]?.found && g.items[def.key].available === 0).length;
    const ready = groups.filter(g => g.state === 'ready' && g.fresh).length;
    let price;
    if (!known) price = scanning ? '⏳ читаю сайт…' : '❔ нет данных с сайта';
    else if (!found) price = def.event ? `🔒 сейчас нет на сайте (раньше ${def.oldPrice} монет)` : '🔒 сейчас нет на сайте';
    else price = it.price != null ? `${fmt(it.price)} мон.${unitOf(def, it) === 'сундук.' ? ' за сундук' : ''}` : 'цена не прочитана';
    const hint = [
      known && !it.fresh ? 'данные прошлого чтения' : '',
      found && exhausted ? `лимит исчерпан у ${exhausted} из ${ready}` : ''
    ].filter(Boolean).join(' · ');
    const desc = found && it.desc ? `<details class="shop-desc"><summary>Описание</summary><div>${escapeHtml(it.desc).replace(/\n/g, '<br>')}</div></details>` : '';
    return `<div class="shop-card${locked ? ' shop-locked' : ''}${picked.has(def.key) ? ' shop-picked' : ''}" data-card="${def.key}">
      <label class="shop-pick"><input type="checkbox" data-item="${def.key}" ${picked.has(def.key) ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span>${def.icon}</span><b>${escapeHtml(def.name)}</b></label>
      <div class="shop-price">${escapeHtml(price)}</div>
      ${hint ? `<div class="shop-muted">${escapeHtml(hint)}</div>` : ''}${desc}</div>`;
  }

  function cellHtml(g, def, idx) {
    const item = g.items[def.key];
    if (!item?.found) return '<span class="shop-muted">нет на сайте</span>';
    const lv = limitView(item, g.tracks[def.key]);
    const limit = lv ? `<div class="shop-limit${lv.exhausted ? ' shop-limit-out' : ''}">${escapeHtml(lv.text)}</div>` : '';
    if (!item.buyable) return `<span class="shop-muted">${lv?.exhausted ? 'лимит исчерпан' : 'купить нельзя'}</span>${limit}`;
    const n = getQty(g, def.key);
    return `<input class="input shop-qty" type="number" min="0" step="1" inputmode="numeric" placeholder="0" data-qty="${idx}|${def.key}" value="${n || ''}"
      aria-label="${escapeHtml(`${g.nick}: ${def.name}`)}"><div class="shop-calc" data-calc="${idx}|${def.key}"></div>${limit}`;
  }

  function rowHtml(g, idx, defs) {
    const ok = g.state === 'ready';
    const parties = partyNames(g).join(', ');
    const bal = g.balanceSite ? `<b>${fmt(g.balance)}</b> <span class="shop-muted">с сайта${g.fresh ? '' : ', прошлое чтение'}</span>`
      : `<b>${fmt(g.balance)}</b> <span class="shop-muted">по данным приложения</span>`;
    let cells;
    if (ok) cells = `${defs.map(d => `<td>${cellHtml(g, d, idx)}</td>`).join('')}<td class="shop-total" data-total="${idx}"></td>`;
    else {
      const msg = g.state === 'pending' ? '⏳ читаю данные сайта…' : g.state === 'nodata' ? '❔ данных с сайта нет — нажмите «Обновить»'
        : `⚠ ${SCAN_FAIL[g.state] || SCAN_FAIL.error}${g.error && g.state === 'error' ? ` (${errorText(g.error)})` : ''}`;
      cells = `<td colspan="${defs.length + 1}" class="shop-muted">${escapeHtml(msg)}</td>`;
    }
    return `<tr class="shop-row${ok ? '' : ' shop-dim'}" data-g="${idx}">
      <td><input type="checkbox" data-sel="${idx}" ${isSel(g) && ok ? 'checked' : ''} ${ok ? '' : 'disabled'} aria-label="${escapeHtml(g.nick)}"></td>
      <td><b>${escapeHtml(g.nick)}</b> ${dot(g.rep || g.members[0])}${g.others.length ? `<div class="shop-muted">также: ${escapeHtml(g.others.join(', '))}</div>` : ''}
        ${parties ? `<div class="shop-muted">${escapeHtml(parties)}</div>` : ''}</td>
      <td>${bal}</td>${cells}</tr>`;
  }

  function tableHtml() {
    const defs = pickedDefs();
    view = sortGroups(allGroups().filter(matches));
    if (!view.length) return '<div class="shop-empty">Никого не найдено</div>';
    const head = defs.map(d => {
      const it = siteItem(d.key);
      const short = d.name.replace(/\s*\([^)]*\)\s*$/, '');
      const price = it?.price != null ? `${fmt(it.price)} мон.${unitOf(d, it) === 'сундук.' ? ' / сундук' : ''}` : '—';
      return `<th class="shop-col"><div class="shop-th" title="${escapeHtml(d.name)}"><div class="shop-th-name">${d.icon} ${escapeHtml(short)}</div>
        <div class="shop-th-price">${escapeHtml(price)}</div>
        <input class="input shop-all" type="number" min="0" step="1" placeholder="всем" data-all="${d.key}" title="Количество для всех отмеченных аккаунтов"></div></th>`;
    }).join('');
    return `<table class="shop-table"><thead><tr><th></th><th>Аккаунт</th><th>Монеты</th>${head}<th>Итого / остаток</th></tr></thead>
      <tbody>${view.map((g, i) => rowHtml(g, i, defs)).join('')}</tbody></table>
      ${defs.length ? '' : '<p class="shop-muted">Отметьте предметы выше — появятся поля количества.</p>'}`;
  }

  const partyOptions = () => `<option value="">Все пати</option><option value="${NO_PARTY}" ${party === NO_PARTY ? 'selected' : ''}>${NO_PARTY_LABEL}</option>${
    (state.parties || []).map(p => `<option value="${escapeHtml(p.id)}" ${party === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}`;

  function renderPick() {
    phase = 'pick';
    dlg.sub.textContent = 'Цены, наличие и баланс читаются с сайта при открытии окна. Покупка необратима — запрос подтверждается.';
    dlg.body.innerHTML = `
      <div class="shop-scan" id="shop-scan"></div>
      <div class="shop-cards" id="shop-items"></div>
      <div class="shop-quick">
        <select class="input" id="shop-party" aria-label="Пати">${partyOptions()}</select>
        <input class="input" id="shop-search" placeholder="Поиск: ник, пати, тег, аккаунт" value="${escapeHtml(search)}">
        <button class="btn ghost small" data-q="all">☑ Выбрать всех</button>
        <button class="btn ghost small" data-q="none">Снять выбор</button>
        <button class="btn ghost small" data-q="refresh" title="Заново прочитать магазин и баланс каждого аккаунта">🔄 Обновить цены и баланс</button>
      </div>
      <div class="shop-count" id="shop-count"></div>
      <div class="shop-scroll" id="shop-table"></div>
      <div class="shop-summary" id="shop-summary"></div>`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="log">📜 Журнал</button>
      <span style="flex:1"></span>
      <button class="btn ghost" data-act="close">Закрыть</button>
      <button class="btn secondary" data-act="dry" title="Откроет магазин и найдёт кнопку «Купить», но не нажмёт её: ничего не покупается и не записывается">👁 Пробный запуск</button>
      <button class="btn primary" data-act="start">🪙 Купить</button>`;
    renderDynamic();
  }

  /** Всё, что зависит от данных сайта и выбора. Строки с полями ввода пересобираются только вызовом из scheduleRender (не во время ввода). */
  function renderDynamic() {
    if (!alive() || phase !== 'pick') return;
    const groups = allGroups();
    q('#shop-items').innerHTML = SHOP_ITEMS.map(d => cardHtml(d, groups)).join('');
    q('#shop-table').innerHTML = tableHtml();
    const failed = groups.filter(g => ['nologin', 'challenge', 'error'].includes(g.state) && g.rep).length;
    const pct = scanTotal ? Math.round(scanDone / scanTotal * 100) : 0;
    q('#shop-scan').innerHTML = scanning ? `⏳ Проверка на сайте: <b>${pct}%</b> (${scanDone} из ${scanTotal} аккаунтов)<div class="shop-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`
      : scanAt ? `✅ Данные с сайта на ${escapeHtml(clock(scanAt))}${failed ? ` · не прочитано: ${failed}` : ''}`
        : (scanTotal ? `⚠ Не удалось прочитать сайт${failed ? `: ${failed}` : ''} — показаны данные прошлого чтения, если они есть` : '⚠ Нет персонажей с входом: чтение сайта невозможно');
    updatePlans();
    dlg.foot.querySelectorAll('[data-act="start"],[data-act="dry"]').forEach(b => { b.disabled = scanning; });
  }

  function planFor(g) {
    return planAccount({
      balance: g.balance,
      orders: pickedDefs().map(d => {
        const it = g.items[d.key];
        return { key: d.key, requested: getQty(g, d.key), price: it?.buyable ? it.price : null, available: it?.available ?? null };
      })
    });
  }

  /** Обновляет «цена × кол = сумма», остаток и общий итог, не трогая поля ввода. */
  function updatePlans() {
    let qty = 0, spent = 0, accounts = 0, count = 0;
    view.forEach((g, i) => {
      if (g.state !== 'ready') return;
      const plan = planFor(g);
      pickedDefs().forEach(d => {
        const box = [...dlg.body.querySelectorAll('[data-calc]')].find(el => el.dataset.calc === `${i}|${d.key}`);
        const row = plan.rows.find(r => r.key === d.key);
        if (!box || !row) return;
        const it = g.items[d.key];
        if (!row.requested) { box.innerHTML = ''; return; }
        const unit = unitOf(d, it);
        const cap = row.qty < row.requested ? `<div class="shop-warn">купится ${row.qty} из ${row.requested} (${row.cap === 'limit' ? 'лимит' : 'не хватает монет'})</div>` : '';
        box.innerHTML = `<span>${fmt(row.price)} × ${row.qty} ${unit} = <b>${fmt(row.cost)}</b></span>${cap}`;
      });
      const tot = [...dlg.body.querySelectorAll('[data-total]')].find(el => el.dataset.total === String(i));
      if (tot) tot.innerHTML = plan.requested ? `<div>Итого: <b>${fmt(plan.spent)}</b></div><div class="${plan.left < 0 ? 'shop-warn' : 'shop-muted'}">остаток: ${fmt(plan.left)}</div>` : `<span class="shop-muted">остаток: ${fmt(g.balance)}</span>`;
      if (isSel(g)) { count++; if (plan.qty) { accounts++; qty += plan.qty; spent += plan.spent; } }
    });
    const sel = q('#shop-count');
    if (sel) sel.textContent = `Отмечено аккаунтов: ${count} из ${view.filter(g => g.state === 'ready').length}${view.length < allGroups().length ? ' (с учётом фильтра)' : ''}`;
    const sum = q('#shop-summary');
    if (sum) sum.innerHTML = qty ? `К покупке: <b>${qty}</b> шт. на <b>${fmt(spent)}</b> мон. у аккаунтов: ${accounts}` : '<span class="shop-muted">Выберите предметы, отметьте аккаунты и укажите количество.</span>';
  }

  /* ------------------------------ запуск ------------------------------ */

  /** Что покупать: отмеченные аккаунты с вводом, количество уже ограничено лимитом и монетами. */
  function buildAccounts() {
    const defs = pickedDefs();
    return view.filter(g => g.state === 'ready' && g.rep && isSel(g)).map(g => {
      const plan = planFor(g);
      const orders = plan.rows.filter(r => r.requested > 0 && g.items[r.key]?.found).map(r => ({
        key: r.key, qty: r.qty, requested: r.requested, price: g.items[r.key].price, available: g.items[r.key].available, cap: r.cap
      }));
      return { siteKey: g.siteKey, char: g.rep, members: g.members, account: g.account, balance: g.balance, orders };
    }).filter(a => a.orders.length && defs.length);
  }

  const totalQty = (accounts) => accounts.reduce((n, a) => n + a.orders.reduce((m, o) => m + o.qty, 0), 0);
  const totalCost = (accounts) => roundCoins(accounts.reduce((n, a) => n + a.orders.reduce((m, o) => m + o.qty * o.price, 0), 0));

  async function launch(dry) {
    if (scanning) { toast('Подождите: идёт чтение сайта', 'info'); return; }
    const accounts = buildAccounts();
    if (!accounts.length) { toast('Отметьте аккаунты и укажите количество', 'warning'); return; }
    const qty = totalQty(accounts);
    if (!qty) { toast('Купить нечего: лимит исчерпан или не хватает монет', 'warning'); return; }
    if (!dry) {
      const lines = SHOP_ITEMS.map(d => {
        const n = accounts.reduce((s, a) => s + (a.orders.find(o => o.key === d.key)?.qty || 0), 0);
        return n ? `${d.name} — ${n}` : '';
      }).filter(Boolean).join('; ');
      const ok = await confirmModal({
        title: 'Купить за Древние монеты?',
        text: `Аккаунтов: ${accounts.length}. ${lines}. Всего ${qty} шт. на ${fmt(totalCost(accounts))} монет. Покупка необратима: вернуть монеты нельзя.`,
        okText: `Купить (${qty})`,
        danger: true
      });
      if (!ok) return;
    }
    await start(accounts, dry);
  }

  const itemName = (key) => SHOP_ITEMS.find(d => d.key === key)?.name || key;
  const cellKey = (a, key) => `${a.siteKey}|${key}`;

  /** «37% (3 из 8)» и полоса готовности. */
  function progressText(done, total) {
    const pct = total ? Math.round(done / total * 100) : 0;
    return `<b>${pct}%</b> (${done} из ${total})<div class="shop-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`;
  }

  function runningHtml(accounts) {
    return `<div class="shop-progress" id="shop-progress">${progressText(0, accounts.reduce((n, a) => n + a.orders.length, 0))}</div>
      <div class="shop-scroll"><table class="shop-table"><thead><tr><th>Аккаунт</th><th>Предмет</th><th>Состояние</th></tr></thead><tbody>${
  accounts.map(a => a.orders.map(o => `<tr><td><b>${escapeHtml(a.char.nick)}</b></td><td>${escapeHtml(itemName(o.key))} × ${o.qty}</td>
    <td data-run="${escapeHtml(cellKey(a, o.key))}"><span class="shop-muted">⏳ в очереди</span></td></tr>`).join('')).join('')}</tbody></table></div>`;
  }

  async function start(accounts, dry) {
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');
    const { invoke } = await import('@tauri-apps/api/core');

    const total = accounts.reduce((n, a) => n + a.orders.length, 0);
    const task = startTask(`🪙 Покупка${dry ? ' (пробный запуск)' : ''}: ${accounts.length} акк., ${totalQty(accounts)} шт.`, { total, cancelable: true });
    const signal = { cancelled: false };
    running = signal;
    task.onCancel(() => { signal.cancelled = true; });
    task.watch(...accounts.map(a => `char:${a.char.id}`));
    task.setStep(`${accounts.length} акк., по ${browserSlots.max} одновременно`);

    phase = 'running';
    dlg.sub.textContent = dry ? '👁 Пробный запуск: магазин открывается, кнопка ищется, но не нажимается.'
      : 'Идёт покупка: аккаунты обрабатываются несколько одновременно, предметы у каждого — по очереди, штука за штукой.';
    dlg.body.innerHTML = runningHtml(accounts);
    dlg.foot.innerHTML = `<span class="shop-muted" style="flex:1">«Стоп» не начинает новых покупок; начатая закончится и будет учтена.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
    dlg.foot.querySelector('[data-act="stop"]').onclick = (e) => { signal.cancelled = true; e.currentTarget.disabled = true; e.currentTarget.textContent = '⏳ Останавливаю…'; };

    const bought = new Map();
    const setCell = (key, html) => { const td = [...dlg.body.querySelectorAll('[data-run]')].find(el => el.dataset.run === key); if (td) td.innerHTML = html; };
    let rows;
    try {
      rows = await runShopBatch({
        accounts, dryRun: dry, signal, task, invokeFn: invoke, retries, retryDelayMs,
        onPurchase: (info) => {
          // Купленное запоминаем сразу: «Стоп», сбой или закрытие окна ничего не теряют
          recordPurchase(info.acc.siteKey, info.order.key, { at: info.at, balanceAfter: info.balanceAfter, availableBefore: info.availableBefore, availableAfter: info.availableAfter });
          const k = cellKey(info.acc, info.order.key);
          bought.set(k, (bought.get(k) || 0) + 1);
          if (alive()) setCell(k, `<span class="shop-muted">🪙 куплено ${bought.get(k)} из ${info.order.qty}…</span>`);
        },
        onRow: (row, done, all) => {
          recordShopRow(row);
          if (!alive()) return;
          const info = resultInfo(row.status);
          setCell(cellKey({ siteKey: row.siteKey }, row.itemKey), `<span title="${escapeHtml(row.detail || '')}">${info.icon} ${escapeHtml(resultLabel(row))}</span>`);
          const p = q('#shop-progress');
          if (p) p.innerHTML = progressText(done, all);
        }
      });
    } finally {
      running = null;
    }

    const s = summarizeRows(rows);
    if (dry) task.finish(`${signal.cancelled ? 'Остановлено. ' : ''}Пробный запуск: кнопка найдена ${s.dry} из ${s.total}, ничего не куплено`, s.dry === s.total ? 'done' : 'warn');
    else task.finish(`${signal.cancelled ? 'Остановлено. ' : ''}Куплено ${s.bought} шт. на ${fmt(s.spent)} мон.; до лимита ${s.limited}, не хватило монет ${s.noFunds}, неясно ${s.unknown}, ошибок ${s.failed}`,
      s.failed || s.unknown ? 'warn' : 'done');
    rows.filter(r => r.status !== 'skipped').forEach(r => task.log(`${r.nick} · ${r.item}: ${resultLabel(r)}${r.detail ? ` — ${r.detail}` : ''}`, resultInfo(r.status).level === 'error' ? 'error' : 'info'));

    last = { rows, accounts, dry, stopped: signal.cancelled, checking: false, balances: new Map() };
    if (!alive()) { if (!dry) await checkBalances(accounts, last); return; }
    renderResults();
    if (!dry) {
      last.checking = true;
      renderResults();
      await checkBalances(accounts, last);
      last.checking = false;
      if (alive()) renderResults();
    }
  }

  /** После покупок: баланс каждого аккаунта читается с сайта заново; остальным персонажам аккаунта копируется то же значение. */
  async function checkBalances(accounts, res) {
    try {
      const sm = await import('../sync/syncManager.js');
      const reps = accounts.map(a => state.characters.find(c => c.id === a.char.id) || a.char);
      const before = new Map(reps.map(c => [c.id, c.lastCoinUpdate || null]));
      await sm.refreshAllBalances(reps, { title: '💰 Баланс после покупки', onlyLoggedIn: false });
      let copied = false;
      accounts.forEach(a => {
        const rep = reps.find(c => c.id === a.char.id);
        if (!rep || (rep.lastCoinUpdate || null) === before.get(rep.id)) { res.balances.set(a.siteKey, { ok: false }); return; }
        const bal = roundCoins(rep.ancientCoins || 0);
        a.members.forEach(m => {
          const c = state.characters.find(x => x.id === m.id);
          if (c && c !== rep) { applyCoinBalance(c, bal, { note: 'Баланс аккаунта после покупки за Древние монеты' }); copied = true; }
        });
        setAccountBalance(a.siteKey, bal);
        res.balances.set(a.siteKey, { ok: true, balance: bal });
      });
      if (copied) { await persist(); sm.rerenderLists?.(); }
    } catch (e) {
      toast(`Не удалось проверить баланс: ${e?.message || e}`, 'error');
    }
  }

  /* ------------------------------ итоги ------------------------------ */

  function resultsHtml() {
    const { rows, accounts, dry, checking, balances } = last;
    const body = accounts.map(a => {
      const mine = rows.filter(r => r.siteKey === a.siteKey);
      const bc = balances.get(a.siteKey);
      const lastRow = mine[mine.length - 1];
      const expected = lastRow ? lastRow.balanceAfter : a.balance;
      const balCell = dry ? '<span class="shop-muted">не менялся</span>'
        : checking ? '<span class="shop-muted">⏳ проверяю…</span>'
          : bc?.ok ? `<b>${fmt(bc.balance)}</b>${Math.abs(bc.balance - expected) > 0.05 ? ` <span class="shop-warn" title="По покупкам ожидалось ${fmt(expected)}">⚠ ожидалось ${fmt(expected)}</span>` : ''}`
            : `<span class="shop-warn">не проверен (по покупкам ${fmt(expected)})</span>`;
      const others = a.members.filter(m => m.id !== a.char.id).map(m => m.nick);
      return mine.map((r, i) => {
        const info = resultInfo(r.status);
        const detail = [r.detail, r.status === 'error' || r.status === 'unknown' ? errorText(r.code) : '', r.viaHistory ? `подтверждено по «Истории монет»: ${r.viaHistory}` : ''].filter(Boolean).join(' — ');
        return `<tr><td>${i === 0 ? `<b>${escapeHtml(a.char.nick)}</b>${others.length ? `<div class="shop-muted">также: ${escapeHtml(others.join(', '))}</div>` : ''}` : ''}</td>
          <td>${escapeHtml(r.item)}</td>
          <td class="shop-res-${info.level}" title="${escapeHtml(detail)}">${info.icon} ${escapeHtml(resultLabel(r))}${detail && r.status !== 'dry_run' ? `<div class="shop-muted">${escapeHtml(detail)}</div>` : ''}</td>
          <td>${r.spent ? `${fmt(r.spent)} мон.` : '—'}</td><td>${i === 0 ? balCell : ''}</td></tr>`;
      }).join('');
    }).join('');
    return `<div class="shop-scroll"><table class="shop-table"><thead><tr><th>Аккаунт</th><th>Предмет</th><th>Итог</th><th>Потрачено</th><th>Баланс сейчас</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderResults() {
    phase = 'results';
    const { rows, dry, stopped, checking } = last;
    const s = summarizeRows(rows);
    dlg.sub.textContent = dry
      ? `${stopped ? '⏹ Остановлено. ' : ''}👁 Пробный запуск: кнопка найдена ${s.dry} из ${s.total}. Ничего не куплено и не записано в журнал.`
      : `${stopped ? '⏹ Остановлено. ' : ''}Куплено: ${s.bought} шт. на ${fmt(s.spent)} мон.${s.limited ? ` · до лимита: ${s.limited}` : ''}${s.noFunds ? ` · не хватило монет: ${s.noFunds}` : ''}${s.unknown ? ` · неясно: ${s.unknown}` : ''}${s.failed ? ` · проблем: ${s.failed}` : ''}${s.notRun ? ` · не выполнено: ${s.notRun}` : ''}`;
    dlg.body.innerHTML = `${resultsHtml()}
      ${s.unknown ? '<p class="shop-warn">❓ «Результат не распознан»: кнопка нажата, но итог неясен. Проверьте «Историю монет» на сайте; автоматически эти покупки не повторяются.</p>' : ''}
      ${checking ? '<p class="shop-muted">⏳ Проверяю баланс всех аккаунтов этого запуска…</p>' : ''}`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="log">📜 Журнал</button>
      <span style="flex:1"></span>
      <button class="btn ghost" data-act="close">Закрыть</button>
      ${dry ? '<button class="btn secondary" data-act="back">← К выбору</button><button class="btn primary" data-act="real">🪙 Купить по-настоящему</button>'
    : `<button class="btn primary" data-act="again" ${checking ? 'disabled' : ''}>🛒 Активировать другие предметы</button>`}`;
  }

  /* ------------------------------ события ------------------------------ */

  const parseQty = (v) => Math.max(0, Math.min(MAX_QTY, Math.floor(Number(v) || 0)));

  dlg.body.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'shop-search') { search = t.value; q('#shop-table').innerHTML = tableHtml(); updatePlans(); return; }
    if (t.matches('[data-qty]')) {
      const [idx, key] = t.dataset.qty.split('|');
      const g = view[Number(idx)];
      if (!g) return;
      const n = parseQty(t.value);
      setQty(g, key, n);
      if (n > 0 && !isSel(g)) { setSel(g, true); const cb = [...dlg.body.querySelectorAll('[data-sel]')].find(el => el.dataset.sel === idx); if (cb) cb.checked = true; }
      updatePlans();
    }
  });

  dlg.body.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'shop-party') { party = t.value; q('#shop-table').innerHTML = tableHtml(); updatePlans(); return; }
    if (t.matches('[data-item]')) {
      if (t.checked) picked.add(t.dataset.item); else picked.delete(t.dataset.item);
      t.closest('.shop-card')?.classList.toggle('shop-picked', t.checked);
      q('#shop-table').innerHTML = tableHtml();
      updatePlans();
      return;
    }
    if (t.matches('[data-sel]')) {
      const g = view[Number(t.dataset.sel)];
      if (g) { setSel(g, t.checked); updatePlans(); }
      return;
    }
    if (t.matches('[data-all]')) {
      const n = parseQty(t.value);
      const targets = view.filter(g => g.state === 'ready' && isSel(g) && g.items[t.dataset.all]?.buyable);
      if (!targets.length) { toast('Сначала отметьте аккаунты, которые могут купить этот предмет', 'info'); return; }
      targets.forEach(g => setQty(g, t.dataset.all, n));
      q('#shop-table').innerHTML = tableHtml();
      updatePlans();
    }
  });

  dlg.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (!b || phase !== 'pick') return;
    if (b.dataset.q === 'none') accSel.clear();
    if (b.dataset.q === 'all') view.filter(g => g.state === 'ready').forEach(g => setSel(g, true));
    if (b.dataset.q === 'refresh') { if (!scanning) scanAll(); return; }
    q('#shop-table').innerHTML = tableHtml();
    updatePlans();
  });

  dlg.foot.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') { dlg.close(); return; }
    if (act === 'log') { openShopLog(); return; }
    if (act === 'back') { renderPick(); return; }
    if (act === 'start') { await launch(false); return; }
    if (act === 'dry') { await launch(true); return; }
    if (act === 'real') {
      renderPick();
      await launch(false);
      return;
    }
    if (act === 'again') {
      // Другие предметы: выбор и количества сбрасываются, магазин и балансы читаются заново
      picked.clear();
      qtyMap.clear();
      renderPick();
      await scanAll();
    }
  });

  pruneShopState(state.characters.map(c => c.id));
  renderPick();
  scanAll();
  return dlg;
}

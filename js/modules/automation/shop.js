import { siteItemIconHtml } from './siteItemIcon.js';
import { openShopLimits } from './shopLimitsView.js';
import { classIconHtml, stripeCls } from './characterPicker.js';
import { layoutScriptWorkspace } from './scriptWorkspace.js';
// js/modules/automation/shop.js
// <svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Активация подарков: покупка за Древние монеты (магазин подарков, chests2.php): диалог «предметы → аккаунты и количество → запуск → итоги».
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
  SHOP_ITEMS,
  wantedNames,
  normalizeScan,
  groupAccounts,
  pickRepresentative,
  planAccount,
  canAffordAny,
  sortByAffordability,
  limitView,
  resultInfo,
  resultLabel,
  summarizeRows,
  planShopRetry,
  isTransient
} from './shopCore.js';
import {
  charSiteMap,
  loadCatalog,
  saveScan,
  getAccount,
  applyHistory,
  accountNeedsHistory,
  recordPurchase,
  setAccountBalance,
  pruneShopState,
  recordShopRow
} from './shopStore.js';
import { runShopBatch } from './shopRunner.js';
import { openShopLog } from './shopLogView.js';
import { chipsHtml, noteHtml, progressHtml, sectionHtml, setProgress } from './scriptUi.js';
import { makeScriptReport } from './scriptReport.js';
import { openScriptStatistics } from './scriptReportView.js';

const byNick = (a, b) => String(a.nick).localeCompare(String(b.nick), 'ru');
const fmt = n => formatCoins(n);
const clock = d => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const MAX_QTY = 999;
const unitOf = (def, item) => (def?.chest || item?.kind === 'chest' ? 'сундук.' : 'шт.');

/**
 * Открывает диалог «Активация подарков» (покупка за Древние монеты).
 * @param {{ ids?: string[] }} [opts] ids — персонажи, отмеченные заранее (например, в режиме «Выбрать»)
 */
export function openShopDialog({ ids = [] } = {}) {
  if (!state.characters.length) {
    toast('Сначала добавьте персонажей', 'info');
    return null;
  }

  const preset = new Set(ids.filter(id => state.characters.some(c => c.id === id)));
  const initialScope = preset.size
    ? preset
    : new Set(state.characters.filter(c => c.isLoggedIn === true).map(c => c.id));
  const accSel = new Set(initialScope); // отмеченные персонажи; аккаунт отмечен, если отмечен любой его персонаж
  let visibleScope = new Set(initialScope);
  const picked = new Set(); // выбранные предметы (ключи SHOP_ITEMS)
  const qtyMap = new Map(); // `${id персонажа}|${ключ предмета}` → количество (запоминается для всех персонажей аккаунта)
  const scanInfo = new Map(); // id персонажа → { status: pending|ok|nologin|challenge|error, error }
  let party = '';
  let search = '';
  let phase = 'pick'; // pick | running | results
  let view = []; // аккаунты, показанные в таблице (индекс = data-g)
  let lastScan = null; // последнее успешное чтение магазина: цены и наличие предметов
  let scanning = false;
  let scanDone = 0;
  let scanTotal = 0;
  let scanAt = null;
  let scanSignal = null;
  let running = null; // { cancelled } пока идёт покупка
  let renderTimer = null;
  let closed = false;
  let last = null; // итог последнего запуска: { rows, accounts, dry, stopped, checking, balances }
  let confirmingRetry = false;

  const dlg = openOverlay({
    title: '🪙 Активация подарков',
    wide: true,
    onClose: () => {
      closed = true;
      clearTimeout(renderTimer);
      if (running) {
        running.stop?.();
        running.cancelled = true;
      }
      if (scanSignal) scanSignal.cancelled = true;
    }
  });
  dlg.body.classList.add('shop-body');
  dlg.foot.classList.add('sd-foot');
  const alive = () => !closed && dlg.el.isConnected;
  const q = sel => dlg.body.querySelector(sel);

  /* ----------------------- данные об аккаунтах ----------------------- */

  const anyMember = (g, set) => g.members.some(m => set.has(m.id));
  const getQty = (g, key) => {
    for (const m of g.members) {
      const v = qtyMap.get(`${m.id}|${key}`);
      if (v != null) return v;
    }
    return 0;
  };
  const setQty = (g, key, n) => g.members.forEach(m => qtyMap.set(`${m.id}|${key}`, n));
  const setSel = (g, on) =>
    g.members.forEach(m => {
      if (on) accSel.add(m.id);
      else accSel.delete(m.id);
    });
  const isSel = g => g.members.some(m => accSel.has(m.id));
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
    const latest = [...g.members].sort((a, b) =>
      String(b.lastCoinUpdate || '').localeCompare(String(a.lastCoinUpdate || ''))
    )[0];
    const shown = rep || g.members[0];
    const sharedMembers =
      groupAccounts(state.characters, charSiteMap()).find(account => account.siteKey === g.siteKey)?.members ||
      g.members;
    return {
      ...g,
      rep,
      acct,
      state: st,
      fresh,
      error: info?.error || null,
      nick: shown.nick,
      others: sharedMembers.filter(m => m.id !== shown.id).map(m => m.nick),
      account: acct?.account || '',
      items: acct?.items || {},
      tracks: acct?.tracks || {},
      balance: acct ? acct.balance : roundCoins(latest?.ancientCoins || 0),
      balanceSite: !!acct
    };
  }

  const allGroups = () =>
    groupAccounts(
      state.characters.filter(c => visibleScope.has(c.id)),
      charSiteMap()
    ).map(buildGroup);

  const partyNames = g => [...new Set(g.members.flatMap(m => partiesOf(m, state.parties).map(p => p.name)))];

  function matches(g) {
    if (party === NO_PARTY) {
      if (!g.members.some(m => partiesOf(m, state.parties).length === 0)) return false;
    } else if (party && !g.members.some(m => partiesOf(m, state.parties).some(p => p.id === party))) return false;
    const text = search.trim().toLowerCase();
    if (!text) return true;
    const hay = [
      g.account,
      ...g.members.flatMap(m => [m.nick, m.className, m.cls, ...(m.tags || [])]),
      ...partyNames(g)
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(text);
  }

  const canBuyAny = g =>
    g.state === 'ready' &&
    canAffordAny(
      g.balance,
      SHOP_ITEMS.map(d => g.items[d.key])
    );

  /**
   * Порядок строк: сначала те, кому хватает монет хотя бы на один предмет списка, затем остальные; внутри групп — по балансу
   * (больше монет — выше, чем меньше, тем ниже), при равенстве — по нику. Аккаунты без входа и с ошибкой чтения — внизу.
   */
  function sortGroups(list) {
    const ready = list.filter(g => g.state === 'ready');
    const rest = list
      .filter(g => g.state !== 'ready')
      .sort((a, b) => {
        const rank = g => (g.state === 'pending' || g.state === 'nodata' ? 0 : 1);
        return rank(a) - rank(b) || b.balance - a.balance || byNick(a, b);
      });
    return [...sortByAffordability(ready, { can: canBuyAny, nick: g => g.nick, balance: g => g.balance }), ...rest];
  }

  /** Данные предмета с сайта: свежее чтение, иначе то, что запомнено с прошлого раза. */
  function siteItem(key) {
    const def = SHOP_ITEMS.find(d => d.key === key);
    const cat = loadCatalog()[key];
    if (lastScan) {
      const it = lastScan.items[key];
      return {
        ...it,
        desc: it.desc || cat?.desc || '',
        image: it.image || cat?.image || '',
        max: it.max ?? cat?.max ?? null,
        observedMax: cat?.observedMax ?? null,
        fresh: true
      };
    }
    if (cat)
      return {
        key,
        name: def.name,
        found: true,
        price: cat.price ?? null,
        desc: cat.desc || '',
        image: cat.image || '',
        max: cat.max ?? null,
        observedMax: cat.observedMax ?? null,
        kind: cat.kind || '',
        fresh: false
      };
    return null;
  }

  /* ----------------------------- чтение сайта ----------------------------- */

  const scheduleRender = () => {
    if (!alive() || phase !== 'pick') return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      if (!alive() || phase !== 'pick') return;
      const a = document.activeElement;
      if (a && dlg.body.contains(a) && a.matches('input.shop-qty, input[data-all]')) {
        scheduleRender();
        return;
      } // не сбиваем ввод
      renderDynamic();
    }, 120);
  };

  async function scanAll(scope = null) {
    if (scope && !scope.size) {
      toast('Отметьте персонажей в таблице для обновления', 'info');
      return;
    }
    if (scanSignal) scanSignal.cancelled = true;
    const signal = (scanSignal = { cancelled: false });
    const groups = groupAccounts(state.characters, charSiteMap());
    const targets = groups
      .filter(g => !scope || anyMember(g, scope))
      .map(g => ({
        g,
        rep: pickRepresentative(scope ? g.members.filter(member => scope.has(member.id)) : g.members, preset)
      }))
      .filter(t => t.rep)
      .sort((a, b) => Number(anyMember(b.g, accSel)) - Number(anyMember(a.g, accSel)));
    if (!scope) {
      scanInfo.clear();
      lastScan = null;
    }
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
    await runQueue(
      targets,
      async (t, attempt) => {
        if (signal.cancelled) return { skipped: true };
        const res = await invoke('read_shop', {
          charId: t.rep.id,
          wanted: wantedNames(),
          timeoutSeconds: 20 + attempt * 10,
          closeAfter: true
        });
        const scan = normalizeScan(res);
        if (scan && !signal.cancelled) {
          t.g.members.forEach(member =>
            applyCoinBalance(member, scan.balance, { note: 'Баланс аккаунта из магазина подарков', now: scan.at })
          );
          const { siteKey } = saveScan([t.rep.id, ...t.g.members.map(m => m.id).filter(id => id !== t.rep.id)], scan);
          if (accountNeedsHistory(siteKey)) {
            // Лимит тронут, а когда была последняя покупка — неизвестно: срок обновления берётся из «Истории монет»
            try {
              const h = await invoke('read_shop_history', { charId: t.rep.id, timeoutSeconds: 20, closeAfter: true });
              if (h?.status === 'ok' && Array.isArray(h.rows)) applyHistory(siteKey, h.rows);
            } catch {
              /* история не обязательна: срок просто останется неизвестным */
            }
          }
        }
        return { res, scan };
      },
      {
        retries,
        retryDelayMs,
        signal,
        shouldRetry: (r, err) =>
          !!err ||
          (!r?.skipped && r?.res?.status === 'error' && (isRetryableCode(r.res.error) || isTransient(r.res.error))),
        onDone: ({ item, result, error }) => {
          if (result?.skipped || signal.cancelled) return;
          scanDone++;
          const res = result?.res;
          let info;
          if (result?.scan) {
            info = { status: 'ok' };
            lastScan = result.scan;
            scanAt = new Date();
          } else if (res?.status === 'not_logged_in') info = { status: 'nologin' };
          else if (res?.status === 'challenge') info = { status: 'challenge' };
          else
            info = {
              status: 'error',
              error: error
                ? String(error?.message || error)
                : res?.error || (res?.status === 'ok' ? 'bad_response' : null)
            };
          item.g.members.forEach(m => scanInfo.set(m.id, info));
          scheduleRender();
        }
      }
    );
    if (signal.cancelled || !alive()) return;
    scanning = false;
    await persist();
    const { rerenderLists } = await import('../sync/syncManager.js');
    rerenderLists?.();
    // Предметы, которых больше нет на сайте, из выбора убираются
    picked.forEach(key => {
      const it = siteItem(key);
      if (lastScan && !it?.found) picked.delete(key);
    });
    if (phase === 'pick') renderDynamic();
  }

  /* ------------------------------ вид выбора ------------------------------ */

  function cardHtml(def, groups) {
    const it = siteItem(def.key);
    const known = !!it;
    const found = !!it?.found;
    const locked = !found;
    const exhausted = groups.filter(
      g => g.state === 'ready' && g.fresh && g.items[def.key]?.found && g.items[def.key].available === 0
    ).length;
    const ready = groups.filter(g => g.state === 'ready' && g.fresh).length;
    let price;
    if (!known) price = scanning ? '⏳ читаю сайт…' : '❔ нет данных с сайта';
    else if (!found)
      price = def.event ? `🔒 сейчас нет на сайте (раньше ${def.oldPrice} монет)` : '🔒 сейчас нет на сайте';
    else
      price =
        it.price != null
          ? `${fmt(it.price)} мон.${unitOf(def, it) === 'сундук.' ? ' за сундук' : ''}`
          : 'цена не прочитана';
    const hint = [
      known && !it.fresh ? 'данные прошлого чтения' : '',
      found && exhausted ? `лимит исчерпан у ${exhausted} из ${ready}` : ''
    ]
      .filter(Boolean)
      .join(' · ');
    const generalLimit =
      it?.max != null
        ? `Общий лимит сайта: ${fmt(it.max)} на аккаунт (Х в «Доступно: N из Х»). Остаток каждого аккаунта — в таблице.`
        : it?.observedMax != null
          ? `Максимум наблюдений: ${fmt(it.observedMax)} на аккаунт. Это наибольший прочитанный остаток, а не явно объявленная квота сайта.`
          : 'Лимит пока не прочитан.';
    const desc = found
      ? `<details class="shop-desc"><summary>Описание</summary>${it.desc ? `<div>${escapeHtml(it.desc).replace(/\n/g, '<br>')}</div>` : ''}<p class="shop-muted">${escapeHtml(generalLimit)}</p></details>`
      : '';
    return `<div class="shop-card${locked ? ' shop-locked' : ''}${picked.has(def.key) ? ' shop-picked' : ''}" data-card="${def.key}">
      <label class="shop-pick"><input type="checkbox" data-item="${def.key}" ${picked.has(def.key) ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        ${siteItemIconHtml(it?.image, def.name)}<b>${escapeHtml(def.name)}</b><span class="shop-card-check" aria-hidden="true">✓</span></label>
      <div class="shop-price">${escapeHtml(price)}</div>
      ${hint ? `<div class="shop-muted">${escapeHtml(hint)}</div>` : ''}${desc}</div>`;
  }

  function quantityCellHtml(g, def, idx) {
    const item = g.items[def.key];
    if (!item?.found) return '<span class="shop-muted">нет на сайте</span>';
    const lv = limitView(item, g.tracks[def.key]);
    const limit = lv
      ? `<div class="shop-limit${lv.exhausted ? ' shop-limit-out' : ''}">${escapeHtml(lv.text)}</div>`
      : '';
    if (!item.buyable)
      return `<span class="shop-muted">${lv?.exhausted ? 'лимит исчерпан' : 'купить нельзя'}</span>${limit}`;
    const n = getQty(g, def.key);
    return `<input class="input shop-qty" type="number" min="0" max="999" step="1" inputmode="numeric" placeholder="0" data-qty="${idx}|${def.key}" value="${n || ''}"
      aria-label="${escapeHtml(`${g.nick}: ${def.name}`)}"><div class="shop-calc" data-calc="${idx}|${def.key}"></div>${limit}`;
  }

  function tableHtml() {
    const defs = pickedDefs();
    view = sortGroups(allGroups().filter(matches));
    if (!view.length) return '<p class="shop-muted">В выбранной группе никого нет.</p>';
    return `<table class="shop-table"><thead><tr><th>Выбор</th><th>Персонажи</th><th>Древние монеты</th>${defs.map(d => `<th><span class="shop-th-name">${escapeHtml(d.name)}</span><label><input type="checkbox" data-pick-all="${d.key}" ${view.every(g => getQty(g, d.key) > 0) ? 'checked' : ''}> Всем</label></th>`).join('')}</tr></thead><tbody>${view.map((g, i) => `<tr class="shop-row ${stripeCls(g.rep || g.members[0])}" data-g="${i}"><td><input type="checkbox" data-sel="${i}" ${isSel(g) ? 'checked' : ''} aria-label="${escapeHtml(g.nick)}"></td><td>${classIconHtml(g.rep || g.members[0])}<b>${escapeHtml(g.nick)}</b>${g.others.length ? `<small>Также: ${g.others.map(escapeHtml).join(', ')}</small>` : ''}</td><td class="shop-current-balance">${fmt(g.balance)} мон.</td>${defs.map(d => `<td><label><input type="checkbox" data-pick-name="${i}|${d.key}" ${getQty(g, d.key) > 0 ? 'checked' : ''}>${escapeHtml(d.name)}</label></td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function openQuantities(dry = false) {
    if (scanning) return toast('Дождитесь чтения сайта', 'info');
    const groups = view.filter(g => isSel(g) && pickedDefs().some(d => getQty(g, d.key) > 0));
    if (!groups.length) return toast('Выберите персонажей и названия предметов', 'info');
    phase = 'quantity';
    const quantities = openOverlay({
      title: dry ? 'Пробный запуск — количества' : 'Количество подарков',
      wide: true,
      onClose: () => {
        if (phase === 'quantity') renderPick();
      }
    });
    quantities.sub.textContent =
      'Offline-персонажи остаются выбранными; покупка возможна только после проверки входа на сайт. Количества сами по себе ничего не покупают.';
    const defs = pickedDefs();
    quantities.body.innerHTML = `<div class="shop-scroll"><table class="shop-table shop-quantity-table"><thead><tr><th>Персонажи</th><th>Баланс</th>${defs.map(d => `<th><span>${escapeHtml(d.name)}</span><button type="button" class="btn ghost small" data-quantity-max="${d.key}">Максимум</button></th>`).join('')}<th>Сумма / остаток</th></tr></thead><tbody>${groups.map((g, i) => `<tr><td>${classIconHtml(g.rep || g.members[0])}<b>${escapeHtml(g.nick)}</b><small>${g.others.map(escapeHtml).join(', ')}</small>${g.state !== 'ready' ? '<small>Нет подтверждённого входа / данных сайта</small>' : ''}</td><td>${fmt(g.balance)}</td>${defs.map(d => `<td>${getQty(g, d.key) > 0 ? quantityCellHtml(g, d, i) : 'Не выбрано'}</td>`).join('')}<td data-quantity-total="${i}"></td></tr>`).join('')}</tbody></table></div>`;
    const recalc = () =>
      groups.forEach((g, i) => {
        const plan = planFor(g);
        for (const def of defs) {
          const row = plan.rows.find(r => r.key === def.key);
          const box = quantities.body.querySelector(`[data-calc="${i}|${def.key}"]`);
          if (box && row)
            box.textContent = `${fmt(row.price)} × ${row.qty} = ${fmt(row.cost)}${row.qty < row.requested ? ' · Ограничено лимитом / балансом' : ''}`;
        }
        quantities.body.querySelector(`[data-quantity-total="${i}"]`).textContent =
          `Сумма: ${fmt(plan.spent)} · Остаток: ${fmt(plan.left)}${plan.qty < plan.requested ? ' · Объём ограничен балансом / лимитом' : ''}`;
      });
    quantities.body.addEventListener('click', e => {
      const button = e.target.closest('[data-quantity-max]');
      if (!button) return;
      const key = button.dataset.quantityMax;
      groups.forEach((g, i) => {
        if (g.state !== 'ready' || getQty(g, key) <= 0 || !g.items[key]?.buyable) return;
        setQty(g, key, MAX_QTY);
        const qty = planFor(g).rows.find(r => r.key === key)?.qty || 0;
        setQty(g, key, qty);
        const input = quantities.body.querySelector(`[data-qty="${i}|${key}"]`);
        if (input) input.value = String(qty);
      });
      recalc();
    });
    quantities.body.addEventListener('input', e => {
      const t = e.target;
      if (!t.matches('[data-qty]')) return;
      const [i, key] = t.dataset.qty.split('|');
      const g = groups[Number(i)];
      if (!g) return;
      setQty(g, key, parseQty(t.value));
      recalc();
    });
    quantities.foot.innerHTML =
      '<button class="btn ghost" data-quantity-back>Назад</button><button class="btn primary" data-quantity-buy>' +
      (dry ? 'Пробный запуск' : 'Купить') +
      '</button>';
    quantities.foot.querySelector('[data-quantity-back]').onclick = () => quantities.close();
    const buy = quantities.foot.querySelector('[data-quantity-buy]');
    buy.onclick = async () => {
      if (buy.disabled) return;
      buy.disabled = true;
      try {
        phase = 'pick';
        quantities.close();
        await launch(dry);
      } finally {
        if (phase === 'pick' && alive()) renderPick();
      }
    };
    recalc();
  }

  const partyOptions = () =>
    `<option value="">Все пати</option><option value="${NO_PARTY}" ${party === NO_PARTY ? 'selected' : ''}>${NO_PARTY_LABEL}</option>${(
      state.parties || []
    )
      .map(
        p => `<option value="${escapeHtml(p.id)}" ${party === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
      )
      .join('')}`;

  function renderPick() {
    phase = 'pick';
    dlg.sub.textContent =
      'Цены, наличие и баланс читаются с сайта при открытии окна. Покупка необратима — запрос подтверждается.';
    dlg.body.innerHTML = `
      ${noteHtml({
        icon: '◈',
        title: 'Что сделает это окно',
        text:
          'Отмеченные предметы покупаются за Древние монеты на аккаунте сайта: каждый покупается отдельной покупкой, штука за штукой. ' +
          'Баланс и лимиты читаются с сайта прямо сейчас — старые данные показываются, только пока новая проверка идёт.'
      })}
      <div class="tr-top"><button type="button" class="btn secondary small" data-q="refresh-all" title="Цены, балансы и доступные лимиты всех аккаунтов">🔄 Обновить цены и балансы</button></div>
      <div class="shop-scan" id="shop-scan"></div>
      ${sectionHtml('Предметы магазина', { hint: 'цены, наличие и лимиты — с сайта', body: `<div class="shop-cards" id="shop-items"></div>` })}
      ${sectionHtml('Персонажи и выбранные предметы', {
        hint: 'Выберите предметы для каждого персонажа или сразу для всех',
        aside: `<span class="sd-count" id="shop-count"></span>`,
        body: `
        <div class="shop-quick">
          <select class="input" id="shop-party" aria-label="Пати">${partyOptions()}</select>
          <input class="input" id="shop-search" aria-label="Поиск аккаунта" placeholder="Поиск: ник, пати, тег, аккаунт" value="${escapeHtml(search)}">
          <button class="btn ghost small" data-q="all">☑ Выбрать всех</button>
          <button class="btn ghost small" data-q="none">Снять выбор</button>
          <button class="btn ghost small" data-q="refresh" title="Заново прочитать цены, баланс и лимиты только отмеченных аккаунтов">🔄 Обновить цены и баланс</button>
        </div>
        <div class="shop-scroll" id="shop-table"></div>
        <div class="shop-summary" id="shop-summary"></div>`
      })}
      `;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="log">📜 Журнал</button>
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="close">✕ Закрыть</button>
      <button class="btn secondary" data-act="limits">Лимиты и сроки</button>
      <button class="btn secondary" data-act="dry" title="Откроет магазин и найдёт кнопку «Купить», но не нажмёт её: ничего не покупается и не записывается">👁 Пробный запуск</button>
      <button class="btn primary" data-act="start"><svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Далее</button>`;
    renderDynamic();

    layoutScriptWorkspace(
      dlg,
      {
        selected: accSel,
        eligible: () => true,
        apply(ids) {
          visibleScope = new Set(ids);
          accSel.clear();
          ids.filter(id => state.characters.some(c => c.id === id)).forEach(id => accSel.add(id));
          renderPick();
        }
      },
      { initialMode: preset.size ? 'manual' : 'logged' }
    );
  }

  /** Всё, что зависит от данных сайта и выбора. Строки с полями ввода пересобираются только вызовом из scheduleRender (не во время ввода). */
  function renderDynamic() {
    if (!alive() || phase !== 'pick') return;
    const groups = allGroups();
    q('#shop-items').innerHTML = SHOP_ITEMS.map(d => cardHtml(d, groups)).join('');
    q('#shop-table').innerHTML = tableHtml();
    const failed = groups.filter(g => ['nologin', 'challenge', 'error'].includes(g.state) && g.rep).length;
    const pct = scanTotal ? Math.round((scanDone / scanTotal) * 100) : 0;
    q('#shop-scan').innerHTML = scanning
      ? `⏳ Проверка на сайте: <b>${pct}%</b> (${scanDone} из ${scanTotal} аккаунтов)<div class="shop-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`
      : scanAt
        ? `✅ Данные с сайта на ${escapeHtml(clock(scanAt))}${failed ? ` · не прочитано: ${failed}` : ''}`
        : scanTotal
          ? `⚠ Не удалось прочитать сайт${failed ? `: ${failed}` : ''} — показаны данные прошлого чтения, если они есть`
          : '⚠ Нет персонажей с входом: чтение сайта невозможно';
    updatePlans();
    dlg.foot.querySelectorAll('[data-act="start"],[data-act="dry"]').forEach(b => {
      b.disabled = scanning;
    });
  }

  function planFor(g) {
    return planAccount({
      balance: g.balance,
      orders: pickedDefs().map(d => {
        const it = g.items[d.key];
        return {
          key: d.key,
          requested: getQty(g, d.key),
          price: it?.buyable ? it.price : null,
          available: it?.available ?? null
        };
      })
    });
  }

  /** Обновляет «цена × кол = сумма», остаток и общий итог, не трогая поля ввода. */
  function updatePlans() {
    const sel = q('#shop-count');
    if (sel) sel.textContent = `Отмечено: ${view.filter(isSel).length} из ${view.length}`;
    const summary = q('#shop-summary');
    if (summary) {
      summary.replaceChildren();
      summary.hidden = true;
    }
  }

  /* ------------------------------ запуск ------------------------------ */

  /** Что покупать: отмеченные аккаунты с вводом, количество уже ограничено лимитом и монетами. */
  function buildAccounts() {
    const defs = pickedDefs();
    return view
      .filter(g => g.state === 'ready' && g.rep && isSel(g))
      .map(g => {
        const plan = planFor(g);
        const orders = plan.rows
          .filter(r => r.requested > 0 && g.items[r.key]?.found)
          .map(r => ({
            key: r.key,
            qty: r.qty,
            requested: r.requested,
            price: g.items[r.key].price,
            available: g.items[r.key].available,
            cap: r.cap
          }));
        return { siteKey: g.siteKey, char: g.rep, members: g.members, account: g.account, balance: g.balance, orders };
      })
      .filter(a => a.orders.length && defs.length);
  }

  const totalQty = accounts => accounts.reduce((n, a) => n + a.orders.reduce((m, o) => m + o.qty, 0), 0);
  const totalCost = accounts =>
    roundCoins(accounts.reduce((n, a) => n + a.orders.reduce((m, o) => m + o.qty * o.price, 0), 0));

  async function launch(dry) {
    if (scanning) {
      toast('Подождите: идёт чтение сайта', 'info');
      return;
    }
    const accounts = buildAccounts();
    if (!accounts.length) {
      toast('Отметьте аккаунты и укажите количество', 'warning');
      return;
    }
    const qty = totalQty(accounts);
    if (!qty) {
      toast('Купить нечего: лимит исчерпан или не хватает монет', 'warning');
      return;
    }
    if (!dry) {
      const lines = SHOP_ITEMS.map(d => {
        const n = accounts.reduce((s, a) => s + (a.orders.find(o => o.key === d.key)?.qty || 0), 0);
        return n ? `${d.name} — ${n}` : '';
      })
        .filter(Boolean)
        .join('; ');
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

  const itemName = key => SHOP_ITEMS.find(d => d.key === key)?.name || key;
  const cellKey = (a, key) => `${a.siteKey}|${key}`;

  function runningHtml(accounts) {
    return `${progressHtml(
      'shop-progress',
      0,
      accounts.reduce((n, a) => n + a.orders.length, 0)
    )}
      ${sectionHtml('Ход покупки', {
        body: `<div class="shop-scroll"><table class="shop-table"><thead><tr><th>Аккаунт</th><th>Предмет</th><th>Состояние</th></tr></thead><tbody>${accounts
          .map(a =>
            a.orders
              .map(
                o => `<tr class="${stripeCls(a.char)}"><td>${classIconHtml(a.char)}<b>${escapeHtml(a.char.nick)}</b></td><td>${escapeHtml(itemName(o.key))} × ${o.qty}</td>
    <td data-run="${escapeHtml(cellKey(a, o.key))}"><span class="shop-muted">⏳ в очереди</span></td></tr>`
              )
              .join('')
          )
          .join('')}</tbody></table></div>`
      })}`;
  }

  async function start(accounts, dry, { historyReports = [] } = {}) {
    const { scriptSettings } = await import('../sync/syncManager.js');
    const { retries, retryDelayMs } = scriptSettings();
    const { browserSlots } = await import('../sync/queue.js');
    const { invoke } = await import('@tauri-apps/api/core');

    const total = accounts.reduce((n, a) => n + a.orders.length, 0);
    const task = startTask(
      `🪙 Активация подарков${dry ? ' (пробный запуск)' : ''}: ${accounts.length} акк., ${totalQty(accounts)} шт.`,
      { total, cancelable: true }
    );
    const signal = { cancelled: false };
    running = signal;
    signal.stop = () => task.stop();
    task.onCancel(() => {
      signal.cancelled = true;
    });
    // Ждём своей очереди: пока идёт другой скрипт, работу не начинаем
    await task.waitTurn();
    task.watch(...accounts.map(a => `char:${a.char.id}`));
    await task.ready?.();
    task.setStep(`${accounts.length} акк., по ${browserSlots.max} одновременно`);

    phase = 'running';
    dlg.sub.textContent = dry
      ? '👁 Пробный запуск: магазин открывается, кнопка ищется, но не нажимается.'
      : 'Идёт покупка: аккаунты обрабатываются несколько одновременно, предметы у каждого — по очереди, штука за штукой.';
    dlg.body.innerHTML = runningHtml(accounts);
    layoutScriptWorkspace(dlg, undefined, { running: true });
    dlg.foot.innerHTML = `<span class="shop-muted sd-foot-spacer">«Стоп» прерывает текущую работу. Уже отправленный запрос мог выполниться; неизвестный результат не повторяется.</span>
      <button class="btn danger" data-act="stop">⏹ Стоп</button>`;
    dlg.foot.querySelector('[data-act="stop"]').onclick = e => {
      signal.stop?.();
      signal.cancelled = true;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = '⏳ Останавливаю…';
    };

    const bought = new Map();
    const finishedRows = new Map();
    const saveReport = row => {
      finishedRows.set(`${row.siteKey}|${row.itemKey}`, row);
      task.setScriptReport(makeScriptReport('shop', [...finishedRows.values()], { dryRun: dry }));
    };
    const setCell = (key, html) => {
      const td = [...dlg.body.querySelectorAll('[data-run]')].find(el => el.dataset.run === key);
      if (td) td.innerHTML = html;
    };
    let rows;
    try {
      rows = await runShopBatch({
        accounts,
        dryRun: dry,
        signal,
        task,
        invokeFn: invoke,
        retries,
        retryDelayMs,
        onPurchase: info => {
          saveReport(info.row);
          // Купленное запоминаем сразу: «Стоп», сбой или закрытие окна ничего не теряют
          recordPurchase(info.acc.siteKey, info.order.key, {
            at: info.at,
            balanceAfter: info.balanceAfter,
            availableBefore: info.availableBefore,
            availableAfter: info.availableAfter
          });
          const k = cellKey(info.acc, info.order.key);
          bought.set(k, (bought.get(k) || 0) + 1);
          if (alive())
            setCell(
              k,
              `<span class="shop-muted"><svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> куплено ${bought.get(k)} из ${info.order.qty}…</span>`
            );
        },
        onRow: (row, done, all) => {
          saveReport(row);
          recordShopRow(row);
          if (!alive()) return;
          const info = resultInfo(row.status);
          setCell(
            cellKey({ siteKey: row.siteKey }, row.itemKey),
            `<span title="${escapeHtml(row.detail || '')}">${info.icon} ${escapeHtml(resultLabel(row))}</span>`
          );
          setProgress(dlg.body, 'shop-progress', done, all);
        }
      });
    } finally {
      running = null;
    }

    const s = summarizeRows(rows);
    if (dry)
      task.finish(
        `${signal.cancelled ? 'Остановлено. ' : ''}Пробный запуск: кнопка найдена ${s.dry} из ${s.total}, ничего не куплено`,
        s.dry === s.total ? 'done' : 'warn'
      );
    else
      task.finish(
        `${signal.cancelled ? 'Остановлено. ' : ''}Куплено ${s.bought} шт. на ${fmt(s.spent)} мон.; до лимита ${s.limited}, не хватило монет ${s.noFunds}, неясно ${s.unknown}, ошибок ${s.failed}`,
        s.failed || s.unknown ? 'warn' : 'done'
      );
    rows
      .filter(r => r.status !== 'skipped')
      .forEach(r =>
        task.log(
          `${r.nick} · ${r.item}: ${resultLabel(r)}${r.detail ? ` — ${r.detail}` : ''}`,
          resultInfo(r.status).level === 'error' ? 'error' : 'info'
        )
      );

    task.setScriptReport(makeScriptReport('shop', rows, { dryRun: dry }));
    last = {
      rows,
      accounts,
      dry,
      stopped: signal.cancelled,
      checking: false,
      balances: new Map(),
      historyReports: [...historyReports, { ...makeScriptReport('shop', rows, { dryRun: dry }), at: task.startedAt }]
    };
    if (!alive()) {
      if (!dry) await checkBalances(accounts, last);
      return;
    }
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
      // noQueue: мы уже внутри идущего скрипта активации — эта проверка его часть,
      // и ждать в очереди за ним самим собой она не может
      await sm.refreshAllBalances(reps, {
        title: '<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Баланс после покупки',
        onlyLoggedIn: false,
        noQueue: true
      });
      let copied = false;
      accounts.forEach(a => {
        const rep = reps.find(c => c.id === a.char.id);
        if (!rep || (rep.lastCoinUpdate || null) === before.get(rep.id)) {
          res.balances.set(a.siteKey, { ok: false });
          return;
        }
        const bal = roundCoins(rep.ancientCoins || 0);
        const sharedMembers =
          groupAccounts(state.characters, charSiteMap()).find(g => g.siteKey === a.siteKey)?.members || a.members;
        sharedMembers.forEach(m => {
          const c = state.characters.find(x => x.id === m.id);
          if (c && c !== rep) {
            applyCoinBalance(c, bal, { note: 'Баланс аккаунта после покупки за Древние монеты' });
            copied = true;
          }
        });
        setAccountBalance(a.siteKey, bal);
        res.balances.set(a.siteKey, { ok: true, balance: bal });
      });
      if (copied) {
        await persist();
        sm.rerenderLists?.();
      }
    } catch (e) {
      toast(`Не удалось проверить баланс: ${e?.message || e}`, 'error');
    }
  }

  /* ------------------------------ итоги ------------------------------ */

  function resultsHtml() {
    const { rows, accounts, dry, checking, balances } = last;
    const body = accounts
      .map(a => {
        const mine = rows.filter(r => r.siteKey === a.siteKey);
        const bc = balances.get(a.siteKey);
        const lastRow = mine[mine.length - 1];
        const expected = lastRow ? lastRow.balanceAfter : a.balance;
        const balCell = dry
          ? '<span class="shop-muted">не менялся</span>'
          : checking
            ? '<span class="shop-muted">⏳ проверяю…</span>'
            : bc?.ok
              ? `<b>${fmt(bc.balance)}</b>${Math.abs(bc.balance - expected) > 0.05 ? ` <span class="shop-warn" title="По покупкам ожидалось ${fmt(expected)}">⚠ ожидалось ${fmt(expected)}</span>` : ''}`
              : `<span class="shop-warn">не проверен (по покупкам ${fmt(expected)})</span>`;
        const others = a.members.filter(m => m.id !== a.char.id).map(m => m.nick);
        return mine
          .map((r, i) => {
            const info = resultInfo(r.status);
            const detail = [
              r.detail,
              r.status === 'error' || r.status === 'unknown' ? errorText(r.code) : '',
              r.viaHistory ? `подтверждено по «Истории монет»: ${r.viaHistory}` : ''
            ]
              .filter(Boolean)
              .join(' — ');
            return `<tr class="${stripeCls(a.char)}"><td>${
              i === 0
                ? `${classIconHtml(a.char)}<b>${escapeHtml(a.char.nick)}</b>${
                    others.length
                      ? `<div class="shop-muted">также: ${a.members
                          .filter(member => member.id !== a.char.id)
                          .map(member => `${classIconHtml(member)}${escapeHtml(member.nick)}`)
                          .join(', ')}</div>`
                      : ''
                  }`
                : ''
            }</td>
          <td>${escapeHtml(r.item)}</td>
          <td class="shop-res-${info.level}" title="${escapeHtml(detail)}">${info.icon} ${escapeHtml(resultLabel(r))}${detail && r.status !== 'dry_run' ? `<div class="shop-muted">${escapeHtml(detail)}</div>` : ''}</td>
          <td>${r.spent ? `${fmt(r.spent)} мон.` : '—'}</td><td>${i === 0 ? balCell : ''}</td></tr>`;
          })
          .join('');
      })
      .join('');
    return `<div class="shop-scroll"><table class="shop-table"><thead><tr><th>Аккаунт</th><th>Предмет</th><th>Итог</th><th>Потрачено</th><th>Баланс сейчас</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  /** Итог запуска чистыми чипами — только то, что действительно было. */
  const resultChips = (s, dry) =>
    chipsHtml(
      dry
        ? [
            { icon: '👁', label: 'кнопка найдена', value: s.dry, tone: 'ok' },
            { icon: '⏭', label: 'не покупалось', value: s.notRun }
          ]
        : [
            {
              icon: '◈',
              label: 'куплено',
              value: s.bought,
              tone: 'ok'
            },
            { icon: '🔒', label: 'до лимита', value: s.limited, tone: 'warn' },
            { icon: '💸', label: 'не хватило монет', value: s.noFunds, tone: 'warn' },
            { icon: '❓', label: 'неясно', value: s.unknown, tone: 'warn' },
            { icon: '❌', label: 'проблем', value: s.failed, tone: 'err' },
            { icon: '⏭', label: 'не выполнено', value: s.notRun }
          ]
    );

  function renderResults() {
    phase = 'results';
    const { rows, dry, stopped, checking } = last;
    const s = summarizeRows(rows);
    const retryAccounts = dry ? [] : planShopRetry(last.accounts, rows, last.balances);
    dlg.sub.textContent = dry
      ? `${stopped ? '⏹ Остановлено. ' : ''}👁 Пробный запуск: кнопка найдена ${s.dry} из ${s.total}. Ничего не куплено и не записано в журнал.`
      : `${stopped ? '⏹ Остановлено. ' : ''}Куплено: ${s.bought} шт. на ${fmt(s.spent)} мон.${s.limited ? ` · до лимита: ${s.limited}` : ''}${s.noFunds ? ` · не хватило монет: ${s.noFunds}` : ''}${s.unknown ? ` · неясно: ${s.unknown}` : ''}${s.failed ? ` · проблем: ${s.failed}` : ''}${s.notRun ? ` · не выполнено: ${s.notRun}` : ''}`;
    dlg.body.innerHTML = `${resultChips(s, dry)}
      ${sectionHtml('Итог по аккаунтам', { body: resultsHtml() })}
      ${s.unknown ? '<p class="shop-warn">❓ Результат не подтверждён: покупка могла выполниться. Проверьте «Историю монет»; весь этот аккаунт не участвует в повторе.</p>' : ''}
      ${checking ? '<p class="shop-muted">⏳ Проверяю баланс всех аккаунтов этого запуска…</p>' : ''}`;
    dlg.foot.innerHTML = `
      <button class="btn ghost" data-act="log">📜 Журнал</button>
      <button class="btn secondary" data-act="report">📋 Таблица действий</button>
      <span class="sd-foot-spacer"></span>
      <button class="btn ghost" data-act="close">✕ Закрыть</button>
      ${!dry ? `<button class="btn secondary" data-act="retry" ${checking || !retryAccounts.length ? 'disabled' : ''}>🔁 Повторить неудачные${retryAccounts.length ? ` (${retryAccounts.length} акк.)` : ''}</button>` : ''}
      ${
        dry
          ? '<button class="btn secondary" data-act="back">← К выбору</button><button class="btn primary" data-act="real"><svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Купить по-настоящему</button>'
          : `<button class="btn primary" data-act="again" ${checking ? 'disabled' : ''}>🛒 Активировать другие предметы</button>`
      }`;

    layoutScriptWorkspace(dlg);
  }

  /* ------------------------------ события ------------------------------ */

  const parseQty = v => Math.max(0, Math.min(MAX_QTY, Math.floor(Number(v) || 0)));

  dlg.body.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'shop-search') {
      search = t.value;
      q('#shop-table').innerHTML = tableHtml();
      updatePlans();
      return;
    }
    if (t.matches('[data-qty]')) {
      const [idx, key] = t.dataset.qty.split('|');
      const g = view[Number(idx)];
      if (!g) return;
      const n = parseQty(t.value);
      setQty(g, key, n);
      if (n > 0 && !isSel(g)) {
        setSel(g, true);
        const cb = [...dlg.body.querySelectorAll('[data-sel]')].find(el => el.dataset.sel === idx);
        if (cb) cb.checked = true;
      }
      updatePlans();
    }
  });

  dlg.body.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'shop-party') {
      party = t.value;
      q('#shop-table').innerHTML = tableHtml();
      updatePlans();
      return;
    }
    if (t.matches('[data-pick-all]')) {
      view.forEach(g => {
        setQty(g, t.dataset.pickAll, t.checked ? Math.max(1, getQty(g, t.dataset.pickAll)) : 0);
        if (t.checked) setSel(g, true);
      });
      q('#shop-table').innerHTML = tableHtml();
      updatePlans();
      return;
    }
    if (t.matches('[data-pick-name]')) {
      const [i, key] = t.dataset.pickName.split('|');
      const g = view[Number(i)];
      if (g) {
        setQty(g, key, t.checked ? 1 : 0);
        if (t.checked) setSel(g, true);
        q('#shop-table').innerHTML = tableHtml();
        updatePlans();
      }
      return;
    }
    if (t.matches('[data-item]')) {
      if (t.checked) picked.add(t.dataset.item);
      else picked.delete(t.dataset.item);
      t.closest('.shop-card')?.classList.toggle('shop-picked', t.checked);
      q('#shop-table').innerHTML = tableHtml();
      updatePlans();
      return;
    }
    if (t.matches('[data-sel]')) {
      const g = view[Number(t.dataset.sel)];
      if (g) {
        setSel(g, t.checked);
        updatePlans();
      }
      return;
    }
    if (t.matches('[data-all]')) {
      const n = parseQty(t.value);
      const targets = view.filter(g => g.state === 'ready' && isSel(g) && g.items[t.dataset.all]?.buyable);
      if (!targets.length) {
        toast('Сначала отметьте аккаунты, которые могут купить этот предмет', 'info');
        return;
      }
      targets.forEach(g => setQty(g, t.dataset.all, n));
      q('#shop-table').innerHTML = tableHtml();
      updatePlans();
    }
  });

  dlg.body.addEventListener('click', e => {
    const b = e.target.closest('[data-q]');
    if (!b || phase !== 'pick') return;
    if (b.dataset.q === 'none') accSel.clear();
    if (b.dataset.q === 'all') view.forEach(g => setSel(g, true));
    if (b.dataset.q === 'refresh-all') {
      if (!scanning) scanAll();
      return;
    }
    if (b.dataset.q === 'refresh') {
      if (!scanning) scanAll(new Set(accSel));
      return;
    }
    q('#shop-table').innerHTML = tableHtml();
    updatePlans();
  });

  dlg.foot.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act || btn.disabled) return;
    if (act === 'close') {
      dlg.close();
      return;
    }
    if (act === 'log') {
      openShopLog();
      return;
    }
    if (act === 'report') {
      openScriptStatistics(last?.historyReports || [], {
        title: '📋 Таблица действий: подарки',
        note: 'Покупки относятся к общему аккаунту сайта. Подтверждённые, пробные и неясные результаты показаны отдельно.'
      });
      return;
    }
    if (act === 'retry') {
      if (!last || last.dry || last.checking || running || confirmingRetry) return;
      const previous = last;
      const accounts = planShopRetry(previous.accounts, previous.rows, previous.balances);
      if (!accounts.length) return;
      const qty = totalQty(accounts);
      confirmingRetry = true;
      btn.disabled = true;
      let ok;
      try {
        ok = await confirmModal({
          title: 'Повторить неудачные покупки?',
          text: `Будет куплен только оставшийся подтверждённо невыполненный объём: ${qty} шт. на сумму до ${fmt(totalCost(accounts))} монет. Аккаунты с неясным исходом исключены. Покупка необратима.`,
          okText: `Повторить (${qty})`,
          danger: true
        });
      } finally {
        confirmingRetry = false;
        if (btn.isConnected) btn.disabled = false;
      }
      if (ok && alive() && last === previous && !running)
        await start(accounts, false, { historyReports: previous.historyReports });
      return;
    }
    if (act === 'back') {
      renderPick();
      return;
    }
    if (act === 'start') {
      openQuantities(false);
      return;
    }
    if (act === 'limits') {
      openShopLimits({
        refresh: async () => {
          if (scanning) throw new Error('busy');
          await scanAll();
        }
      });
      return;
    }
    if (act === 'dry') {
      openQuantities(true);
      return;
    }
    if (act === 'real') {
      renderPick();
      openQuantities(false);
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

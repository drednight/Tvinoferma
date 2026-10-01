// js/modules/marathons/page.js
// Раздел «Марафоны» v2: список (с сериями-папками), страница серии, страница марафона
// с матрицей прогресса «персонаж × задание», сверкой с сайтом и статистикой монет.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { confirmDialog, toast } from '../../core/ui.js';
import { getAuthView } from '../sync/authStatus.js';
import { openOverlay } from './overlay.js';
import { openMarathonWizard, setWizardSavedHandler } from './wizard.js';
import { syncMarathons, marathonUrlOf, SITE_PAGES, customPages, rememberCustomPage } from './siteSync.js';
import { taskCardHtml, renderDock } from '../../core/taskLog.js';
import {
  computeCell, marathonTotals, freezeAwards, marathonPhase, seriesChildren, seriesPhase,
  ensureCell, STATUS_LABELS, maxRewardCoins, createSeries, bonusStatus
} from './model.js';
import { getAllDatesInRange, isTaskActiveOnDate } from './dates.js';

const view = { type: 'list', id: null };
const ui = { party: 'all', onlyProblems: false, syncing: new Set(), syncQueue: new Set(), syncProgress: null, showSync: true, syncTask: null, syncTaskFor: null };

const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—';
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('ru-RU')}`;
const charById = (id) => state.characters.find(c => c.id === id);
const findM = (id) => state.marathons.find(m => m.id === id);

const ERROR_TEXT = {
  not_logged_in: 'нет авторизации',
  timeout: 'сайт не ответил',
  timeout_parsing_marathon: 'сайт не ответил',
  container_not_found: 'на странице нет марафона',
  no_quests: 'нет заданий на странице'
};

export function openMarathon(id) {
  const m = findM(id);
  view.type = m?.kind === 'series' ? 'series' : 'detail';
  view.id = id;
  ui.party = 'all'; ui.onlyProblems = false;
  renderMarathons();
}

setWizardSavedHandler((id) => openMarathon(id));

/* ================================================================== */
/*  Точка входа                                                        */
/* ================================================================== */

export function renderMarathons() {
  const root = document.getElementById('marathon-list');
  if (!root) return;
  try {
    if (view.type === 'detail' && findM(view.id)) renderDetail(root, findM(view.id));
    else if (view.type === 'series' && findM(view.id)) renderSeries(root, findM(view.id));
    else { view.type = 'list'; renderList(root); }
    renderDock();
  } catch (err) {
    console.error('[MARATHONS RENDER]', err);
    root.innerHTML = `<div class="empty-state" style="color:var(--danger)">Ошибка отображения марафонов: ${escapeHtml(err.message)}</div>`;
  }
}

export function bindMarathons() {
  document.getElementById('add-marathon-btn')?.addEventListener('click', () => openMarathonWizard());
  document.getElementById('add-folder-btn')?.addEventListener('click', () => openFolderDialog());
  renderMarathons();
}

/** Возврат к списку марафонов (клик по вкладке «Марафоны»). */
export function resetMarathonView() {
  view.type = 'list'; view.id = null;
}

/* ================================================================== */
/*  Папки                                                              */
/* ================================================================== */

/** Создание / настройка папки: название, описание (признак деления), страница для сверки. */
function openFolderDialog(folder = null) {
  const isNew = !folder;
  const f = folder || createSeries({ title: '', source: { type: 'manual', url: null } });
  const ov = openOverlay({ title: isNew ? '📁 Новая папка' : `📁 Настройки папки «${folder.title}»` });
  const pages = [...SITE_PAGES, ...customPages().map(u => ({ url: u, label: u.replace('https://', '') }))];
  const cur = f.source?.url || '';
  const known = !cur || pages.some(p => p.url === cur);
  ov.body.innerHTML = `
    <div class="field"><label>Название *</label><input class="input" data-k="title" value="${escapeHtml(f.title)}" placeholder="Например: Летний супермарафон"/></div>
    <div class="field"><label>Описание / как разделены марафоны</label><input class="input" data-k="description" value="${escapeHtml(f.description || '')}" placeholder="По месяцам, по неделям, по пати…"/></div>
    <div class="field"><label>Страница на сайте для сверки (по умолчанию для марафонов папки)</label>
      <select class="select" data-k="url">
        <option value="">— не сверять —</option>
        ${pages.map(p => `<option value="${escapeHtml(p.url)}" ${cur === p.url ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
        <option value="__custom__" ${known ? '' : 'selected'}>✏️ Своя ссылка…</option>
      </select>
      <input class="input ${known ? 'tf-hidden' : ''}" data-k="custom" value="${known ? '' : escapeHtml(cur)}" placeholder="https://pwonline.ru/…"/>
      <small class="muted">У каждого марафона в папке можно указать свою страницу — она важнее этой.</small>
    </div>`;
  const sel = ov.body.querySelector('[data-k="url"]');
  const custom = ov.body.querySelector('[data-k="custom"]');
  sel.onchange = () => custom.classList.toggle('tf-hidden', sel.value !== '__custom__');
  ov.foot.innerHTML = `<button type="button" class="btn ghost" data-x="cancel">Отмена</button><button type="button" class="btn primary" data-x="ok">${isNew ? '📁 Создать папку' : '💾 Сохранить'}</button>`;
  ov.foot.querySelector('[data-x="cancel"]').onclick = () => ov.close();
  ov.foot.querySelector('[data-x="ok"]').onclick = async () => {
    const title = ov.body.querySelector('[data-k="title"]').value.trim();
    if (!title) { toast('Укажите название папки', 'warning'); return; }
    let url = sel.value === '__custom__' ? custom.value.trim() : sel.value;
    if (url && !/^https?:\/\//.test(url)) { toast('Ссылка должна начинаться с https://', 'warning'); return; }
    if (sel.value === '__custom__' && url) rememberCustomPage(url);
    f.title = title;
    f.description = ov.body.querySelector('[data-k="description"]').value.trim();
    f.source = { ...(f.source || {}), url: url || null };
    f.updatedAt = new Date().toISOString();
    if (isNew) state.marathons.push(f);
    await persist();
    ov.close();
    toast(isNew ? 'Папка создана' : 'Папка сохранена', 'success');
    openMarathon(f.id);
  };
}

/** Перенос марафона в папку / из папки. */
function moveToFolder(m, folderId) {
  const old = m.seriesId ? findM(m.seriesId) : null;
  if (old) old.childIds = old.childIds.filter(id => id !== m.id);
  if (folderId) {
    const f = findM(folderId);
    if (!f) return;
    m.seriesId = f.id;
    if (!f.childIds.includes(m.id)) f.childIds.push(m.id);
    f.updatedAt = new Date().toISOString();
  } else {
    delete m.seriesId;
    // своя ссылка у марафона не задана — сохраняем ссылку папки, чтобы сверка продолжала работать
    if (!m.source?.url && old?.source?.url) m.source = { ...(m.source || {}), url: old.source.url };
  }
  m.updatedAt = new Date().toISOString();
}

function openFolderPicker(m) {
  const folders = state.marathons.filter(x => x.kind === 'series');
  const ov = openOverlay({ title: `📁 Папка для «${m.title}»` });
  ov.body.innerHTML = `
    <div class="tf-list">
      <label class="tf-list-item"><input type="radio" name="fold" value="" ${!m.seriesId ? 'checked' : ''}/><div><strong>Без папки</strong></div></label>
      ${folders.map(f => `<label class="tf-list-item"><input type="radio" name="fold" value="${f.id}" ${m.seriesId === f.id ? 'checked' : ''}/>
        <div><strong>📁 ${escapeHtml(f.title)}</strong><br/><small class="muted">${f.childIds.length} марафонов${f.description ? ` · ${escapeHtml(f.description)}` : ''}</small></div></label>`).join('')}
    </div>
    ${folders.length ? '' : '<p class="muted">Папок пока нет — создайте её кнопкой «📁 Новая папка» в списке марафонов.</p>'}`;
  ov.foot.innerHTML = `<button type="button" class="btn ghost" data-x="cancel">Отмена</button><button type="button" class="btn primary" data-x="ok">Переместить</button>`;
  ov.foot.querySelector('[data-x="cancel"]').onclick = () => ov.close();
  ov.foot.querySelector('[data-x="ok"]').onclick = async () => {
    const v = ov.body.querySelector('input[name="fold"]:checked')?.value || '';
    moveToFolder(m, v || null);
    await persist(); ov.close(); renderMarathons();
    toast(v ? 'Марафон перемещён в папку' : 'Марафон убран из папки', 'success');
  };
}

function openAddExisting(folder) {
  const free = state.marathons.filter(x => x.kind !== 'series' && x.seriesId !== folder.id);
  const ov = openOverlay({ title: `📥 Добавить марафоны в «${folder.title}»` });
  ov.body.innerHTML = free.length ? `<div class="tf-list">${free.map(x => `
      <label class="tf-list-item"><input type="checkbox" value="${x.id}"/>
        <div><strong>${escapeHtml(x.title)}</strong><br/><small class="muted">${fmtDate(x.startDate)} — ${fmtDate(x.endDate)}${x.seriesId ? ` · сейчас в «${escapeHtml(findM(x.seriesId)?.title || '')}»` : ''}</small></div></label>`).join('')}</div>`
    : '<p class="muted">Нет марафонов для добавления.</p>';
  ov.foot.innerHTML = `<button type="button" class="btn ghost" data-x="cancel">Отмена</button><button type="button" class="btn primary" data-x="ok" ${free.length ? '' : 'disabled'}>Добавить</button>`;
  ov.foot.querySelector('[data-x="cancel"]').onclick = () => ov.close();
  ov.foot.querySelector('[data-x="ok"]').onclick = async () => {
    const ids = [...ov.body.querySelectorAll('input:checked')].map(i => i.value);
    ids.forEach(id => moveToFolder(findM(id), folder.id));
    await persist(); ov.close(); renderMarathons();
    if (ids.length) toast(`Добавлено: ${ids.length}`, 'success');
  };
}

function openDeleteFolder(folder) {
  const kids = seriesChildren(folder, state.marathons);
  const ov = openOverlay({ title: `🗑 Удалить папку «${folder.title}»` });
  ov.body.innerHTML = `<p>В папке марафонов: <strong>${kids.length}</strong>. Что сделать с ними?</p>`;
  ov.foot.innerHTML = `<button type="button" class="btn ghost" data-x="cancel">Отмена</button>
    <div class="row gap">
      <button type="button" class="btn" data-x="keep">Удалить только папку</button>
      ${kids.length ? '<button type="button" class="btn danger" data-x="all">Удалить вместе с марафонами</button>' : ''}
    </div>`;
  ov.foot.querySelector('[data-x="cancel"]').onclick = () => ov.close();
  ov.foot.querySelector('[data-x="keep"]').onclick = async () => {
    kids.forEach(k => moveToFolder(k, null));
    state.marathons = state.marathons.filter(m => m.id !== folder.id);
    await persist(); ov.close(); view.type = 'list'; renderMarathons(); toast('Папка удалена, марафоны сохранены', 'success');
  };
  ov.foot.querySelector('[data-x="all"]')?.addEventListener('click', async () => {
    state.marathons = state.marathons.filter(m => m.id !== folder.id && m.seriesId !== folder.id);
    await persist(); ov.close(); view.type = 'list'; renderMarathons(); toast('Папка и марафоны удалены', 'success');
  });
}

/* ================================================================== */
/*  Список                                                             */
/* ================================================================== */

function renderList(root) {
  const items = state.marathons.filter(m => m.kind === 'series' || !m.seriesId);
  if (!items.length) {
    root.innerHTML = `<div class="empty-state">Марафонов пока нет. Нажмите «+ Создать» — мастер сам найдёт марафоны на сайте, или «📁 Новая папка», чтобы собрать свои марафоны в группу.</div>`;
    return;
  }
  const phaseOf = (m) => m.kind === 'series' ? seriesPhase(m, state.marathons) : marathonPhase(m);
  const groups = [
    ['ended', '⌛ Ждут завершения'], ['active', '🏃 Идут'], ['upcoming', '⏳ Скоро'], ['completed', '🏁 Завершённые']
  ].map(([key, label]) => [label, items.filter(m => phaseOf(m) === key)
    .sort((a, b) => String(b.startDate || b.createdAt).localeCompare(String(a.startDate || a.createdAt)))]);

  root.innerHTML = groups.filter(([, list]) => list.length).map(([label, list]) => `
    <h3 class="mr-group-title">${label} <span class="muted">${list.length}</span></h3>
    <div class="mr-cards">${list.map(m => m.kind === 'series' ? seriesCard(m) : marathonCard(m)).join('')}</div>
  `).join('');

  root.querySelectorAll('[data-open]').forEach(el => el.onclick = () => openMarathon(el.dataset.open));
}

function progressBar(percent, cls = '') {
  return `<div class="mr-bar ${cls}"><span style="width:${percent}%"></span></div>`;
}

function marathonCard(m, { inFolder = false } = {}) {
  const t = marathonTotals(m);
  const phase = marathonPhase(m);
  return `
    <article class="mr-card" data-open="${m.id}">
      <header><strong>${escapeHtml(m.title)}</strong><span class="row gap-s"><span class="mr-chip mr-${phase}">${STATUS_LABELS[phase]}</span>${inFolder ? `<button type="button" class="icon-btn mr-unlink" data-unlink="${m.id}" title="Убрать из папки">↩</button>` : ''}</span></header>
      <div class="muted mr-card-meta">${fmtDate(m.startDate)} — ${fmtDate(m.endDate)} · 👥 ${m.participantIds.length} · 📋 ${m.tasks.length}</div>
      ${progressBar(t.percent)}
      <div class="mr-card-foot">
        <span>✅ ${t.done}/${t.cells}${t.failing ? ` · <span class="mr-red">⚠ ${t.failing}</span>` : ''}</span>
        <span class="mr-gold">${coin(t.coins)}${t.maxCoins ? ` <small class="muted">/ ${t.maxCoins}</small>` : ''}</span>
      </div>
      ${m.lastSync ? `<small class="muted">🔄 ${fmtDateTime(m.lastSync.at)}</small>` : ''}
    </article>`;
}

function seriesCard(s) {
  const kids = seriesChildren(s, state.marathons);
  const coins = kids.reduce((sum, k) => sum + marathonTotals(k).coins, 0);
  const phase = seriesPhase(s, state.marathons);
  return `
    <article class="mr-card mr-series" data-open="${s.id}">
      <header><strong>📁 ${escapeHtml(s.title)}</strong><span class="mr-chip mr-${phase}">${STATUS_LABELS[phase]}</span></header>
      <div class="mr-series-kids">${kids.map(k => {
        const t = marathonTotals(k);
        return `<div class="mr-kid"><span>${escapeHtml(k.source?.stageName || k.title)}</span>${progressBar(t.percent, 'mr-bar-sm')}<small>${t.percent}%</small></div>`;
      }).join('')}</div>
      ${kids.length ? '' : '<div class="muted mr-card-meta">Папка пуста</div>'}
      <div class="mr-card-foot"><span class="muted">${s.description ? escapeHtml(s.description) + ' · ' : ''}Марафонов: ${kids.length}</span><span class="mr-gold">${coin(coins)}</span></div>
    </article>`;
}

/* ================================================================== */
/*  Серия                                                              */
/* ================================================================== */

function renderSeries(root, s) {
  const kids = seriesChildren(s, state.marathons);
  const totals = kids.map(k => ({ k, t: marathonTotals(k) }));
  const coins = totals.reduce((sum, x) => sum + x.t.coins, 0);
  const maxCoins = totals.reduce((sum, x) => sum + x.t.maxCoins, 0);
  const charIds = [...new Set(kids.flatMap(k => k.participantIds))];
  const syncable = kids.filter(k => k.status !== 'completed' && marathonUrlOf(k));

  root.innerHTML = `
    <div class="mr-crumbs"><a data-nav="list">Марафоны</a> › <span>📁 ${escapeHtml(s.title)}</span></div>
    <div class="toolbar mr-head">
      <div><h2>📁 ${escapeHtml(s.title)}</h2><span class="muted">${s.description ? `${escapeHtml(s.description)} · ` : ''}марафонов: ${kids.length}${s.source?.url ? ` · 🌐 ${escapeHtml(s.source.url.replace('https://', ''))}` : ''}</span></div>
      <div class="row gap">
        <button class="btn primary" data-act="sync" ${syncable.length && !ui.syncProgress ? '' : 'disabled'}>${ui.syncProgress ? `⏳ ${ui.syncProgress}` : '🔄 Сверить все'}</button>
        <button class="btn" data-act="add">+ Марафон</button>
        <button class="btn" data-act="add-existing">📥 Добавить существующие</button>
        <button class="btn" data-act="settings">⚙️ Настройки</button>
        <button class="btn danger" data-act="delete" title="Удалить папку">🗑</button>
      </div>
    </div>
    ${ui.syncTask && ui.syncTaskFor === s.id ? taskCardHtml(ui.syncTask) : ''}
    <div class="kpi-grid mr-kpis">
      ${kpi('Марафонов', kids.length)}${kpi('Участников', charIds.length)}
      ${kpi('Выполнено заданий', `${totals.reduce((a, x) => a + x.t.done, 0)}/${totals.reduce((a, x) => a + x.t.cells, 0)}`)}
      ${kpi('💰 Заработано', `${coins.toLocaleString('ru-RU')}`, maxCoins ? `из ${maxCoins.toLocaleString('ru-RU')} возможных` : '')}
    </div>
    <div class="mr-cards">${kids.map(k => marathonCard(k, { inFolder: true })).join('') || '<div class="empty-state">Папка пуста. Нажмите «+ Марафон» или «📥 Добавить существующие».</div>'}</div>
    ${kids.length ? '' : '<!--'}<div class="panel mr-section">
      <h3>💰 Монеты по этапам</h3>
      <div class="tf-mx-wrap"><table class="mr-table">
        <thead><tr><th>Персонаж</th>${kids.map(k => `<th>${escapeHtml(k.source?.stageName || k.title)}</th>`).join('')}<th>Итого</th></tr></thead>
        <tbody>${charIds.map(cid => {
          const per = totals.map(x => x.t.perChar[cid]?.coins || 0);
          return `<tr><td>${escapeHtml(charById(cid)?.nick || '—')}</td>${per.map(v => `<td>${v ? coin(v) : '<span class="muted">—</span>'}</td>`).join('')}<td><strong class="mr-gold">${coin(per.reduce((a, b) => a + b, 0))}</strong></td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr><td><strong>Всего</strong></td>${totals.map(x => `<td><strong>${coin(x.t.coins)}</strong></td>`).join('')}<td><strong class="mr-gold">${coin(coins)}</strong></td></tr></tfoot>
      </table></div>
    </div>${kids.length ? '' : '-->'}`;

  bindCrumbs(root);
  root.querySelectorAll('[data-open]').forEach(el => el.onclick = () => openMarathon(el.dataset.open));
  root.querySelector('[data-act="sync"]').onclick = () => runSync(syncable, s.id);
  root.querySelector('[data-act="add"]').onclick = () => openMarathonWizard({ seriesId: s.id });
  root.querySelector('[data-act="add-existing"]').onclick = () => openAddExisting(s);
  root.querySelector('[data-act="settings"]').onclick = () => openFolderDialog(s);
  root.querySelector('[data-act="delete"]').onclick = () => openDeleteFolder(s);
  root.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const k = findM(b.dataset.unlink);
    if (!k) return;
    moveToFolder(k, null); await persist(); renderMarathons();
    toast(`«${k.title}» убран из папки`, 'success');
  });
}

function kpi(label, value, sub = '') {
  return `<div class="kpi-card"><span class="kpi-label">${label}</span><strong>${value}</strong>${sub ? `<small class="muted">${sub}</small>` : ''}</div>`;
}

function bindCrumbs(root) {
  root.querySelectorAll('[data-nav]').forEach(a => a.onclick = () => {
    if (a.dataset.nav === 'list') { view.type = 'list'; view.id = null; }
    else openMarathon(a.dataset.nav);
    renderMarathons();
  });
}

/* ================================================================== */
/*  Марафон                                                            */
/* ================================================================== */

function renderDetail(root, m) {
  const t = marathonTotals(m);
  const phase = marathonPhase(m);
  const series = m.seriesId ? findM(m.seriesId) : null;
  const url = marathonUrlOf(m);
  const completed = m.status === 'completed';

  root.innerHTML = `
    <div class="mr-crumbs"><a data-nav="list">Марафоны</a> ›
      ${series ? `<a data-nav="${series.id}">📁 ${escapeHtml(series.title)}</a> › ` : ''}<span>${escapeHtml(m.title)}</span></div>
    <div class="toolbar mr-head">
      <div>
        <h2>${escapeHtml(m.title)} <span class="mr-chip mr-${phase}">${STATUS_LABELS[phase]}</span></h2>
        <span class="muted">${fmtDate(m.startDate)} — ${fmtDate(m.endDate)}
          ${url ? ` · 🌐 ${escapeHtml(url.replace('https://', ''))}` : ' · сверка с сайтом не настроена'}${m.source?.newsUrl ? ` · 📰 ${escapeHtml(m.source.newsUrl.replace('https://', ''))}` : ''}</span>
      </div>
      <div class="row gap">
        ${!completed ? `<button class="btn primary" data-act="sync" ${url && !ui.syncProgress && m.participantIds.length ? '' : 'disabled'}>${ui.syncProgress ? `⏳ ${ui.syncProgress}` : '🔄 Сверить с сайтом'}</button>` : ''}
        <button class="btn" data-act="edit">✏️ Редактировать</button>
        ${completed ? '<button class="btn" data-act="reopen">🔓 Вернуть в работу</button>' : '<button class="btn" data-act="complete">🏁 Завершить</button>'}
        <button class="btn" data-act="move" title="Переместить в папку">📁</button>
        <button class="btn" data-act="chart" title="Инфографика">📊</button>
        <button class="btn danger" data-act="delete" title="Удалить">🗑</button>
      </div>
    </div>

    <div class="kpi-grid mr-kpis">
      ${kpi('Прогресс', `${t.percent}%`, progressBar(t.percent))}
      ${kpi('Выполнено заданий', `${t.done}/${t.cells}`)}
      ${kpi('Не успевают', t.failing ? `<span class="mr-red">${t.failing}</span>` : '0', t.failing ? 'запас дней исчерпан' : 'все в графике')}
      ${kpi(completed ? '💰 Заработано (итог)' : '💰 Заработано', t.coins.toLocaleString('ru-RU'), t.maxCoins ? `из ${t.maxCoins.toLocaleString('ru-RU')} возможных` : 'награды не заданы')}
      ${kpi('Последняя сверка', m.lastSync ? fmtDateTime(m.lastSync.at) : '—', m.lastSync ? `изменений: ${m.lastSync.changes.length}` : '')}
    </div>

    ${ui.syncTask && ui.syncTaskFor === m.id ? taskCardHtml(ui.syncTask) : ''}
    ${syncPanel(m)}

    <div class="toolbar mr-filters">
      <div class="row gap">
        <select class="select" data-f="party">
          <option value="all">Все пати</option>
          ${[...new Set(m.participantIds.map(id => charById(id)?.party || 'Без пати'))].map(p => `<option ${ui.party === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        </select>
        <label class="tf-radio"><input type="checkbox" data-f="problems" ${ui.onlyProblems ? 'checked' : ''}/> Только проблемные</label>
      </div>
      <div class="mr-legend">
        <span class="mr-dot mr-s-ok"></span>в графике <span class="mr-dot mr-s-warn"></span>запас 0–1 дн.
        <span class="mr-dot mr-s-fail"></span>не успевает <span class="mr-dot mr-s-done"></span>выполнено ✎ поправка
      </div>
    </div>

    <div class="tf-mx-wrap">${matrix(m)}</div>
    ${coinsSection(m, t)}`;

  bindCrumbs(root);
  bindDetail(root, m);
}

function syncPanel(m) {
  const ls = m.lastSync;
  if (!ls || (!ls.changes.length && !ls.errors.length)) return '';
  const taskTitle = (id) => m.tasks.find(t => t.id === id)?.title || '—';
  return `
    <details class="panel mr-sync" ${ui.showSync ? 'open' : ''}>
      <summary>🔄 Результат сверки ${fmtDateTime(ls.at)} — изменений: <strong>${ls.changes.length}</strong>${ls.errors.length ? `, ошибок: <strong class="mr-red">${ls.errors.length}</strong>` : ''}</summary>
      <div class="mr-sync-grid">
        ${ls.changes.map(c => `<div class="mr-sync-row"><strong>${escapeHtml(charById(c.charId)?.nick || '—')}</strong><span>${escapeHtml(taskTitle(c.taskId))}</span>
          <span>${c.from ?? '—'} → <b>${c.to}</b> ${c.from != null ? `<span class="mr-green">(+${c.to - c.from})</span>` : '<span class="muted">(первые данные)</span>'}</span></div>`).join('')}
        ${ls.errors.map(e => `<div class="mr-sync-row mr-sync-err"><strong>${escapeHtml(charById(e.charId)?.nick || '—')}</strong><span>❌ ${escapeHtml(ERROR_TEXT[e.error] || e.error)}</span>
          ${e.error === 'not_logged_in' ? `<button class="btn small" data-login="${e.charId}">Войти</button>` : '<span></span>'}</div>`).join('')}
      </div>
    </details>`;
}

function matrix(m) {
  if (!m.participantIds.length) return '<div class="empty-state">Нет участников. Откройте «✏️ Редактировать» → «Участники».</div>';
  const chars = m.participantIds.map(charById).filter(Boolean)
    .filter(c => ui.party === 'all' || (c.party || 'Без пати') === ui.party);
  const groups = new Map();
  chars.forEach(c => { const k = c.party || 'Без пати'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); });
  const cols = m.tasks.length + 2;

  const rows = [...groups.entries()].map(([party, members]) => {
    const body = members.map(c => {
      const cells = m.tasks.map(t => computeCell(m, c.id, t.id));
      if (ui.onlyProblems && !cells.some(x => x.state === 'fail' || x.state === 'warn')) return '';
      const done = cells.filter(x => x.state === 'done').length;
      const assigned = cells.filter(x => x.assigned).length;
      const coins = cells.reduce((a, x) => a + x.coins, 0);
      const syncing = ui.syncing.has(c.id), queued = ui.syncQueue.has(c.id);
      return `
        <tr class="${syncing ? 'is-syncing' : ''}">
          <td class="mr-name">${getAuthView(c).icon} <strong>${escapeHtml(c.nick)}</strong><br/><small class="muted">${escapeHtml(c.class || '')}${syncing ? ' · ⏳ сверка…' : queued ? ' · в очереди' : ''}</small></td>
          ${cells.map((x, i) => cellHtml(m, c.id, m.tasks[i].id, x)).join('')}
          <td class="mr-total"><strong>${done}/${assigned}</strong><br/><small class="mr-gold">${coin(coins)}</small></td>
        </tr>`;
    }).join('');
    return body ? `<tr class="mr-group"><td colspan="${cols}">${escapeHtml(party)}</td></tr>${body}` : '';
  }).join('');

  const foot = m.tasks.map(t => {
    const cells = m.participantIds.map(cid => computeCell(m, cid, t.id)).filter(x => x.assigned);
    return `<td><strong>${cells.filter(x => x.state === 'done').length}/${cells.length}</strong></td>`;
  }).join('');

  return `
    <table class="mr-matrix">
      <thead><tr><th class="mr-name">Персонаж</th>${m.tasks.map(t => `
        <th title="${escapeHtml(t.siteTitle || t.title)}"><div class="mr-th">${escapeHtml(t.title)}</div>
        <small class="muted">цель ${t.targetChecks}${maxRewardCoins(t) ? ` · до 🪙${maxRewardCoins(t)}` : ''}</small></th>`).join('')}
        <th>Итого</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${cols}" class="muted" style="text-align:center;padding:20px">Нет персонажей по фильтру</td></tr>`}</tbody>
      <tfoot><tr><td class="mr-name muted">Выполнили</td>${foot}<td></td></tr></tfoot>
    </table>`;
}

function cellHtml(m, charId, taskId, x) {
  if (!x.assigned) return '<td class="mr-cell mr-s-off"><span class="muted">—</span></td>';
  let sub;
  if (x.state === 'done') sub = x.coins ? `✅ ${coin(x.coins)}` : '✅ выполнено';
  else if (x.state === 'fail') sub = m.status === 'completed' ? '❌ не выполнено' : `⚠ не успевает (${x.reserve})`;
  else if (x.state === 'idle') sub = 'ещё не начался';
  else sub = `запас: ${x.reserve} дн.`;
  return `
    <td class="mr-cell mr-s-${x.state}" data-cell="${charId}|${taskId}" title="Нажмите для подробностей">
      <div class="mr-cell-top"><b>${x.count}</b>/${x.target}${x.adjust ? ' <span class="mr-adj" title="Есть ручная поправка">✎</span>' : ''}${x.hasSite ? '' : ' <span class="muted" title="Нет данных с сайта — считаются ручные отметки">✋</span>'}</div>
      ${progressBar(x.percent, 'mr-bar-sm')}
      <small>${sub}</small>
    </td>`;
}

function coinsSection(m, t) {
  const balanceDelta = (cid) => {
    const s = m.balance?.start?.[cid], e = m.balance?.end?.[cid];
    const now = charById(cid);
    const endCoins = e ? e.coins : (now?.lastCoinUpdate ? Number(now.ancientCoins) || 0 : null);
    if (!s || endCoins === null) return '<span class="muted">—</span>';
    const d = endCoins - s.coins;
    return `<span class="${d >= 0 ? 'mr-green' : 'mr-red'}">${d >= 0 ? '+' : ''}${d.toLocaleString('ru-RU')}</span>`;
  };
  const charRows = m.participantIds.map(cid => ({ cid, ...t.perChar[cid] })).sort((a, b) => b.coins - a.coins);
  const hasBonus = (m.bonuses || []).length > 0;
  const bonusCell = (cid) => bonusStatus(m, cid).map(b => b.reached
    ? `<span class="mr-green" title="${escapeHtml(b.bonus.text)}">✅ ${escapeHtml(b.bonus.text || 'бонус')}</span>`
    : `<span class="muted" title="${escapeHtml(b.bonus.text)}">${b.done}/${b.need}</span>`).join('<br/>');
  const taskRows = m.tasks.map(task => ({ task, ...t.perTask[task.id] }));
  return `
    <div class="mr-two">
      <div class="panel mr-section">
        <h3>💰 По персонажам</h3>
        <table class="mr-table"><thead><tr><th>Персонаж</th><th>Выполнено</th><th>Награды</th>${hasBonus ? '<th>🎁 Бонус</th>' : ''}<th title="Изменение баланса ДМ с сайта с первой сверки (для сравнения)">Δ баланса ДМ</th></tr></thead>
        <tbody>${charRows.map(r => `<tr><td>${escapeHtml(charById(r.cid)?.nick || '—')}</td><td>${r.done}/${r.assigned}</td><td class="mr-gold">${coin(r.coins)}</td>${hasBonus ? `<td>${bonusCell(r.cid)}</td>` : ''}<td>${balanceDelta(r.cid)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td><strong>Всего</strong></td><td>${t.done}/${t.cells}</td><td class="mr-gold"><strong>${coin(t.coins)}</strong></td>${hasBonus ? `<td><strong>${m.participantIds.filter(cid => bonusStatus(m, cid).some(b => b.reached)).length}</strong> получат</td>` : ''}<td></td></tr></tfoot></table>
        ${hasBonus ? `<p class="muted tf-small">🎁 ${m.bonuses.map(b => `${escapeHtml(b.text || 'Бонус')} — за ${b.needTasks} выполн. заданий`).join('; ')}</p>` : ''}
      </div>
      <div class="panel mr-section">
        <h3>📋 По заданиям</h3>
        <table class="mr-table"><thead><tr><th>Задание</th><th>Выполнили</th><th>Награды</th></tr></thead>
        <tbody>${taskRows.map(r => `<tr><td>${escapeHtml(r.task.title)}</td><td>${r.done}/${r.assigned}</td><td class="mr-gold">${coin(r.coins)}</td></tr>`).join('')}</tbody></table>
        ${m.status === 'completed' ? '<p class="muted tf-small">Итог зафиксирован при завершении. Баланс ДМ персонажей не изменяется — он берётся с сайта.</p>' : ''}
      </div>
    </div>`;
}

function bindDetail(root, m) {
  const act = (name, fn) => root.querySelector(`[data-act="${name}"]`)?.addEventListener('click', fn);
  act('sync', () => runSync([m], m.id));
  act('edit', () => openMarathonWizard({ marathon: m }));
  act('move', () => openFolderPicker(m));
  act('chart', async () => (await import('./charts.js')).showMarathonInfographic(m.id));
  act('complete', async () => {
    if (!confirmDialog(`Завершить «${m.title}»? Награды будут зафиксированы.`)) return;
    m.awards = freezeAwards(m, state.characters);
    m.participantIds.forEach(cid => {
      const c = charById(cid);
      if (c?.lastCoinUpdate) m.balance.end[cid] = { coins: Number(c.ancientCoins) || 0, at: new Date().toISOString() };
    });
    m.status = 'completed'; m.completedAt = m.updatedAt = new Date().toISOString();
    await persist(); renderMarathons();
    toast(`Марафон завершён. Заработано: ${marathonTotals(m).coins} ДМ`, 'success');
  });
  act('reopen', async () => {
    m.status = 'active'; m.awards = []; m.completedAt = null; m.balance.end = {};
    m.updatedAt = new Date().toISOString();
    await persist(); renderMarathons();
  });
  act('delete', async () => {
    if (!confirmDialog(`Удалить марафон «${m.title}»?`)) return;
    state.marathons = state.marathons.filter(x => x.id !== m.id);
    const series = m.seriesId ? findM(m.seriesId) : null;
    if (series) series.childIds = series.childIds.filter(id => id !== m.id);
    await persist();
    if (series) openMarathon(series.id); else { view.type = 'list'; renderMarathons(); }
    toast('Марафон удалён', 'success');
  });

  root.querySelector('[data-f="party"]').onchange = (e) => { ui.party = e.target.value; renderMarathons(); };
  root.querySelector('[data-f="problems"]').onchange = (e) => { ui.onlyProblems = e.target.checked; renderMarathons(); };
  root.querySelector('.mr-sync')?.addEventListener('toggle', (e) => { ui.showSync = e.target.open; });
  root.querySelectorAll('[data-login]').forEach(b => b.onclick = async () => {
    const { openSyncHelper } = await import('../sync/syncManager.js');
    openSyncHelper(b.dataset.login);
  });
  root.querySelectorAll('[data-cell]').forEach(td => td.onclick = () => {
    const [cid, tid] = td.dataset.cell.split('|');
    openCellCard(m, cid, tid);
  });
}

/* ================================================================== */
/*  Сверка с сайтом                                                    */
/* ================================================================== */

async function runSync(marathons, ownerId = null) {
  const list = marathons.filter(m => m.status !== 'completed' && m.participantIds.length);
  if (!list.length) return;
  const noUrl = list.filter(m => !marathonUrlOf(m));
  if (noUrl.length === list.length) { toast('Не указана страница марафона на сайте (✏️ Редактировать → Этапы и задания).', 'warning'); return; }

  ui.syncQueue = new Set(list.flatMap(m => m.participantIds));
  ui.syncProgress = `0/${ui.syncQueue.size}`;
  ui.showSync = true;
  renderMarathons();

  const { report } = await syncMarathons(list, {
    onTask: (t) => { ui.syncTask = t; ui.syncTaskFor = ownerId; },
    onStart: (cid) => { ui.syncQueue.delete(cid); ui.syncing.add(cid); renderMarathons(); },
    onDone: (cid) => { ui.syncing.delete(cid); renderMarathons(); },
    onProgress: (done, total) => { ui.syncProgress = `${Math.round(done / total * 100)}% · ${done}/${total}`; }
  });

  ui.syncing.clear(); ui.syncQueue.clear(); ui.syncProgress = null;
  renderMarathons();
  const changes = Object.values(report).reduce((a, r) => a + r.changes.length, 0);
  const errors = Object.values(report).reduce((a, r) => a + r.errors.length, 0);
  toast(`Сверка завершена: изменений ${changes}${errors ? `, ошибок ${errors}` : ''}`, errors ? 'warning' : 'success');
  try { const { renderCharacters } = await import('../characters/list.js'); renderCharacters(); } catch (_) {}
}

/* ================================================================== */
/*  Карточка ячейки: данные сайта, поправка, календарь                  */
/* ================================================================== */

function openCellCard(m, charId, taskId) {
  const char = charById(charId);
  const task = m.tasks.find(t => t.id === taskId);
  if (!char || !task) return;
  const ov = openOverlay({ title: `${char.nick} · ${task.title}`, onClose: () => renderMarathons() });

  const draw = () => {
    const x = computeCell(m, charId, taskId);
    const cell = ensureCell(m.progress, charId, taskId);
    const all = getAllDatesInRange(m.startDate, m.endDate);
    const today = new Date().toLocaleDateString('sv');
    const firstDow = (new Date(all[0] + 'T00:00:00').getDay() + 6) % 7; // Пн = 0
    const sortedRewards = [...task.rewards].sort((a, b) => a.threshold - b.threshold);
    const editable = m.status !== 'completed';

    ov.body.innerHTML = `
      <div class="mr-card-summary mr-s-${x.state}">
        <div><span class="muted">Итого</span><strong>${x.count} / ${x.target}</strong></div>
        <div><span class="muted">С сайта</span><strong>${x.hasSite ? cell.site : '—'}</strong><small class="muted">${cell.syncedAt ? fmtDateTime(cell.syncedAt) : 'нет данных'}</small></div>
        <div><span class="muted">Осталось дней</span><strong>${x.left}</strong><small class="muted">запас ${x.reserve}</small></div>
        <div><span class="muted">Награда</span><strong class="mr-gold">${coin(x.coins)}</strong><small class="muted">${x.next ? `след.: ${x.next.threshold} → 🪙${x.next.rewardCoins}` : ''}</small></div>
      </div>

      <div class="mr-adjust">
        <span>Ручная поправка</span>
        <button class="btn small" data-adj="-1" ${editable ? '' : 'disabled'}>−</button>
        <strong>${cell.adjust > 0 ? '+' : ''}${cell.adjust}</strong>
        <button class="btn small" data-adj="1" ${editable ? '' : 'disabled'}>+</button>
        ${cell.adjust ? `<button class="btn small ghost" data-adj="0" ${editable ? '' : 'disabled'}>Сбросить</button>` : ''}
        <small class="muted">${x.hasSite ? 'Добавляется к данным сайта.' : 'Данных сайта нет: считаются отмеченные дни + поправка.'}</small>
      </div>

      ${sortedRewards.length ? `<div class="mr-rewards">${sortedRewards.map(r => `
        <span class="mr-reward ${x.count >= r.threshold ? 'is-reached' : ''}">${x.count >= r.threshold ? '✓' : '○'} ${r.threshold}: ${escapeHtml(r.rewardText || 'награда')} · 🪙${r.rewardCoins}</span>`).join('')}</div>` : ''}

      <h4 class="mr-cal-title">Календарь ${x.hasSite ? '<small class="muted">(синие — прирост по сверкам; отметки дней в итог не идут, пока есть данные сайта)</small>' : '<small class="muted">(нажмите на день, чтобы отметить выполнение)</small>'}</h4>
      <div class="mr-cal">
        ${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<div class="mr-cal-dow">${d}</div>`).join('')}
        ${'<div></div>'.repeat(firstDow)}
        ${all.map(d => {
          const active = isTaskActiveOnDate(task, d, all);
          const marked = cell.marks.includes(d);
          const delta = cell.history[d];
          return `<button type="button" class="mr-cal-day ${active ? '' : 'is-inactive'} ${marked ? 'is-marked' : ''} ${d === today ? 'is-today' : ''} ${d > today ? 'is-future' : ''}"
            data-day="${d}" ${active && editable ? '' : 'disabled'}>
            <span>${Number(d.slice(8))}</span>${delta ? `<small class="mr-cal-delta">+${delta}</small>` : ''}${marked ? '<small>✓</small>' : ''}</button>`;
        }).join('')}
      </div>`;

    ov.body.querySelectorAll('[data-adj]').forEach(b => b.onclick = async () => {
      const v = Number(b.dataset.adj);
      cell.adjust = v === 0 ? 0 : cell.adjust + v;
      m.updatedAt = new Date().toISOString();
      await persist(); draw();
    });
    ov.body.querySelectorAll('[data-day]').forEach(b => b.onclick = async () => {
      const d = b.dataset.day;
      cell.marks = cell.marks.includes(d) ? cell.marks.filter(x => x !== d) : [...cell.marks, d];
      m.updatedAt = new Date().toISOString();
      await persist(); draw();
    });
  };
  draw();
}

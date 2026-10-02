// js/modules/marathons/wizard.js
// Мастер создания / редактирования марафона: Источник → Этапы и задания → Участники → Награды.
// Несколько выбранных этапов сайта создают СЕРИЮ (папку) с отдельным марафоном на каждый этап.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { toast } from '../../core/ui.js';
import { openOverlay } from './overlay.js';
import { createMarathon, createSeries, createTask, totalActiveDays, matchQuest, normTitle, setTaskDescription, editTaskDescription } from './model.js';
import { mergeSiteAndNews } from './mergeSources.js';
import { scanTitles, parseMarathonPage, pickScannerCharacter, SITE_PAGES, customPages, rememberCustomPage, loadNewsPage, isNewsUrl, searchNewsList } from './siteSync.js';
import { filterNews, NEWS_LIST_PAGES } from './newsList.js';
import { baseTitle } from './model.js';
import { taskCardHtml, errorText } from '../../core/taskLog.js';
import { getAuthView } from '../sync/authStatus.js';
import { mainPartyName, NO_PARTY_LABEL } from '../parties/membership.js';

const STEPS = ['Источник', 'Этапы и задания', 'Участники', 'Награды'];
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => crypto.randomUUID();
const stripParen = (s) => normTitle(String(s || '').replace(/\([^)]*\)/g, ''));

let onSavedCallback = null;
export function setWizardSavedHandler(fn) { onSavedCallback = fn; }

/**
 * @param {object} opts
 *   marathon  — существующий марафон для редактирования
 *   source    — 'site' | 'template' | 'manual' (предвыбор источника)
 *   autoScan  — сразу запустить поиск на сайте
 *   seriesId  — создать марафон(ы) внутри существующей папки
 */
export function openMarathonWizard(opts = {}) {
  const isEdit = !!opts.marathon;
  const W = {
    mode: isEdit ? 'edit' : 'create',
    step: isEdit ? 1 : 0,
    source: isEdit ? opts.marathon.source?.type : (opts.source === 'news' ? 'site' : (opts.source || null)),   // «из новости» теперь часть блока «С сайта»
    site: { scanning: false, scanned: false, progress: '', titles: [], errors: [], selectedUrl: null, loading: false, raw: null, error: null, split: 'stages', stageKeys: [], compare: [], customUrl: '', scanTask: null, parseTask: null },
    seriesId: opts.seriesId || null,
    news: { url: '', loading: false, task: null, error: null, verify: true, search: { loading: false, items: null, all: false, task: null, error: null } },
    parsed: { news: null, site: null },   // сырые результаты разбора; в W.site.raw лежит их объединение
    rwNews: { open: false, url: '', loading: false, task: null },
    templateId: null,
    seriesTitle: '',
    drafts: isEdit ? [clone(opts.marathon)] : [],
    active: 0,
    saveTemplate: false,
    templateName: ''
  };

  const folder = W.seriesId ? state.marathons.find(m => m.id === W.seriesId) : null;
  const ov = openOverlay({ title: isEdit ? `Редактирование: ${opts.marathon.title}` : (folder ? `Новый марафон в папке «${folder.title}»` : 'Новый марафон'), wide: true });

  /* ---------------- общий рендер ---------------- */
  function render() {
    const steps = isEdit ? STEPS.slice(1) : STEPS;
    const cur = isEdit ? W.step - 1 : W.step;
    ov.sub.innerHTML = `<div class="tf-stepper">${steps.map((s, i) => `
      <div class="tf-step ${i === cur ? 'is-current' : ''} ${i < cur ? 'is-done' : ''}" data-step="${isEdit ? i + 1 : i}">
        <span class="tf-step-num">${i < cur ? '✓' : i + 1}</span>${s}
      </div>`).join('<span class="tf-step-line"></span>')}</div>`;
    ov.sub.querySelectorAll('.tf-step.is-done').forEach(el => {
      el.onclick = () => { W.step = Number(el.dataset.step); render(); };
    });

    [renderSource, renderTasksStep, renderParticipants, renderRewards][W.step]();
    renderFooter();
  }

  function renderFooter() {
    const first = isEdit ? 1 : 0;
    const last = W.step === 3;
    ov.foot.innerHTML = `
      ${W.step > first ? '<button type="button" class="btn ghost" data-act="back">← Назад</button>' : '<span></span>'}
      <div class="row gap">
        ${isEdit && !last ? '<button type="button" class="btn" data-act="save">💾 Сохранить</button>' : ''}
        ${last
          ? `<button type="button" class="btn primary" data-act="save">${isEdit ? '💾 Сохранить' : (W.drafts.length > 1 ? (folder ? `✅ Создать в папке (${W.drafts.length})` : `✅ Создать серию (${W.drafts.length})`) : '✅ Создать марафон')}</button>`
          : `<button type="button" class="btn primary" data-act="next" ${canNext() ? '' : 'disabled'}>Далее →</button>`}
      </div>`;
    ov.foot.querySelector('[data-act="back"]')?.addEventListener('click', () => { W.step--; render(); });
    ov.foot.querySelector('[data-act="next"]')?.addEventListener('click', () => {
      const err = validateStep(W.step);
      if (err) { toast(err, 'warning'); return; }
      if (W.step === 0) buildDrafts();
      W.step++; render();
    });
    ov.foot.querySelectorAll('[data-act="save"]').forEach(b => b.addEventListener('click', save));
  }

  function canNext() {
    if (W.step === 0) {
      if (W.source === 'manual') return true;
      if (W.source === 'template') return !!W.templateId;
      if (W.source === 'site') return !!W.site.raw;
      return false;
    }
    return true;
  }

  /* ================= ШАГ 0: ИСТОЧНИК ================= */
  function renderSource() {
    const scanner = pickScannerCharacter();
    const templates = state.marathonTemplates || [];
    const card = (key, icon, title, text) => `
      <button type="button" class="tf-source ${W.source === key ? 'is-selected' : ''}" data-src="${key}">
        <span class="tf-source-icon">${icon}</span><strong>${title}</strong><small class="muted">${text}</small>
      </button>`;

    let panel = '';
    if (W.source === 'site') {
      const s = W.site, n = W.news, P = W.parsed, raw = s.raw;
      const hasNews = !!P.news, hasSite = !!P.site;
      panel = `
        <div class="tf-panel">
          <div class="tf-src-block ${hasNews ? 'is-loaded' : ''}">
            <h4>📰 Новость <small class="muted">— рекомендуется: в ней задания, цели, награды, бонусы и полные описания</small></h4>
            <div class="row gap">
              <input class="input tf-grow" data-news-url placeholder="https://pwonline.ru/news.php?article=…" value="${escapeHtml(n.url)}"/>
              <button type="button" class="btn primary" data-act="parse-news" ${n.loading || n.search.loading ? 'disabled' : ''}>${n.loading ? '⏳ Разбираю…' : hasNews ? '📰 Разобрать заново' : '📰 Разобрать новость'}</button>
              <button type="button" class="btn" data-act="find-news" title="Просмотреть первые ${NEWS_LIST_PAGES} страницы архива событий pwonline.ru" ${n.loading || n.search.loading ? 'disabled' : ''}>${n.search.loading ? '⏳ Ищу…' : '🔎 Найти новость'}</button>
            </div>
            ${newsSearchHtml(n.search)}
            <label class="tf-radio tf-small"><input type="checkbox" data-news-verify ${n.verify ? 'checked' : ''}/> После новости сверить со страницей отметок (нужен персонаж со входом)</label>
            ${n.task ? taskCardHtml(n.task) : ''}
            ${n.error ? `<p class="tf-warn">Не удалось разобрать новость: ${escapeHtml(n.error)}</p>` : ''}
          </div>

          <div class="tf-src-block ${hasSite ? 'is-loaded' : ''}">
            <h4>🌐 Страница отметок <small class="muted">— supermarathon.php / supermarathon2.php: названия заданий как на сайте, проверка новости</small></h4>
            ${scanner
              ? `<p class="muted">Поиск через профиль <strong>${escapeHtml(scanner.nick)}</strong> ${getAuthView(scanner).icon}</p>`
              : `<p class="tf-warn">⚠️ Нет авторизованных персонажей. Сайт не покажет марафон без входа — сначала войдите хотя бы одним персонажем.</p>`}
            <div class="row gap">
              <button type="button" class="btn ${s.scanned ? '' : 'primary'}" data-act="scan" ${s.scanning ? 'disabled' : ''}>${s.scanning ? '⏳ Поиск…' : s.scanned ? '🔄 Искать снова' : '🔍 Найти марафоны на сайте'}</button>
              ${P.news?.sourceUrl && !hasSite ? `<button type="button" class="btn" data-act="verify-site" ${s.loading ? 'disabled' : ''}>✅ Сверить со страницей из новости</button>` : ''}
            </div>
            ${s.scanTask ? taskCardHtml(s.scanTask) : ''}
            ${s.titles.length ? `
              <div class="tf-list">${s.titles.map(t => `
                <label class="tf-list-item">
                  <input type="radio" name="site-title" value="${escapeHtml(t.url)}" ${s.selectedUrl === t.url ? 'checked' : ''}/>
                  <div><strong>${escapeHtml(t.name)}</strong><br/><small class="muted">${escapeHtml(t.url.replace('https://', ''))}</small></div>
                </label>`).join('')}
              </div>
              <button type="button" class="btn" data-act="parse" ${s.selectedUrl && !s.loading ? '' : 'disabled'}>${s.loading ? '⏳ Загружаю задания…' : '📥 Загрузить задания'}</button>` : ''}
            <div class="tf-custom-url">
              <label class="muted">Или своя ссылка на страницу марафона (ссылка на новость тоже подойдёт):</label>
              <div class="row gap">
                <input class="input tf-grow" data-custom-url placeholder="https://pwonline.ru/…" value="${escapeHtml(s.customUrl)}"/>
                <button type="button" class="btn" data-act="parse-custom" ${s.loading ? 'disabled' : ''}>📥 Загрузить</button>
              </div>
              ${customPages().length ? `<small class="muted">Свои страницы (ищутся автоматически): ${customPages().map(u => escapeHtml(u.replace('https://', ''))).join(', ')}</small>` : ''}
            </div>
            ${s.parseTask ? taskCardHtml(s.parseTask) : ''}
            ${!s.scanning && s.errors.length && !s.titles.length ? `<p class="tf-warn">Марафоны не найдены (${escapeHtml(s.errors.join(', '))}).</p>` : ''}
            ${s.error ? `<p class="tf-warn">Ошибка разбора страницы: ${escapeHtml(s.error)}</p>` : ''}
          </div>

          ${raw ? sourceSummaryHtml(raw) : '<p class="muted tf-small">Загрузите новость или страницу отметок — можно оба источника: данные объединятся.</p>'}
        </div>`;
    } else if (W.source === 'template') {
      panel = `<div class="tf-panel">${templates.length
        ? `<div class="tf-list">${templates.map(t => `
            <label class="tf-list-item">
              <input type="radio" name="tpl" value="${t.id}" ${W.templateId === t.id ? 'checked' : ''}/>
              <div><strong>${escapeHtml(t.name)}</strong><br/><small class="muted">Заданий: ${t.tasks.length} · ${new Date(t.createdAt).toLocaleDateString()}</small></div>
              <button type="button" class="icon-btn danger" data-del-tpl="${t.id}" title="Удалить шаблон">🗑</button>
            </label>`).join('')}</div>`
        : '<p class="muted">Шаблонов пока нет. Их можно сохранить на последнем шаге мастера.</p>'}</div>`;
    } else if (W.source === 'manual') {
      panel = '<div class="tf-panel"><p class="muted">Пустой марафон: задания, даты и награды вы заполните сами.</p></div>';
    }

    ov.body.innerHTML = `
      <div class="tf-sources">
        ${card('site', '🌐', 'С сайта', 'Новость и/или страница отметок на pwonline.ru: этапы, задания, награды')}
        ${card('template', '📁', 'Из шаблона', 'Повторить сохранённую структуру и награды')}
        ${card('manual', '✏️', 'Вручную', 'Начать с пустого марафона')}
      </div>${panel}`;

    ov.body.querySelectorAll('.tf-source').forEach(b => b.onclick = () => {
      W.source = b.dataset.src; render();
    });
    ov.body.querySelector('[data-act="scan"]')?.addEventListener('click', doScan);
    ov.body.querySelector('[data-act="parse"]')?.addEventListener('click', () => doParse());
    ov.body.querySelector('[data-custom-url]')?.addEventListener('input', e => { W.site.customUrl = e.target.value.trim(); });
    ov.body.querySelector('[data-news-url]')?.addEventListener('input', e => { W.news.url = e.target.value.trim(); });
    ov.body.querySelector('[data-news-url]')?.addEventListener('keydown', e => { if (e.key === 'Enter') doParseNews(); });
    ov.body.querySelector('[data-act="parse-news"]')?.addEventListener('click', () => doParseNews());
    ov.body.querySelector('[data-act="find-news"]')?.addEventListener('click', () => doFindNews());
    ov.body.querySelector('[data-news-all]')?.addEventListener('change', e => { W.news.search.all = e.target.checked; render(); });
    ov.body.querySelectorAll('[data-pick-news]').forEach(b => b.addEventListener('click', () => {
      W.news.url = b.dataset.pickNews; doParseNews();
    }));
    ov.body.querySelector('[data-news-verify]')?.addEventListener('change', e => { W.news.verify = e.target.checked; });
    ov.body.querySelector('[data-act="verify-site"]')?.addEventListener('click', () => doParse(W.parsed.news.sourceUrl));
    ov.body.querySelector('[data-act="parse-custom"]')?.addEventListener('click', () => {
      const u = W.site.customUrl;
      if (!/^https?:\/\//.test(u)) { toast('Вставьте полную ссылку, начиная с https://', 'warning'); return; }
      if (isNewsUrl(u)) { W.news.url = u; doParseNews(); return; }   // это новость, а не страница отметок
      W.site.selectedUrl = u; doParse(u);
    });
    ov.body.querySelectorAll('input[name="site-title"]').forEach(r => r.onchange = () => { W.site.selectedUrl = r.value; render(); });
    ov.body.querySelectorAll('input[name="tpl"]').forEach(r => r.onchange = () => { W.templateId = r.value; renderFooter(); });
    ov.body.querySelectorAll('[data-del-tpl]').forEach(b => b.onclick = async (e) => {
      e.preventDefault();
      state.marathonTemplates = (state.marathonTemplates || []).filter(t => t.id !== b.dataset.delTpl);
      if (W.templateId === b.dataset.delTpl) W.templateId = null;
      await persist(); render();
    });
  }

  async function doScan() {
    const s = W.site;
    Object.assign(s, { scanning: true, titles: [], errors: [], error: null, selectedUrl: null, progress: '', parseTask: null });
    const pending = scanTitles(null, { onTask: (t) => { s.scanTask = t; } });
    render();
    try {
      const res = await pending;
      s.titles = res.titles; s.errors = res.errors;
      if (s.titles.length === 1) s.selectedUrl = s.titles[0].url;
    } catch (e) {
      s.errors = [String(e)];
    }
    s.scanning = false; s.scanned = true; s.progress = '';
    render();
    if (s.titles.length === 1) doParse();
  }

  async function doParse(url = W.site.selectedUrl) {
    const s = W.site;
    s.loading = true; s.error = null;
    const pending = parseMarathonPage(url, { onTask: (t) => { s.parseTask = t; } });
    render();
    const { marathon, error, task } = await pending;
    s.loading = false;
    if (error || !marathon) { s.error = error || 'нет данных'; render(); return; }
    W.parsed.site = normalizeParsed({ ...marathon, stages: marathon.stages || [], quests: marathon.quests || [] }, task);
    const parsed = W.parsed.site;
    if (!s.titles.some(t => t.url === url)) {
      // своя ссылка: запоминаем, чтобы в следующий раз она искалась автоматически
      rememberCustomPage(url);
      s.titles.push({ name: parsed.name, url });
      s.selectedUrl = url;
      persist();
    }
    applyMerged();
    task?.finish(`Этапов ${parsed.stages.length}, заданий ${parsed.quests.length}`, parsed.stages.some(st => st.guessed) ? 'warn' : 'done');
    render();
  }

  /** Поиск новости о марафоне в архиве событий (первые 3 страницы). */
  async function doFindNews() {
    const sr = W.news.search;
    sr.loading = true; sr.error = null;
    const pending = searchNewsList({ onTask: (t) => { sr.task = t; } });
    render();
    const { items, error } = await pending;
    sr.loading = false; sr.items = items; sr.error = items.length ? null : (error || 'empty');
    render();
  }

  /** Результаты поиска: найденные новости с кнопкой «Выбрать». */
  function newsSearchHtml(sr) {
    if (!sr.task && !sr.items && !sr.error) return '';
    const found = sr.items ? filterNews(sr.items, { all: sr.all }) : [];
    return `
      <div class="tf-news-search">
        ${sr.task && sr.loading ? taskCardHtml(sr.task) : ''}
        ${sr.error ? `<p class="tf-warn">Не удалось получить список новостей: ${escapeHtml(errorText(sr.error))}. Вставьте ссылку вручную.</p>` : ''}
        ${sr.items ? `
          <label class="tf-radio tf-small"><input type="checkbox" data-news-all ${sr.all ? 'checked' : ''}/> Показать все новости, не только со словом «марафон» (просмотрено ${sr.items.length})</label>
          ${found.length ? `<div class="tf-list">${found.map(x => `
            <div class="tf-list-item">
              <span class="tf-grow"><strong>${escapeHtml(x.title)}</strong> <small class="muted">${escapeHtml(x.date)}</small></span>
              <button type="button" class="btn" data-pick-news="${escapeHtml(x.url)}">Выбрать</button>
            </div>`).join('')}</div>`
            : '<p class="muted">Новостей о марафоне на первых страницах нет. Включите «Показать все» или вставьте ссылку вручную.</p>'}` : ''}
      </div>`;
  }

  async function doParseNews() {
    const n = W.news;
    if (!isNewsUrl(n.url)) { toast('Нужна ссылка вида https://pwonline.ru/news.php?article=…', 'warning'); return; }
    n.loading = true; n.error = null;
    const pending = loadNewsPage(n.url, { onTask: (t) => { n.task = t; } });
    render();
    const { marathon, error, task } = await pending;
    n.loading = false;
    if (error || !marathon) { n.error = error || 'нет данных'; render(); return; }
    W.parsed.news = normalizeParsed(marathon, task);
    applyMerged();
    task?.finish(`Этапов ${W.parsed.news.stages.length}, заданий ${W.parsed.news.quests.length}`, marathon.debug.some(d => /вручную|проверьте/.test(d)) ? 'warn' : 'done');
    render();
    // страница отметок из новости: сверяем сразу, если есть персонаж со входом
    const url = W.parsed.news.sourceUrl;
    if (n.verify && url && pickScannerCharacter() && !W.parsed.site && !W.site.loading) await doParse(url);
  }

  /** Объединяет загруженные источники: названия — со страницы отметок, остальное — из новости. */
  function applyMerged() {
    const s = W.site;
    const { raw, notes } = mergeSiteAndNews({ news: W.parsed.news, site: W.parsed.site });
    s.raw = raw; s.compare = notes;
    if (!raw) return;
    s.stageKeys = raw.stages.map(st => st.key);   // по умолчанию выбраны все этапы
    s.split = raw.stages.length > 1 ? 'stages' : 'all';
    W.seriesTitle = raw.name;
  }

  /** Итог под блоками источников: что загружено, что нашлось, расхождения. */
  function sourceSummaryHtml(raw) {
    const P = W.parsed;
    const part = (icon, label, p) => p ? `<span class="tf-chip is-ok">${icon} ${label}: заданий ${p.quests.length}, этапов ${p.stages.length}</span>` : `<span class="tf-chip">${icon} ${label}: не загружено</span>`;
    const warns = W.site.compare.filter(x => x.level === 'warn'), infos = W.site.compare.filter(x => x.level === 'info');
    const withDesc = raw.quests.filter(q => q.description).length;
    return `
      <div class="tf-src-summary">
        <p class="tf-ok">✅ «${escapeHtml(raw.name)}»: этапов ${raw.stages.length}, заданий ${raw.quests.length}, описаний ${withDesc}. Нажмите «Далее».</p>
        <div class="row gap">${part('📰', 'Новость', P.news)}${part('🌐', 'Страница отметок', P.site)}</div>
        ${raw.stages.some(st => st.guessed) ? `<p class="tf-warn">⚠ Сроки этапов ${raw.stages.filter(st => st.guessed).map(st => `«${escapeHtml(st.name)}»`).join(', ')} не найдены — даты поставлены по календарному месяцу, проверьте их на следующем шаге.</p>` : ''}
        ${warns.length ? `<ul class="tf-compare">${warns.map(x => `<li class="tf-warn">⚠ ${escapeHtml(x.text)}</li>`).join('')}</ul>` : (P.news && P.site ? '<p class="tf-ok tf-small">Сверка новости со страницей отметок: расхождений нет.</p>' : '')}
        ${infos.length ? `<details class="tf-small"><summary class="muted">Подробности сверки (${infos.length})</summary><ul class="tf-compare">${infos.map(x => `<li class="muted">${escapeHtml(x.text)}</li>`).join('')}</ul></details>` : ''}
        <div class="tf-news-preview">${raw.stages.map(st => `
          <div class="tf-news-stage">
            <strong>📅 ${escapeHtml(st.name)}</strong> <small class="muted">${st.startDate || '?'} — ${st.endDate || '?'}</small>
            ${st.bonus ? `<div class="tf-small">🎁 ${escapeHtml(st.bonus.text)} — за ${st.bonus.needTasks} выполн. заданий</div>` : ''}
            <ul>${raw.quests.filter(q => q.stageKey === st.key || (!q.stageKey && raw.stages.length === 1)).map(q => `<li>${escapeHtml(q.title)} — цель ${q.goal}${q.weekly ? ' (раз в неделю)' : ''} · ${(q.rewards || []).map(r => `${r.threshold}→🪙${r.rewardCoins}`).join(', ') || 'без наград'}${q.description ? '' : ' · <span class="tf-warn">без описания</span>'}</li>`).join('')}</ul>
          </div>`).join('')}</div>
        <p class="muted tf-small">🌐 Сверка отметок: ${raw.sourceUrl ? escapeHtml(raw.sourceUrl.replace('https://', '')) : '<span class="tf-warn">ссылка не найдена — укажите на следующем шаге</span>'}</p>
      </div>`;
  }

  /**
   * Дополняет разбор сайта: если у заданий есть месяц «(июнь)», а сроков такого этапа
   * на странице не нашлось — создаём этап по календарному месяцу (помечен guessed).
   * Задания с непонятной пометкой в скобках считаются общими для всех этапов.
   */
  function normalizeParsed(raw, task) {
    const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    const stages = raw.stages.map(st => ({ ...st, key: String(st.key || '').toLowerCase().trim() }));
    const keyOf = (k) => { const low = String(k || '').toLowerCase().trim(); return MONTHS.find(m => low.includes(m)) || low || null; };
    const quests = raw.quests.map(q => ({ ...q, stageKey: keyOf(q.stageKey) }));
    const today = new Date();
    quests.forEach(q => {
      if (!q.stageKey || stages.some(st => st.key === q.stageKey)) return;
      const mi = MONTHS.indexOf(q.stageKey);
      if (mi === -1) { q.stageKey = null; return; }   // непонятная пометка → общее задание
      let year = today.getFullYear();
      if (mi + 1 < today.getMonth() + 1 - 6) year += 1; else if (mi + 1 > today.getMonth() + 1 + 6) year -= 1;
      const last = new Date(year, mi + 1, 0).getDate();
      const mm = String(mi + 1).padStart(2, '0');
      stages.push({ name: q.stageKey[0].toUpperCase() + q.stageKey.slice(1), key: q.stageKey, startDate: `${year}-${mm}-01`, endDate: `${year}-${mm}-${last}`, guessed: true });
      task?.log(`Этап «${q.stageKey}» есть в заданиях, но его сроков нет на странице — даты поставлены по месяцу (проверьте)`, 'warn');
    });
    stages.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    return { ...raw, stages, quests };
  }

  /* ---------------- построение черновиков ---------------- */
  function buildDrafts() {
    if (W.source === 'manual') {
      W.drafts = [createMarathon({ title: '', tasks: [createTask()], source: { type: 'manual' } })];
    } else if (W.source === 'template') {
      const t = (state.marathonTemplates || []).find(x => x.id === W.templateId);
      W.drafts = [createMarathon({
        title: t.name,
        tasks: t.tasks.map(x => createTask({ ...clone(x), id: uid(), rewards: (x.rewards || []).map(r => ({ ...r, id: uid() })) })),
        source: { type: 'template', templateId: t.id, url: t.sourceUrl || null },
        bonuses: (t.bonuses || []).map(b => ({ ...b, id: uid() }))
      })];
    } else {
      buildSiteDrafts();
    }
    W.active = 0;
  }

  function buildSiteDrafts() {
    const raw = W.site.raw;
    const fromNews = raw.origin === 'news';   // только новость: названий «как на сайте» ещё нет
    const toTask = (q) => createTask({
      title: q.title, siteTitle: q.siteTitle ?? (raw.origin === 'site' ? q.title : null),
      description: q.description, descriptionSource: q.descriptionSource || (q.description ? (fromNews ? 'news' : 'site') : ''),
      targetChecks: q.goal,
      schedule: q.weekly ? { mode: 'weekly', weekStartDay: 1 } : undefined,
      rewards: (q.rewards || []).map(r => ({ ...r }))
    });
    const source = (extra = {}) => ({ type: fromNews ? 'news' : 'site', url: raw.sourceUrl, siteName: raw.name, newsUrl: raw.newsUrl || null, ...extra });
    const bonusesOf = (st) => st?.bonus ? [{ ...st.bonus }] : [];

    const selected = raw.stages.filter(st => W.site.stageKeys.includes(st.key));
    if (W.site.split === 'all' || raw.stages.length === 0 || selected.length === 0) {
      const sorted = [...raw.stages].sort((a, b) => a.startDate.localeCompare(b.startDate));
      W.drafts = [createMarathon({
        title: raw.name,
        startDate: sorted[0]?.startDate, endDate: sorted[sorted.length - 1]?.endDate,
        tasks: raw.quests.map(toTask), source: source(),
        bonuses: raw.stages.length === 1 ? bonusesOf(raw.stages[0]) : []
      })];
      return;
    }
    W.drafts = selected.map(st => createMarathon({
      title: `${raw.name} — ${st.name}`,
      startDate: st.startDate, endDate: st.endDate,
      tasks: raw.quests.filter(q => q.stageKey === st.key || !q.stageKey).map(toTask),
      source: source({ stageKey: st.key, stageName: st.name }),
      bonuses: bonusesOf(st)
    }));
  }

  function isDuplicate(url, stageKey) {
    return state.marathons.some(m => m.kind !== 'series' && m.source?.url === url && (m.source?.stageKey || null) === (stageKey || null));
  }

  /* ================= ШАГ 1: ЭТАПЫ И ЗАДАНИЯ ================= */
  function draftTabs() {
    if (W.drafts.length < 2) return '';
    return `<div class="tf-tabs">${W.drafts.map((d, i) => `
      <button type="button" class="tf-tab ${i === W.active ? 'is-active' : ''}" data-tab="${i}">${escapeHtml(d.source?.stageName || d.title || `Этап ${i + 1}`)}</button>`).join('')}</div>`;
  }
  function bindTabs() {
    ov.body.querySelectorAll('.tf-tab').forEach(b => b.onclick = () => { W.active = Number(b.dataset.tab); render(); });
  }

  function renderTasksStep() {
    const raw = W.site.raw;
    let stageBlock = '';
    if (!isEdit && (W.source === 'site' || W.source === 'news') && raw && raw.stages.length) {
      const sel = W.site.stageKeys;
      const willSeries = W.site.split === 'stages' && sel.length > 1;
      stageBlock = `
        <div class="tf-panel">
          <div class="row gap">
            <label class="tf-radio"><input type="radio" name="split" value="stages" ${W.site.split === 'stages' ? 'checked' : ''}/> По этапам</label>
            <label class="tf-radio"><input type="radio" name="split" value="all" ${W.site.split === 'all' ? 'checked' : ''}/> Весь марафон одним</label>
          </div>
          ${W.site.split === 'stages' ? `<div class="tf-stage-grid">${raw.stages.map(st => `
            <label class="tf-stage ${sel.includes(st.key) ? 'is-on' : ''}">
              <input type="checkbox" data-stage="${escapeHtml(st.key)}" ${sel.includes(st.key) ? 'checked' : ''}/>
              <strong>📅 ${escapeHtml(st.name)}</strong>
              <small class="muted">${st.startDate} — ${st.endDate} · заданий: ${raw.quests.filter(q => q.stageKey === st.key).length}</small>
              ${st.guessed ? '<small class="tf-warn">⚠ даты по месяцу — проверьте</small>' : ''}
              ${isDuplicate(raw.sourceUrl, st.key) ? '<small class="tf-warn">⚠ уже создан</small>' : ''}
            </label>`).join('')}</div>` : (isDuplicate(raw.sourceUrl, null) ? '<p class="tf-warn">⚠ Этот марафон целиком уже создан.</p>' : '')}
          <p class="muted">${willSeries && folder
            ? `${sel.length} марафонов будут добавлены в папку <strong>«${escapeHtml(folder.title)}»</strong>.`
            : willSeries
            ? `Будет создана <strong>серия «${escapeHtml(W.seriesTitle)}»</strong> из ${sel.length} марафонов с общей статистикой.`
            : `Будет создан один марафон <strong>«${escapeHtml(W.drafts[0]?.title || '')}»</strong>.`}</p>
          ${willSeries && !folder ? `<div class="field"><label>Название серии</label><input class="input" data-series-title value="${escapeHtml(W.seriesTitle)}"/></div>` : ''}
        </div>`;
    }

    const d = W.drafts[W.active];
    const pages = [...SITE_PAGES, ...customPages().map(u => ({ url: u, label: u.replace('https://', '') }))];
    if (d.source?.url && !pages.some(p => p.url === d.source.url)) pages.push({ url: d.source.url, label: d.source.url.replace('https://', '') });
    const parent = state.marathons.find(m => m.id === (d.seriesId || W.seriesId));
    const inheritLabel = parent?.source?.url ? `— как у папки (${parent.source.url.replace('https://', '')}) —` : '— не сверять —';

    ov.body.innerHTML = `${stageBlock}${draftTabs()}
      <div class="tf-panel">
        <div class="two-cols">
          <div class="field"><label>Название марафона *</label><input class="input" data-f="title" value="${escapeHtml(d.title)}"/></div>
          <div class="field"><label>Страница на сайте (для сверки)</label>
            <select class="select" data-f="url">
              <option value="">${escapeHtml(inheritLabel)}</option>
              ${pages.map(p => `<option value="${escapeHtml(p.url)}" ${d.source?.url === p.url ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
              <option value="__custom__">✏️ Своя ссылка…</option>
            </select>
            <input class="input tf-hidden" data-custom-page placeholder="https://pwonline.ru/… — страница, где видны отметки"/></div>
        </div>
        <div class="two-cols">
          <div class="field"><label>Начало *</label><input class="input" type="date" data-f="startDate" value="${d.startDate}"/></div>
          <div class="field"><label>Окончание *</label><input class="input" type="date" data-f="endDate" value="${d.endDate}"/></div>
        </div>
      </div>
      <div class="toolbar"><h4>Задания (${d.tasks.length})</h4><button type="button" class="btn small" data-act="add-task">+ Задание</button></div>
      <div class="tf-task-list">${d.tasks.map((t, i) => taskRow(d, t, i)).join('') || '<p class="muted">Нет заданий.</p>'}</div>`;

    bindTabs();
    ov.body.querySelectorAll('input[name="split"]').forEach(r => r.onchange = () => { W.site.split = r.value; buildSiteDrafts(); W.active = 0; render(); });
    ov.body.querySelectorAll('[data-stage]').forEach(cb => cb.onchange = () => {
      const k = cb.dataset.stage;
      W.site.stageKeys = cb.checked ? [...W.site.stageKeys, k] : W.site.stageKeys.filter(x => x !== k);
      buildSiteDrafts(); W.active = 0; render();
    });
    ov.body.querySelector('[data-series-title]')?.addEventListener('input', e => { W.seriesTitle = e.target.value; });

    ov.body.querySelectorAll('[data-f]').forEach(inp => inp.oninput = inp.onchange = () => {
      const f = inp.dataset.f;
      if (f === 'url') {
        const custom = ov.body.querySelector('[data-custom-page]');
        if (inp.value === '__custom__') { custom.classList.remove('tf-hidden'); custom.focus(); return; }
        custom.classList.add('tf-hidden');
        d.source = { ...d.source, url: inp.value || null };
        return;
      }
      else d[f] = inp.value;
      if (f === 'startDate' || f === 'endDate') refreshTaskStats(d);
      if (f === 'title' && W.drafts.length > 1) ov.body.querySelector(`.tf-tab[data-tab="${W.active}"]`)?.replaceChildren(document.createTextNode(d.source?.stageName || inp.value));
    });
    ov.body.querySelector('[data-custom-page]')?.addEventListener('change', (e) => {
      const u = e.target.value.trim();
      if (!/^https?:\/\//.test(u)) { toast('Ссылка должна начинаться с https://', 'warning'); return; }
      d.source = { ...d.source, url: u };
      rememberCustomPage(u);
      render();
    });
    ov.body.querySelector('[data-act="add-task"]').onclick = () => { d.tasks.push(createTask()); render(); };

    ov.body.querySelectorAll('.tf-task').forEach(row => {
      const t = d.tasks.find(x => x.id === row.dataset.task);
      row.querySelectorAll('[data-t]').forEach(inp => inp.oninput = inp.onchange = () => {
        const f = inp.dataset.t;
        if (f === 'title') t.title = inp.value;
        if (f === 'description') {
          editTaskDescription(t, inp.value);   // ручная правка: сверка с сайтом её не затрёт
          const mark = row.querySelector('[data-desc-mark]'); if (mark) mark.textContent = descMark(t);
          return;
        }
        if (f === 'targetChecks') t.targetChecks = Math.max(1, Number(inp.value) || 1);
        if (f === 'mode') { t.schedule.mode = inp.value; render(); return; }
        if (f === 'dates') t.schedule.dates = inp.value.split(',').map(x => x.trim()).filter(Boolean);
        if (f === 'weekStartDay') t.schedule.weekStartDay = Number(inp.value);
        refreshTaskStats(d);
      });
      row.querySelector('[data-act="del-task"]').onclick = () => {
        d.tasks = d.tasks.filter(x => x.id !== t.id);
        Object.keys(d.assignments).forEach(cid => { d.assignments[cid] = d.assignments[cid].filter(id => id !== t.id); });
        render();
      };
    });
  }

  function taskRow(d, t, i) {
    const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    return `
      <div class="tf-task" data-task="${t.id}">
        <span class="tf-task-num">${i + 1}</span>
        <input class="input tf-grow" data-t="title" value="${escapeHtml(t.title)}" placeholder="Название задания"/>
        <label class="tf-inline">Цель <input class="input tf-num" type="number" min="1" data-t="targetChecks" value="${t.targetChecks}"/></label>
        <select class="select" data-t="mode">
          <option value="everyDay" ${t.schedule.mode === 'everyDay' ? 'selected' : ''}>Каждый день</option>
          <option value="weekly" ${t.schedule.mode === 'weekly' ? 'selected' : ''}>Раз в неделю</option>
          <option value="dates" ${t.schedule.mode === 'dates' ? 'selected' : ''}>По датам</option>
        </select>
        ${t.schedule.mode === 'weekly' ? `<select class="select" data-t="weekStartDay">${days.map((n, k) => `<option value="${k}" ${t.schedule.weekStartDay == k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}
        ${t.schedule.mode === 'dates' ? `<input class="input" data-t="dates" value="${t.schedule.dates.join(', ')}" placeholder="2026-10-01, 2026-10-05"/>` : ''}
        <span class="tf-task-stat" data-stat="${t.id}">${taskStat(d, t)}</span>
        <button type="button" class="icon-btn danger" data-act="del-task" title="Удалить">🗑</button>
        ${t.siteTitle ? `<small class="tf-task-site muted" title="Название на сайте">🌐 ${escapeHtml(t.siteTitle)}</small>` : ''}
        <details class="tf-task-desc">
          <summary class="muted">📝 Описание <small data-desc-mark>${descMark(t)}</small></summary>
          <textarea class="input" rows="3" data-t="description" placeholder="Что нужно сделать в этом задании">${escapeHtml(t.description || '')}</textarea>
        </details>
      </div>`;
  }

  function descMark(t) {
    if (!t.description) return '— нет';
    return { site: '· со страницы сайта', news: '· из новости', manual: '· изменено вручную' }[t.descriptionSource] || '';
  }

  function taskStat(d, t) {
    if (!d.startDate || !d.endDate || d.startDate > d.endDate) return '<span class="tf-warn">даты?</span>';
    const avail = totalActiveDays(d, t);
    const spare = avail - t.targetChecks;
    return spare < 0 ? `<span class="tf-warn">дней ${avail} &lt; цели</span>` : `дней ${avail} · запас <b>${spare}</b>`;
  }
  function refreshTaskStats(d) {
    d.tasks.forEach(t => { const el = ov.body.querySelector(`[data-stat="${t.id}"]`); if (el) el.innerHTML = taskStat(d, t); });
  }

  /* ================= ШАГ 2: УЧАСТНИКИ ================= */
  function renderParticipants() {
    const d = W.drafts[W.active];
    const chars = [...state.characters].sort((a, b) => a.nick.localeCompare(b.nick, 'ru'));
    const groups = new Map();
    // выбор участников идёт по основной пати персонажа
    chars.forEach(c => { const k = mainPartyName(c, state.parties) || NO_PARTY_LABEL; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); });
    const order = [...state.parties].sort((a, b) => (a.order || 0) - (b.order || 0)).map(p => p.name);
    const groupNames = [...groups.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    const isIn = (cid) => d.participantIds.includes(cid);
    const has = (cid, tid) => isIn(cid) && (d.assignments[cid] || []).includes(tid);
    const colCount = (tid) => d.participantIds.filter(cid => has(cid, tid)).length;

    ov.body.innerHTML = `${draftTabs()}
      <div class="toolbar tf-mx-toolbar">
        <span class="muted">Участников: <strong>${d.participantIds.length}</strong> из ${chars.length}</span>
        <div class="row gap">
          <button type="button" class="btn small" data-act="all">Все</button>
          <button type="button" class="btn small" data-act="none">Никого</button>
          <button type="button" class="btn small" data-act="suggest" title="Отметить задания, по которым у персонажа уже есть прогресс на сайте">✨ По данным сайта</button>
          ${W.drafts.length > 1 ? '<button type="button" class="btn small" data-act="copy">📋 Скопировать на все этапы</button>' : ''}
        </div>
      </div>
      <div class="tf-mx-wrap">
        <table class="tf-pick">
          <thead><tr>
            <th class="tf-pick-name">Персонаж</th>
            ${d.tasks.map(t => `<th title="${escapeHtml(t.title)}"><label class="tf-col-head">
              <input type="checkbox" data-col="${t.id}" ${d.participantIds.length && colCount(t.id) === d.participantIds.length ? 'checked' : ''}/>
              <span>${escapeHtml(t.title)}</span></label></th>`).join('')}
          </tr></thead>
          <tbody>
            ${groupNames.map(g => {
              const members = groups.get(g);
              const inCount = members.filter(c => isIn(c.id)).length;
              return `
                <tr class="tf-pick-group"><td colspan="${d.tasks.length + 1}">
                  <label><input type="checkbox" data-party="${escapeHtml(g)}" ${inCount === members.length ? 'checked' : ''}/> 
                  <strong>${escapeHtml(g)}</strong> <span class="muted">${inCount}/${members.length}</span></label></td></tr>
                ${members.map(c => `
                  <tr class="${isIn(c.id) ? '' : 'is-off'}">
                    <td class="tf-pick-name"><label>
                      <input type="checkbox" data-char="${c.id}" ${isIn(c.id) ? 'checked' : ''}/>
                      ${getAuthView(c).icon} <strong>${escapeHtml(c.nick)}</strong> <small class="muted">${escapeHtml(c.class || '')}</small>
                    </label></td>
                    ${d.tasks.map(t => `<td class="tf-pick-cell"><input type="checkbox" data-cell="${c.id}|${t.id}" ${has(c.id, t.id) ? 'checked' : ''} ${isIn(c.id) ? '' : 'disabled'}/></td>`).join('')}
                  </tr>`).join('')}`;
            }).join('')}
          </tbody>
          <tfoot><tr><td class="tf-pick-name muted">Выполняют</td>${d.tasks.map(t => `<td class="tf-pick-cell"><strong>${colCount(t.id)}</strong></td>`).join('')}</tr></tfoot>
        </table>
      </div>`;

    bindTabs();
    const setIn = (cid, on) => {
      if (on) { if (!isIn(cid)) d.participantIds.push(cid); if (!d.assignments[cid]?.length) d.assignments[cid] = d.tasks.map(t => t.id); }
      else { d.participantIds = d.participantIds.filter(x => x !== cid); delete d.assignments[cid]; }
    };
    ov.body.querySelector('[data-act="all"]').onclick = () => { chars.forEach(c => setIn(c.id, true)); render(); };
    ov.body.querySelector('[data-act="none"]').onclick = () => { chars.forEach(c => setIn(c.id, false)); render(); };
    ov.body.querySelector('[data-act="suggest"]').onclick = () => {
      let n = 0;
      chars.forEach(c => {
        const quests = c.marathonData?.quests;
        if (!Array.isArray(quests) || !quests.length) return;
        const ids = d.tasks.filter(t => (matchQuest(t, quests, d.source?.stageKey)?.completed || 0) > 0).map(t => t.id);
        if (ids.length) { setIn(c.id, true); d.assignments[c.id] = ids; n++; }
      });
      toast(n ? `Отмечено по данным сайта: ${n} перс.` : 'Нет сохранённых данных сайта. Сначала выполните «Обновить марафоны».', n ? 'success' : 'info');
      render();
    };
    ov.body.querySelector('[data-act="copy"]')?.addEventListener('click', () => {
      W.drafts.forEach((other, i) => {
        if (i === W.active) return;
        other.participantIds = [...d.participantIds];
        other.assignments = {};
        d.participantIds.forEach(cid => {
          const srcTitles = (d.assignments[cid] || []).map(id => stripParen(d.tasks.find(t => t.id === id)?.title));
          other.assignments[cid] = other.tasks.filter((t, idx) => srcTitles.includes(stripParen(t.title)) || (d.assignments[cid] || []).includes(d.tasks[idx]?.id)).map(t => t.id);
        });
      });
      toast('Участники и задания скопированы на все этапы', 'success');
    });
    ov.body.querySelectorAll('[data-party]').forEach(cb => cb.onchange = () => { groups.get(cb.dataset.party).forEach(c => setIn(c.id, cb.checked)); render(); });
    ov.body.querySelectorAll('[data-char]').forEach(cb => cb.onchange = () => { setIn(cb.dataset.char, cb.checked); render(); });
    ov.body.querySelectorAll('[data-col]').forEach(cb => cb.onchange = () => {
      const tid = cb.dataset.col;
      d.participantIds.forEach(cid => {
        const list = d.assignments[cid] || [];
        d.assignments[cid] = cb.checked ? [...new Set([...list, tid])] : list.filter(x => x !== tid);
      });
      render();
    });
    ov.body.querySelectorAll('[data-cell]').forEach(cb => cb.onchange = () => {
      const [cid, tid] = cb.dataset.cell.split('|');
      const list = d.assignments[cid] || [];
      d.assignments[cid] = cb.checked ? [...new Set([...list, tid])] : list.filter(x => x !== tid);
      render();
    });
  }

  /* ================= ШАГ 3: НАГРАДЫ ================= */
  function renderRewards() {
    const d = W.drafts[W.active];
    ov.body.innerHTML = `${draftTabs()}
      <div class="toolbar">
        <span class="muted">Награда начисляется за <strong>максимальный достигнутый порог</strong> задания.</span>
        <div class="row gap">
          <button type="button" class="btn small" data-act="rw-news">📰 Награды из новости</button>
          ${W.drafts.length > 1 ? '<button type="button" class="btn small" data-act="copy-rw">📋 Скопировать награды на все этапы</button>' : ''}
        </div>
      </div>
      ${W.rwNews.open ? `
        <div class="tf-panel">
          <div class="row gap">
            <input class="input tf-grow" data-rw-news-url placeholder="https://pwonline.ru/news.php?article=…" value="${escapeHtml(W.rwNews.url || d.source?.newsUrl || '')}"/>
            <button type="button" class="btn primary" data-act="rw-news-load" ${W.rwNews.loading ? 'disabled' : ''}>${W.rwNews.loading ? '⏳ Загружаю…' : '📥 Подтянуть награды'}</button>
          </div>
          <small class="muted">Задания сопоставляются по названию (и месяцу этапа). Цели и награды обновятся во всех этапах мастера.</small>
          ${W.rwNews.task ? taskCardHtml(W.rwNews.task) : ''}
        </div>` : ''}
      <div class="tf-panel tf-bonus-panel">
        <div class="toolbar"><strong>🎁 Бонусы за количество заданий</strong><button type="button" class="btn small ghost" data-act="add-bonus">+ Бонус</button></div>
        ${(d.bonuses || []).map(b => `
          <div class="tf-reward-row" data-bonus="${b.id}">
            <label class="tf-inline">За <input class="input tf-num" type="number" min="1" max="${d.tasks.length || 1}" data-b="needTasks" value="${b.needTasks}"/> выполн. заданий</label>
            <input class="input tf-grow" data-b="text" value="${escapeHtml(b.text)}" placeholder="Например: Летний ларец июня"/>
            <button type="button" class="icon-btn danger" data-act="del-bonus">✕</button>
          </div>`).join('') || '<p class="muted tf-small">Нет бонусов. Пример: «за 4 из 5 испытаний — Летний ларец».</p>'}
      </div>
      <div class="tf-reward-list">${d.tasks.map(t => `
        <div class="tf-reward-card" data-task="${t.id}">
          <div class="tf-reward-head"><strong>${escapeHtml(t.title)}</strong><span class="muted">цель ${t.targetChecks}</span></div>
          ${(t.rewards || []).sort((a, b) => a.threshold - b.threshold).map(r => `
            <div class="tf-reward-row" data-rw="${r.id}">
              <label class="tf-inline">Порог <input class="input tf-num" type="number" min="1" data-r="threshold" value="${r.threshold}"/></label>
              <input class="input tf-grow" data-r="rewardText" value="${escapeHtml(r.rewardText)}" placeholder="Награда (например, Сундук)"/>
              <label class="tf-inline">🪙 <input class="input tf-num" type="number" min="0" data-r="rewardCoins" value="${r.rewardCoins}"/></label>
              <button type="button" class="icon-btn danger" data-act="del-rw">✕</button>
            </div>`).join('') || '<p class="muted tf-small">Наград нет.</p>'}
          <div class="row gap">
            <button type="button" class="btn small ghost" data-act="add-rw">+ Порог</button>
            ${(t.rewards || []).some(r => r.threshold === t.targetChecks) ? '' : '<button type="button" class="btn small ghost" data-act="add-full">+ За выполнение цели</button>'}
          </div>
        </div>`).join('')}</div>
      ${isEdit ? '' : `
        <div class="tf-panel">
          <label class="tf-radio"><input type="checkbox" data-act="tpl" ${W.saveTemplate ? 'checked' : ''}/> 📁 Сохранить задания и награды как шаблон</label>
          ${W.saveTemplate ? `<input class="input" data-act="tpl-name" placeholder="Название шаблона" value="${escapeHtml(W.templateName || W.seriesTitle || d.title)}"/>` : ''}
        </div>`}`;

    bindTabs();
    ov.body.querySelectorAll('.tf-reward-card').forEach(card => {
      const t = d.tasks.find(x => x.id === card.dataset.task);
      card.querySelector('[data-act="add-rw"]').onclick = () => {
        const last = Math.max(0, ...t.rewards.map(r => r.threshold));
        t.rewards.push({ id: uid(), threshold: Math.min(t.targetChecks, last + 1) || 1, rewardText: '', rewardCoins: 0 });
        render();
      };
      card.querySelector('[data-act="add-full"]')?.addEventListener('click', () => {
        t.rewards.push({ id: uid(), threshold: t.targetChecks, rewardText: 'Выполнение', rewardCoins: 0 }); render();
      });
      card.querySelectorAll('.tf-reward-row').forEach(row => {
        const r = t.rewards.find(x => x.id === row.dataset.rw);
        row.querySelectorAll('[data-r]').forEach(inp => inp.oninput = () => {
          const f = inp.dataset.r;
          r[f] = f === 'rewardText' ? inp.value : Math.max(0, Number(inp.value) || 0);
        });
        row.querySelector('[data-act="del-rw"]').onclick = () => { t.rewards = t.rewards.filter(x => x.id !== r.id); render(); };
      });
    });
    ov.body.querySelector('[data-act="copy-rw"]')?.addEventListener('click', () => {
      W.drafts.forEach((other, i) => {
        if (i === W.active) return;
        other.tasks.forEach((t, idx) => {
          const src = d.tasks.find(x => stripParen(x.title) === stripParen(t.title)) || d.tasks[idx];
          if (src) t.rewards = src.rewards.map(r => ({ ...r, id: uid() }));
        });
      });
      toast('Награды скопированы на все этапы', 'success');
    });
    ov.body.querySelector('[data-act="rw-news"]').onclick = () => { W.rwNews.open = !W.rwNews.open; render(); };
    ov.body.querySelector('[data-rw-news-url]')?.addEventListener('input', e => { W.rwNews.url = e.target.value.trim(); });
    ov.body.querySelector('[data-act="rw-news-load"]')?.addEventListener('click', importRewardsFromNews);
    ov.body.querySelector('[data-act="add-bonus"]').onclick = () => {
      d.bonuses = [...(d.bonuses || []), { id: uid(), needTasks: Math.max(1, d.tasks.length - 1), text: '' }]; render();
    };
    ov.body.querySelectorAll('[data-bonus]').forEach(row => {
      const b = d.bonuses.find(x => x.id === row.dataset.bonus);
      row.querySelectorAll('[data-b]').forEach(inp => inp.oninput = () => {
        b[inp.dataset.b] = inp.dataset.b === 'text' ? inp.value : Math.max(1, Number(inp.value) || 1);
      });
      row.querySelector('[data-act="del-bonus"]').onclick = () => { d.bonuses = d.bonuses.filter(x => x.id !== b.id); render(); };
    });
    ov.body.querySelector('[data-act="tpl"]')?.addEventListener('change', e => { W.saveTemplate = e.target.checked; render(); });
    ov.body.querySelector('[data-act="tpl-name"]')?.addEventListener('input', e => { W.templateName = e.target.value; });
  }

  /** Подтягивает цели, награды и бонусы из новости в задания черновиков (по названию и месяцу). */
  async function importRewardsFromNews() {
    const d0 = W.drafts[W.active];
    const url = W.rwNews.url || d0.source?.newsUrl || '';
    if (!isNewsUrl(url)) { toast('Нужна ссылка вида https://pwonline.ru/news.php?article=…', 'warning'); return; }
    W.rwNews.url = url; W.rwNews.loading = true;
    const pending = loadNewsPage(url, { onTask: (t) => { W.rwNews.task = t; } });
    render();
    const { marathon: news, error, task } = await pending;
    W.rwNews.loading = false;
    if (error || !news) { render(); return; }
    const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    let matched = 0, missed = 0;
    W.drafts.forEach(d => {
      // этап новости для черновика: по ключу этапа, месяцу из названия или по датам
      const month = d.source?.stageKey || MONTHS.find(m => (d.title || '').toLowerCase().includes(m)) || null;
      const stage = news.stages.find(st => st.key === month)
        || news.stages.find(st => st.startDate && d.startDate >= st.startDate && d.startDate <= st.endDate)
        || (news.stages.length === 1 ? news.stages[0] : null);
      const pool = news.quests.filter(q => !stage || q.stageKey === stage.key);
      d.tasks.forEach(t => {
        const q = pool.find(x => normTitle(x.title) === normTitle(t.title)) || pool.find(x => baseTitle(x.title) === baseTitle(t.siteTitle || t.title));
        if (!q) { missed++; task?.log(`«${t.title}» (${d.source?.stageName || d.title}): в новости не найдено`, 'warn'); return; }
        matched++;
        t.targetChecks = q.goal;
        t.rewards = q.rewards.map(r => ({ ...r, id: uid() }));
        setTaskDescription(t, q.description, 'news');   // описание из новости полнее; ручное не трогаем
        if (q.weekly) t.schedule = { ...t.schedule, mode: 'weekly' };
      });
      if (stage?.bonus && !(d.bonuses || []).some(b => b.text === stage.bonus.text)) d.bonuses = [...(d.bonuses || []), { id: uid(), ...stage.bonus }];
      d.source = { ...d.source, newsUrl: url };
    });
    task?.finish(`Награды подставлены: ${matched}, не найдено: ${missed}`, missed ? 'warn' : 'done');
    toast(`Из новости: обновлено заданий ${matched}${missed ? `, не найдено ${missed}` : ''}`, missed ? 'warning' : 'success');
    render();
  }

  /* ================= ПРОВЕРКА И СОХРАНЕНИЕ ================= */
  function validateStep(step) {
    if (step === 1) {
      for (const d of W.drafts) {
        const name = d.title || d.source?.stageName || 'марафон';
        if (!d.title.trim()) return 'Укажите название марафона.';
        if (!d.startDate || !d.endDate || d.startDate > d.endDate) return `«${name}»: проверьте даты.`;
        if (!d.tasks.length) return `«${name}»: нужно хотя бы одно задание.`;
        const bad = d.tasks.find(t => t.targetChecks > totalActiveDays(d, t));
        if (bad) return `«${name}»: цель «${bad.title}» больше доступных дней.`;
      }
    }
    if (step === 2 && W.drafts.some(d => !d.participantIds.length)) return 'Выберите участников для каждого этапа.';
    return null;
  }

  async function save() {
    for (const s of [1, 2]) { const err = validateStep(s); if (err) { W.step = s; render(); toast(err, 'warning'); return; } }
    const now = new Date().toISOString();
    let openId;

    if (isEdit) {
      const d = W.drafts[0];
      const ids = d.tasks.map(t => t.id);
      Object.keys(d.assignments).forEach(cid => {
        if (!d.participantIds.includes(cid)) delete d.assignments[cid];
        else d.assignments[cid] = d.assignments[cid].filter(id => ids.includes(id));
      });
      d.updatedAt = now;
      const idx = state.marathons.findIndex(m => m.id === d.id);
      if (idx !== -1) state.marathons[idx] = d;
      openId = d.id;
    } else if (folder) {
      W.drafts.forEach(d => { d.seriesId = folder.id; d.createdAt = d.updatedAt = now; folder.childIds.push(d.id); });
      folder.updatedAt = now;
      state.marathons.push(...W.drafts);
      openId = W.drafts.length > 1 ? folder.id : W.drafts[0].id;
    } else if (W.drafts.length > 1) {
      const series = createSeries({ title: W.seriesTitle || W.site.raw?.name || 'Серия', source: { type: 'site', url: W.site.raw?.sourceUrl, siteName: W.site.raw?.name } });
      W.drafts.forEach(d => { d.seriesId = series.id; d.createdAt = d.updatedAt = now; series.childIds.push(d.id); });
      state.marathons.push(series, ...W.drafts);
      openId = series.id;
    } else {
      const d = W.drafts[0];
      d.createdAt = d.updatedAt = now;
      state.marathons.push(d);
      openId = d.id;
    }

    if (!isEdit && W.saveTemplate) {
      const d = W.drafts[0];
      if (!state.marathonTemplates) state.marathonTemplates = [];
      state.marathonTemplates.push({
        id: uid(),
        name: (W.templateName || W.seriesTitle || d.title).trim(),
        sourceUrl: d.source?.url || null,
        tasks: d.tasks.map(t => ({ title: t.title, siteTitle: t.siteTitle, description: t.description, descriptionSource: t.descriptionSource, targetChecks: t.targetChecks, schedule: clone(t.schedule), rewards: clone(t.rewards) })),
        bonuses: clone(d.bonuses || []),
        createdAt: now
      });
    }

    await persist();
    ov.close();
    toast(isEdit ? 'Марафон сохранён' : (W.drafts.length > 1 ? `Создана серия из ${W.drafts.length} марафонов` : 'Марафон создан'), 'success');
    onSavedCallback?.(openId);
  }

  render();
  if (opts.autoScan && W.source === 'site') doScan();
}

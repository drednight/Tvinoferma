/* docs/visuals/assets/lab.js
   Логика лаборатории: выбор экрана и направления, режим сравнения, оценки,
   ссылка на конкретный экран и выгрузка отчёта.

   Оценки хранятся в localStorage этого браузера и никуда не отправляются:
   их можно выгрузить кнопкой «Выгрузить отчёт» и отправить автору вручную. */

(function () {
  const STORE = 'tv-visuals-votes-v1';

  const state = {
    page: 'today',
    variant: 'a',
    compare: false,
    votes: loadVotes()
  };

  /* ── Оценки ── */
  function loadVotes() {
    try {
      return JSON.parse(localStorage.getItem(STORE)) || {};
    } catch {
      return {};
    }
  }
  function saveVotes() {
    try {
      localStorage.setItem(STORE, JSON.stringify(state.votes));
    } catch {
      /* приватный режим — просто не сохраняем */
    }
  }
  function voteKey(page, variant) {
    return page + '/' + variant;
  }
  function getVote(page, variant) {
    return state.votes[voteKey(page, variant)] || { up: false, down: false, note: '' };
  }
  function setVote(page, variant, patch) {
    const cur = getVote(page, variant);
    state.votes[voteKey(page, variant)] = Object.assign({}, cur, patch);
    saveVotes();
  }

  /* ── Разбор ссылки вида #today/a или #today/a/b ── */
  function readHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    if (!raw) return null;
    const [page, a, b] = raw.split('/');
    if (!TV.PAGE_VARIANTS[page]) return null;
    return { page, variant: a || 'a', compare: b ? b : null };
  }

  /* ── Рисование шапки ── */
  function buildNav() {
    const pages = document.getElementById('lab-pages');
    pages.innerHTML = Object.keys(TV.PAGE_VARIANTS)
      .map(id => {
        const title = {
          today: 'Сегодня',
          characters: 'Персонажи',
          parties: 'Пати',
          marathons: 'Марафоны',
          runes: 'Руны',
          finance: 'Банк',
          tools: 'Инструменты',
          profile: 'Профиль',
          settings: 'Настройки'
        }[id];
        const ico = {
          today: 'i-home',
          characters: 'i-users',
          parties: 'i-shield',
          marathons: 'i-flag',
          runes: 'i-rune',
          finance: 'i-wallet',
          tools: 'i-bolt',
          profile: 'i-note',
          settings: 'i-gear'
        }[id];
        return `<button class="lab-page" data-page="${id}" type="button" ${
          id === state.page ? 'aria-current="page"' : ''
        }><svg class="ic"><use href="#${ico}"/></svg>${title}</button>`;
      })
      .join('');

    const vars = document.getElementById('lab-variants');
    vars.innerHTML = Object.keys(TV.VARIANTS)
      .map(
        v =>
          `<button class="lab-var" data-variant="${v}" type="button" aria-pressed="${
            v === state.variant
          }">${TV.VARIANTS[v].name}</button>`
      )
      .join('');
  }

  /* ── Карточка варианта с кнопками оценки ── */
  function frame(variant, page) {
    const v = getVote(page, variant);
    const up = v.up ? 'true' : 'false';
    const down = v.down ? 'true' : 'false';
    return `<article class="lab-frame" data-frame="${variant}">
      <div class="lab-frame-bar">
        <strong>${TV.VARIANTS[variant].name}</strong>
        <span class="muted">${TV.VARIANTS[variant].desc}</span>
        <span class="spacer"></span>
        <button class="lab-vote up" data-vote="up" data-variant="${variant}" aria-pressed="${up}" title="Нравится">
          <svg class="ic"><use href="#i-thumb-up"/></svg>
        </button>
        <button class="lab-vote down" data-vote="down" data-variant="${variant}" aria-pressed="${down}" title="Не нравится">
          <svg class="ic"><use href="#i-thumb-down"/></svg>
        </button>
      </div>
      <div class="lab-frame-canvas">${TV.render(page, variant)}</div>
      <div class="lab-frame-note">
        <input type="text" data-note="${variant}" placeholder="Заметка по этому варианту…" value="${String(
          v.note || ''
        ).replace('"', '&quot;')}"/>
      </div>
    </article>`;
  }

  /* Макет рисуется в окне 1440px и подгоняется под ширину рамки */
  const CANVAS_W = 1440;
  function fitFrames() {
    document.querySelectorAll('.lab-frame-canvas').forEach(c => {
      const root = c.querySelector('.tv-root');
      if (!root) return;
      const fit = Math.min(1, c.clientWidth / CANVAS_W);
      c.style.setProperty('--fit', String(fit));
      const h = root.scrollHeight;
      c.style.height = Math.round(h * fit) + 'px';
    });
  }

  /* ── Основная отрисовка ── */
  function render() {
    const stage = document.getElementById('lab-stage');
    if (state.compare) {
      const other = state.variant === 'a' ? 'b' : 'a';
      stage.classList.add('compare');
      stage.innerHTML = frame(state.variant, state.page) + frame(other, state.page);
    } else {
      stage.classList.remove('compare');
      stage.innerHTML = frame(state.variant, state.page);
    }

    const v = TV.VARIANTS[state.variant];
    document.getElementById('lab-variant-name').textContent = v.name;
    document.getElementById('lab-variant-desc').textContent = v.desc;
    document.getElementById('lab-compare').setAttribute('aria-pressed', String(state.compare));

    document.querySelectorAll('.lab-page').forEach(b => {
      if (b.dataset.page === state.page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.lab-var').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.variant === state.variant));
    });

    updateVotesCount();
    writeHash();
    fitFrames();
  }

  function writeHash() {
    const other = state.variant === 'a' ? 'b' : 'a';
    const hash = state.compare ? `#${state.page}/${state.variant}/${other}` : `#${state.page}/${state.variant}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function updateVotesCount() {
    let n = 0;
    Object.values(state.votes).forEach(v => {
      if (v.up || v.down || v.note) n++;
    });
    document.getElementById('lab-votes-count').textContent = String(n);
  }

  /* ── Сводка оценок ── */
  function renderDrawer() {
    const body = document.getElementById('lab-drawer-body');
    const groups = {};
    Object.keys(state.votes).forEach(k => {
      const [page, variant] = k.split('/');
      (groups[page] = groups[page] || {})[variant] = state.votes[k];
    });

    if (!Object.keys(groups).length) {
      body.innerHTML =
        '<p class="lab-empty">Оценок пока нет. Поставьте 👍 или 👎 под любым вариантом — оценка появится здесь.</p>';
      return;
    }

    const titles = {
      today: 'Сегодня',
      characters: 'Персонажи',
      parties: 'Пати',
      marathons: 'Марафоны',
      runes: 'Руны',
      finance: 'Банк',
      tools: 'Инструменты',
      profile: 'Профиль',
      settings: 'Настройки'
    };

    body.innerHTML = Object.keys(groups)
      .map(page => {
        const rows = Object.keys(groups[page])
          .map(variant => {
            const v = groups[page][variant];
            const up = v.up ? 1 : 0;
            const down = v.down ? 1 : 0;
            return `<div class="lab-vote-row">
              <strong>${TV.VARIANTS[variant].name}</strong>
              <span class="spacer"></span>
              <span class="tally up">👍 ${up}</span>
              <span class="tally down">👎 ${down}</span>
            </div>${v.note ? `<div class="lab-note">${escapeHtml(v.note)}</div>` : ''}`;
          })
          .join('');
        const upTotal = Object.values(groups[page]).reduce((s, v) => s + (v.up ? 1 : 0), 0);
        const downTotal = Object.values(groups[page]).reduce((s, v) => s + (v.down ? 1 : 0), 0);
        const best = Object.keys(groups[page]).sort((a, b) => {
          const sa = (groups[page][a].up ? 1 : 0) - (groups[page][a].down ? 1 : 0);
          const sb = (groups[page][b].up ? 1 : 0) - (groups[page][b].down ? 1 : 0);
          return sb - sa;
        })[0];
        return `<h4>${titles[page] || page}</h4>${rows}
          <p class="lab-empty" style="border:0;padding:4px 0 0">Лидер: ${TV.VARIANTS[best].name} · 👍 ${upTotal} / 👎 ${downTotal}</p>`;
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  /* ── Отчёт ── */
  function report() {
    const titles = {
      today: 'Сегодня',
      characters: 'Персонажи',
      parties: 'Пати',
      marathons: 'Марафоны',
      runes: 'Руны',
      finance: 'Банк',
      tools: 'Инструменты',
      profile: 'Профиль',
      settings: 'Настройки'
    };
    const lines = ['# Оценки вариантов интерфейса Твинофермы', ''];
    const groups = {};
    Object.keys(state.votes).forEach(k => {
      const [page, variant] = k.split('/');
      (groups[page] = groups[page] || {})[variant] = state.votes[k];
    });
    Object.keys(groups).forEach(page => {
      lines.push('## ' + (titles[page] || page));
      Object.keys(groups[page]).forEach(variant => {
        const v = groups[page][variant];
        const mark = v.up ? '👍' : v.down ? '👎' : '—';
        lines.push(`- ${TV.VARIANTS[variant].name}: ${mark}${v.note ? ' — ' + v.note : ''}`);
      });
      lines.push('');
    });
    if (lines.length <= 2) lines.push('(оценок нет)');
    return lines.join('\n');
  }

  function exportReport(copy) {
    const text = report();
    if (copy && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => flash('Отчёт скопирован в буфер обмена'),
        () => download(text)
      );
    } else {
      download(text);
    }
  }

  function download(text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tvinoferma-visual-review.txt';
    a.click();
    URL.revokeObjectURL(a.href);
    flash('Файл отчёта сохранён');
  }

  let flashTimer = null;
  function flash(msg) {
    let el = document.getElementById('lab-flash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lab-flash';
      el.style.cssText =
        'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#7c8cff;color:#0b0d14;padding:9px 16px;border-radius:9px;font-size:13px;font-weight:600;z-index:200;box-shadow:0 10px 30px rgba(0,0,0,.4)';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (el.style.display = 'none'), 2200);
  }

  /* ── Обработчики ── */
  document.getElementById('lab-pages').addEventListener('click', e => {
    const b = e.target.closest('.lab-page');
    if (!b) return;
    state.page = b.dataset.page;
    render();
  });

  document.getElementById('lab-variants').addEventListener('click', e => {
    const b = e.target.closest('.lab-var');
    if (!b) return;
    state.variant = b.dataset.variant;
    render();
  });

  document.getElementById('lab-compare').addEventListener('click', () => {
    state.compare = !state.compare;
    render();
  });

  document.getElementById('lab-share').addEventListener('click', () => {
    const url = location.href;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(
        () => flash('Ссылка скопирована: ' + url.split('#')[1]),
        () => flash('Скопируйте адрес из строки браузера')
      );
    } else {
      flash('Скопируйте адрес из строки браузера');
    }
  });

  document.getElementById('lab-votes').addEventListener('click', () => {
    const d = document.getElementById('lab-drawer');
    d.hidden = !d.hidden;
    if (!d.hidden) renderDrawer();
  });

  document.getElementById('lab-drawer-close').addEventListener('click', () => {
    document.getElementById('lab-drawer').hidden = true;
  });

  document.getElementById('lab-export').addEventListener('click', () => exportReport(false));
  document.getElementById('lab-export-2').addEventListener('click', () => exportReport(true));

  document.getElementById('lab-reset').addEventListener('click', () => {
    if (!confirm('Удалить все оценки и заметки?')) return;
    state.votes = {};
    saveVotes();
    render();
    renderDrawer();
  });

  document.getElementById('lab-stage').addEventListener('click', e => {
    const b = e.target.closest('.lab-vote');
    if (!b) return;
    const variant = b.dataset.variant;
    const kind = b.dataset.vote;
    const cur = getVote(state.page, variant);
    const patch = kind === 'up' ? { up: !cur.up, down: false } : { down: !cur.down, up: false };
    setVote(state.page, variant, patch);
    render();
  });

  document.getElementById('lab-stage').addEventListener('input', e => {
    const input = e.target.closest('[data-note]');
    if (!input) return;
    setVote(state.page, input.dataset.note, { note: input.value });
    updateVotesCount();
  });

  window.addEventListener('hashchange', () => {
    const h = readHash();
    if (!h) return;
    state.page = h.page;
    state.variant = h.variant;
    state.compare = !!h.compare;
    render();
  });

  window.addEventListener('resize', fitFrames);

  /* ── Старт ── */
  buildNav();
  const h = readHash();
  if (h) {
    state.page = h.page;
    state.variant = h.variant;
    state.compare = !!h.compare;
  }
  render();
})();

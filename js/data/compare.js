// js/data/compare.js
// Окно сравнения двух карточек персонажа при импорте.
// Все поля показываются рядом: «Текущая карточка» и «Из файла»; для каждого
// отличающегося поля можно выбрать, какое значение сохранить (у тегов и истории
// монет есть вариант «Объединить»).

import { escapeHtml } from '../core/utils.js';
import { FIELD_GROUPS, getPath, displayValue, buildMerged, diffCharacters } from './characterFields.js';

/**
 * @returns {Promise<{ action: 'merge', character: object } | { action: 'keep' } | { action: 'both' } |
 *                   { action: 'cancel' } | { action: 'all-local' } | { action: 'all-incoming' }>}
 */
export function openCompareDialog(local, incoming, { index = 1, total = 1, present = null } = {}) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    if (!root) return resolve({ action: 'keep' });

    const diffs = new Set(diffCharacters(local, incoming, present).map(f => f.path));
    const missing = path => present && !present.has(path);
    const picks = {};                 // path -> 'local' | 'incoming' | 'merge'
    diffs.forEach(p => { picks[p] = 'incoming'; });   // по умолчанию — данные из файла
    let onlyDiff = false;
    let showSecrets = false;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-container cmp-modal">
        <div class="modal-header"><h3>Совпадение ${index} из ${total}: «${escapeHtml(local.nick)}»</h3></div>
        <div class="modal-body">
          <div class="cmp-toolbar">
            <span class="muted">Отличается полей: <strong>${diffs.size}</strong>. Отметьте, какое значение оставить.</span>
            <div class="row gap">
              <button type="button" class="btn small" data-all="local">⬅ Всё из текущей</button>
              <button type="button" class="btn small" data-all="incoming">Всё из файла ➡</button>
              <label class="switch-row"><input type="checkbox" data-only-diff /> Только различия</label>
              <label class="switch-row"><input type="checkbox" data-secrets /> Показать пароль</label>
            </div>
          </div>
          <div class="cmp-table-wrap"><table class="cmp-table" data-table></table></div>
        </div>
        <div class="modal-footer cmp-footer">
          <button type="button" class="btn ghost" data-act="cancel" title="Остановить импорт без изменений">Отменить импорт</button>
          <span class="cmp-spacer"></span>
          ${total - index > 0 ? `
          <button type="button" class="btn ghost" data-act="all-local" title="Для этого и всех следующих совпадений оставить текущие карточки">Оставить текущие для всех</button>
          <button type="button" class="btn ghost" data-act="all-incoming" title="Для этого и всех следующих совпадений взять данные из файла">Взять из файла для всех</button>` : ''}
          <button type="button" class="btn" data-act="both" title="Сохранить обе карточки: из файла добавится как новый персонаж">Оставить обе</button>
          <button type="button" class="btn" data-act="keep">Оставить текущую</button>
          <button type="button" class="btn primary" data-act="merge">Сохранить выбранное</button>
        </div>
      </div>`;
    root.innerHTML = '';
    root.appendChild(overlay);

    const table = overlay.querySelector('[data-table]');
    const cell = (field, side, value) => {
      const differs = diffs.has(field.path);
      const shown = side === 'incoming' && missing(field.path) ? 'нет в файле'
        : field.secret && !showSecrets && value ? '••••••' : displayValue(field, value);
      const title = field.type === 'json' && value ? escapeHtml(JSON.stringify(value, null, 1).slice(0, 2000)) : '';
      const chosen = differs && picks[field.path] === side;
      return `<td class="cmp-val ${chosen ? 'chosen' : ''}" ${title ? `title="${title}"` : ''}>
        ${differs ? `<label><input type="radio" name="pick-${escapeHtml(field.path)}" value="${side}" ${chosen ? 'checked' : ''} data-path="${escapeHtml(field.path)}" /> ` : '<label class="muted">'}
        <span>${escapeHtml(shown)}</span></label></td>`;
    };

    function draw() {
      const rows = FIELD_GROUPS.map(group => {
        const fields = group.fields.filter(f => !onlyDiff || diffs.has(f.path));
        if (!fields.length) return '';
        const groupDiffs = fields.filter(f => diffs.has(f.path)).length;
        return `
          <tr class="cmp-group"><th colspan="3">${escapeHtml(group.title)}
            ${groupDiffs ? `<span class="cmp-group-actions">
              <button type="button" class="btn tiny ghost" data-group="${group.id}" data-side="local">⬅ текущие</button>
              <button type="button" class="btn tiny ghost" data-group="${group.id}" data-side="incoming">из файла ➡</button>
            </span>` : '<span class="muted cmp-same">совпадает</span>'}</th></tr>
          ${fields.map(f => {
            const differs = diffs.has(f.path);
            const a = getPath(local, f.path);
            const b = getPath(incoming, f.path);
            return `<tr class="${differs ? 'cmp-diff' : 'cmp-same-row'}">
              <td class="cmp-label">${escapeHtml(f.label)}${differs && f.mergeable ? `
                <label class="cmp-merge"><input type="radio" name="pick-${escapeHtml(f.path)}" value="merge" data-path="${escapeHtml(f.path)}" ${picks[f.path] === 'merge' ? 'checked' : ''}/> объединить</label>` : ''}</td>
              ${cell(f, 'local', a)}${cell(f, 'incoming', b)}
            </tr>`;
          }).join('')}`;
      }).join('');
      table.innerHTML = `
        <thead><tr><th>Поле</th>
          <th>Текущая карточка<br><small class="muted">изм. ${escapeHtml(local.updatedAt ? new Date(local.updatedAt).toLocaleString('ru-RU') : '—')}</small></th>
          <th>Из файла<br><small class="muted">изм. ${escapeHtml(incoming.updatedAt ? new Date(incoming.updatedAt).toLocaleString('ru-RU') : '—')}</small></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="muted">Карточки совпадают.</td></tr>'}</tbody>`;
    }

    const groupFields = id => FIELD_GROUPS.find(g => g.id === id)?.fields || [];
    overlay.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.path) { picks[t.dataset.path] = t.value; draw(); }
      else if ('onlyDiff' in t.dataset) { onlyDiff = t.checked; draw(); }
      else if ('secrets' in t.dataset) { showSecrets = t.checked; draw(); }
    });

    const finish = result => { document.removeEventListener('keydown', onKey); root.innerHTML = ''; resolve(result); };
    const onKey = e => { if (e.key === 'Escape') finish({ action: 'cancel' }); };
    document.addEventListener('keydown', onKey);

    overlay.addEventListener('click', e => {
      const all = e.target.closest('[data-all]');
      if (all) { diffs.forEach(p => { picks[p] = all.dataset.all; }); draw(); return; }
      const grp = e.target.closest('[data-group]');
      if (grp) { groupFields(grp.dataset.group).forEach(f => { if (diffs.has(f.path)) picks[f.path] = grp.dataset.side; }); draw(); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'merge') finish({ action: 'merge', character: buildMerged(local, incoming, picks) });
      else finish({ action: act });
    });

    draw();
  });
}

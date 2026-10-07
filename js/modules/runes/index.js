// js/modules/runes/index.js

import { CLASSES, getClassIconSrc } from '../../core/constants.js';
import { copyToClipboard, escapeHtml } from '../../core/utils.js';
import { toast } from '../../core/ui.js';
import { filterRunes, loadRuneCatalog } from './catalog.js';
import { createRuneSubmission, submitRuneSuggestion } from './submit.js';
import { openOverlay } from '../marathons/overlay.js';

const view = { runes: [], className: '', status: 'loading', fromCache: false, message: '' };

export function bindRunes() {
	const root = document.getElementById('runes-root');
	if (!root || root.dataset.runesBound) return;
	root.dataset.runesBound = 'true';
	root.addEventListener('change', event => {
		if (event.target.matches('[data-runes-class]')) {
			view.className = event.target.value;
			renderRunes();
		}
	});
	root.addEventListener('click', async event => {
		const copy = event.target.closest('[data-rune-copy]');
		if (copy) {
			const ok = await copyToClipboard(copy.dataset.runeCopy);
			toast(ok ? 'Руны скопированы' : 'Не удалось скопировать руны', ok ? 'success' : 'error');
			return;
		}
		if (event.target.closest('[data-runes-refresh]')) await refreshRunes();
		if (event.target.closest('[data-runes-submit]')) openRuneSubmission();
	});
	renderRunes();
	refreshRunes();
}

async function refreshRunes() {
	view.status = 'loading';
	view.message = '';
	renderRunes();
	try {
		const result = await loadRuneCatalog();
		view.runes = result.catalog.runes;
		view.fromCache = result.fromCache;
		view.status = 'ready';
		view.message = result.source === 'bundle'
			? 'Встроенный каталог · GitHub пока недоступен'
			: result.fromCache
				? `Офлайн-кэш · ${formatDateTime(result.cachedAt)}`
				: `Обновлено ${formatDateTime(result.cachedAt)}`;
	} catch (error) {
		view.status = 'error';
		view.message = `Не удалось загрузить каталог: ${error.message}`;
	}
	renderRunes();
}

export function renderRunes() {
	const root = document.getElementById('runes-root');
	if (!root) return;
	const runes = filterRunes(view.runes, view.className);
	const status = view.status === 'loading' ? 'Загрузка каталога…' : view.message;
	root.innerHTML = `
		<header class="runes-header">
			<div><p class="runes-kicker">Сборки сообщества</p><h2>Руны</h2><p class="muted">PvE, PvP и дополнительные варианты для каждого класса.</p></div>
			<button class="btn primary" type="button" data-runes-submit>Предложить раскладку</button>
		</header>
		<div class="runes-toolbar">
			<label class="runes-class-filter">Класс
				<select class="select" data-runes-class aria-label="Фильтр по классу">
					<option value="" ${view.className ? '' : 'selected'}>Все классы</option>
					${CLASSES.map(name => `<option value="${escapeHtml(name)}" ${view.className === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
				</select>
			</label>
			<p class="runes-status${view.status === 'error' ? ' is-error' : ''}" role="status" aria-live="polite">${escapeHtml(status)}</p>
			<button class="btn ghost" type="button" data-runes-refresh ${view.status === 'loading' ? 'disabled' : ''} title="Загрузить каталог с GitHub">Обновить</button>
		</div>
		<div class="runes-table-wrap">
			<table class="runes-table">
				<thead><tr><th>Класс</th><th>PvE руны</th><th>PvP руны</th><th>Доп. руны</th><th>Автор</th><th>Примечание</th><th>Добавлено</th></tr></thead>
				<tbody>${runes.length ? runes.map(runeRow).join('') : `<tr><td class="runes-empty" colspan="7">${view.status === 'loading' ? 'Подключаемся к GitHub…' : view.status === 'error' ? 'Каталог пока недоступен.' : 'Для выбранного фильтра раскладок пока нет.'}</td></tr>`}</tbody>
			</table>
		</div>
		<p class="runes-footnote">Предложения попадут на проверку и появятся в каталоге после одобрения.</p>`;
}

function openRuneSubmission() {
	const overlay = openOverlay({ title: 'Предложить раскладку рун' });
	overlay.body.innerHTML = `
		<form class="runes-submit-form">
			<label class="field">Класс<select class="select" name="class" required><option value="">Выберите класс</option>${CLASSES.map(name => `<option value="${escapeHtml(name)}" ${view.className === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>
			<label class="field">Автор<input class="input" name="author" maxlength="100" required autocomplete="nickname" placeholder="Игровой ник или имя"/></label>
			<label class="field">PvE руны<textarea class="input" name="pve" rows="3" maxlength="2000" required placeholder="Укажите коды рун"></textarea></label>
			<label class="field">PvP руны<textarea class="input" name="pvp" rows="3" maxlength="2000" required placeholder="Укажите коды рун"></textarea></label>
			<label class="field">Дополнительные руны<textarea class="input" name="additional" rows="2" maxlength="2000" placeholder="Необязательно"></textarea></label>
			<label class="field">Примечание<textarea class="input" name="note" rows="3" maxlength="500" placeholder="До 500 символов"></textarea></label>
			<p class="runes-submit-status muted" data-submit-status role="status" aria-live="polite"></p>
		</form>`;
	overlay.foot.innerHTML = '<button type="button" class="btn ghost" data-submit-close>Отмена</button><button type="button" class="btn primary" data-submit-send>Отправить на проверку</button>';
	overlay.body.querySelector('form').addEventListener('submit', event => {
		event.preventDefault();
		overlay.foot.querySelector('[data-submit-send]').click();
	});
	overlay.foot.querySelector('[data-submit-close]').onclick = () => overlay.close();
	overlay.foot.querySelector('[data-submit-send]').onclick = async event => {
		const button = event.currentTarget;
		const form = overlay.body.querySelector('form');
		if (!form.reportValidity()) return;
		const values = Object.fromEntries(new FormData(form));
		const status = overlay.body.querySelector('[data-submit-status]');
		button.disabled = true;
		status.textContent = 'Отправляем…';
		try {
			const payload = createRuneSubmission(values);
			await submitRuneSuggestion(payload);
			overlay.body.innerHTML = '<div class="runes-submit-result"><h4>Спасибо, что отправили свой вариант рун</h4><p>После проверки вашего варианта он будет опубликован.</p></div>';
			overlay.foot.innerHTML = '<button type="button" class="btn primary" data-submit-done>Готово</button>';
			overlay.foot.querySelector('[data-submit-done]').onclick = () => overlay.close();
		} catch (error) {
			status.textContent = error.message;
			status.classList.add('is-error');
			button.disabled = false;
		}
	};
}

function runeRow(rune) {
	const icon = getClassIconSrc(rune.class);
	return `<tr>
		<th scope="row" class="runes-class-cell">${icon ? `<img src="${icon}" alt="" loading="lazy"/>` : ''}<span>${escapeHtml(rune.class)}</span></th>
		${copyCell(rune.pve)}${copyCell(rune.pvp)}${copyCell(rune.additional)}
		<td>${escapeHtml(rune.author) || '<span class="muted">—</span>'}</td>
		<td class="runes-note">${escapeHtml(rune.note) || '<span class="muted">—</span>'}</td>
		<td>${escapeHtml(formatDate(rune.addedAt))}</td>
	</tr>`;
}

function copyCell(value) {
	if (!value) return '<td><span class="muted">—</span></td>';
	return `<td><button class="runes-code" type="button" data-rune-copy="${escapeHtml(value)}" title="Скопировать руны"><span>${escapeHtml(value)}</span><span class="runes-copy-icon" aria-hidden="true">⧉</span></button></td>`;
}

function formatDate(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '—';
	return new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU');
}

function formatDateTime(value) {
	if (!value) return '';
	return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

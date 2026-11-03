import { beforeAll, beforeEach, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const $ = s => document.querySelector(s);
const click = s => {
  expect($(s), s).not.toBeNull();
  $(s).click();
};
const input = (s, value, event = 'input') => {
  const el = $(s);
  el.value = value;
  el.dispatchEvent(new Event(event, { bubbles: true }));
};
const submit = () => $('.lg-editor').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
beforeAll(async () => {
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync('demo/variants/index.html', 'utf8'),
    'text/html'
  ).body.innerHTML;
  document.body.dataset.lab = 'classic';
  const dlg = $('#lab-dialog');
  dlg.showModal = function () {
    this.setAttribute('open', '');
  };
  dlg.close = function () {
    this.removeAttribute('open');
  };
  localStorage.setItem('production-sentinel', 'unchanged');
  await import('../demo/design-lab/app.js');
});
beforeEach(() => {
  if ($('#lab-dialog').open) $('#lab-dialog').close();
  click('[data-reset]');
});
it('exposes all ten variants and an excluded original; routes are shareable', () => {
  expect(document.querySelectorAll('[data-variant]')).toHaveLength(10);
  click('[data-page=characters]');
  click('[data-variant="3"]');
  expect(location.search).toContain('page=characters');
  expect(location.search).toContain('variant=3');
  expect($('.lg-master-detail')).not.toBeNull();
  click('[data-original]');
  expect($('#lg-original-frame')).not.toBeNull();
  expect(location.search).toContain('original=1');
});
it('filters before select-visible, preserves selection and makes edits visible across layouts', () => {
  click('[data-page=characters]');
  input('[data-search]', 'Радовика');
  click('[data-select-all]');
  expect($('.lg-selection').textContent).toContain('1');
  input('[data-search]', '');
  click('[data-variant="2"]');
  expect($('.lg-selection').textContent).toContain('1');
  click('[data-open=c3]');
  click('[data-edit-entry=c3]');
  input('[name=title]', 'Новый ник');
  submit();
  expect($('#lg-content').textContent).toContain('Новый ник');
  click('[data-variant="1"]');
  expect($('#lg-content').textContent).toContain('Новый ник');
  expect(localStorage.getItem('production-sentinel')).toBe('unchanged');
});
it('requires explicit consent, multiplies real sets, and stops a simulated run without losing its result', () => {
  click('[data-page=tools]');
  click('[data-open=transfer]');
  expect($('[data-execute]').disabled).toBe(true);
  input('[data-transfer-sets]', '20');
  expect($('[data-transfer-total]').textContent).toBe('500 предметов');
  click('[data-ack]');
  expect($('[data-execute]').disabled).toBe(false);
  click('[data-execute]');
  expect($('.lg-running-bar')).not.toBeNull();
  click('[data-stop]');
  expect($('.lg-running-bar')).toBeNull();
  click('[data-variant="8"]');
  expect($('#lg-content').textContent).toContain('Передать наборы');
});
it('launches only checked members and can rename and close a single fictional window', () => {
  click('[data-page=parties]');
  click('[data-variant="1"]');
  click('[data-feature="Закрытие всех окон"]');
  click('[data-close-all-windows]');
  expect(document.querySelectorAll('[data-close-window]')).toHaveLength(0);
  click('[data-open=p1]');
  document.querySelectorAll('[name=launch]').forEach(e => (e.checked = e.value === 'c2'));
  click('[data-confirm-launch=p1]');
  expect(document.querySelectorAll('[data-close-window]')).toHaveLength(1);
  click('[data-rename-window=window-c2]');
  input('[name=title]', 'Учебное окно');
  submit();
  expect($('.lg-window-list').textContent).toContain('Учебное окно');
  click('[data-close-window=window-c2]');
  expect(document.querySelectorAll('[data-close-window]')).toHaveLength(0);
});
it('creates a visible marathon draft rather than claiming an actual website operation', () => {
  click('[data-page=marathons]');
  click('[data-primary]');
  input('[name=title]', 'Мой учебный марафон');
  submit();
  expect($('#lg-content').textContent).toContain('Мой учебный марафон');
  expect($('#lg-content').textContent).toContain('Черновик');
});
it('never enables a real connection and presents independent cloud cards with review-before-apply', () => {
  click('[data-page=settings]');
  click('[data-open=cloud]');
  expect(document.querySelectorAll('.lg-cloud-grid>.lg-panel')).toHaveLength(2);
  expect($('#lab-dialog').textContent).toContain('Не подключён');
  click('[data-feature="Проверка различий до применения"]');
  expect($('#lab-dialog').textContent).toContain('Удаление');
  expect($('[data-execute]').disabled).toBe(true);
});
it('retains distinct marks by selected day and hides conditional blocks', () => {
  click('[data-page=today]');
  click('[data-variant="8"]');
  click('[data-day-task=dungeon]');
  click('[data-day="1"]');
  expect($('[data-day-task=dungeon]').checked).toBe(false);
  click('[data-day="0"]');
  expect($('[data-day-task=dungeon]').checked).toBe(true);
  click('[data-scenario=clan]');
  expect($('[data-entry=clan]')).toBeNull();
});
it('empty target lists never become all accounts in dry-run or confirmed actions', () => {
  click('[data-page=tools]');
  click('[data-variant="1"]');
  click('[data-open=transfer]');
  document.querySelectorAll('[name=target]').forEach(e => (e.checked = false));
  click('[data-dry]');
  expect($('.lg-running-bar')).toBeNull();
  click('[data-ack]');
  click('[data-execute]');
  expect($('.lg-running-bar')).toBeNull();
  expect($('#lab-dialog').open).toBe(true);
});
it('calendar month and date selection share the task date and allow a local event', () => {
  click('[data-page=today]');
  click('[data-variant="8"]');
  const date = $('.lg-month [data-date]').dataset.date;
  click('.lg-month [data-date]');
  expect($('[data-date][aria-pressed=true]').dataset.date).toBe(date);
  click('[data-month="1"]');
  expect($('.lg-month').open).toBe(true);
  click('[data-entry=calendar] [data-feature="Календарь событий"]');
  input('[name=title]', 'Собрать пати на вечер');
  submit();
  expect($('#lg-content').textContent).toContain('Собрать пати на вечер');
});

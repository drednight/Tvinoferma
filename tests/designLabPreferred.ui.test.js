import { beforeAll, beforeEach, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const $ = s => document.querySelector(s);
const click = s => {
  expect($(s), s).not.toBeNull();
  $(s).click();
};
beforeAll(async () => {
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync('demo2/index.html', 'utf8'),
    'text/html'
  ).body.innerHTML;
  document.body.dataset.lab = 'next';
  history.replaceState(null, '', '/?page=roster&variant=7');
  $('#lab-dialog').showModal = function () {
    this.setAttribute('open', '');
  };
  $('#lab-dialog').close = function () {
    this.removeAttribute('open');
  };
  await import('../demo/design-lab/app.js');
});
beforeEach(() => click('[data-reset]'));
it('shows five follow-ups and excludes archive from login, game launch and operation targets', () => {
  expect(document.querySelectorAll('[data-variant]')).toHaveLength(11);
  click('[data-page=roster]');
  click('[data-toggle-archive]');
  expect($('.lg-preferred-detail').textContent).toContain('Пока персонаж в архиве');
  expect($('[data-site-login]')).toBeNull();
  expect($('[data-game-launch]')).toBeNull();
  click('[data-page=automation]');
  expect(document.querySelector('[name=target][value=archived-demo]')).toBeNull();
});
it('keeps edited party selected and offers window class icons independently of names', () => {
  click('[data-page=launch]');
  const form = $('[data-party-editor]');
  const id = form.dataset.partyEditor;
  form.querySelector('[name=name]').value = 'Новая пати';
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect($('.lg-preferred-detail h2').textContent).toBe('Новая пати');
  expect($('[data-party-editor]').dataset.partyEditor).toBe(id);
  const input = $('[data-window-icon]');
  expect(input.options).toHaveLength(18);
  input.value = 'bard';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  expect($('[data-window-icon]').value).toBe('bard');
});
it('runs a dry operation inline without acknowledgement; real simulation requires it', () => {
  click('[data-page=automation]');
  click('[data-detail=transfer]');
  const form = $('[data-operation-editor]');
  form.querySelector('[name=target]').checked = true;
  const execute = $('button[value=run]');
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: execute }));
  expect($('.lg-running-bar')).toBeNull();
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: $('button[value=dry]') }));
  expect($('.lg-running-bar')).not.toBeNull();
  expect($('#lab-dialog').open).toBe(false);
  click('[data-stop]');
});
it('retains expandable original marathon controls beside the split view', () => {
  click('[data-page=events]');
  expect($('[data-marathon-original]')).not.toBeNull();
  expect($('[data-marathon-original]').getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals');
  expect(document.querySelectorAll('.lg-preferred-detail details').length).toBeGreaterThan(1);
});

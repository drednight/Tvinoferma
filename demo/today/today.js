// Макеты и копии разделов работают только с примером данных; доступ к сайту и Tauri закрыт.
import { escapeHtml as esc } from '../../js/core/utils.js';
import { VARIANTS, applyAppSnapshot, createDemoState, partyInfo } from './data.js';
import { icon, renderVariant } from './render.js';

let state = createDemoState();
let currentPage = 'today';
let replicaReady = false;
const pages = {
  today: { title: 'Сегодня', replica: 'today' },
  characters: { title: 'Персонажи', replica: 'characters' },
  parties: { title: 'Пати', replica: 'parties' },
  marathons: { title: 'Марафоны', replica: 'marathons' },
  runes: { title: 'Руны', replica: 'runes' },
  bank: { title: 'Банк', replica: 'finance' },
  tools: { title: 'Инструменты', replica: 'tools' },
  settings: { title: 'Настройки', replica: 'settings' }
};
const screen = document.querySelector('#today-screen');
const panel = document.querySelector('#today-panel');
const frame = document.querySelector('#replica-frame');
const title = document.querySelector('#demo-page-title');
const variantButtons = [...document.querySelectorAll('[data-variant]')];
const navigation = [...document.querySelectorAll('[data-nav-section]')];
const clanToggle = document.querySelector('#clan-toggle');
const pollToggle = document.querySelector('#poll-toggle');
const marathonToggle = document.querySelector('#marathon-toggle');
const dialog = document.querySelector('#demo-dialog');
const dialogContent = document.querySelector('#dialog-content');
const toast = document.querySelector('#demo-toast');
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3500);
}

function postReplica(message) {
  // У sandboxed iframe непрозрачный origin. Адресуем его только через сохранённый WindowProxy;
  // входящие ответы дополнительно проверяем по source и origin === 'null'.
  if (replicaReady) frame.contentWindow?.postMessage(message, '*');
}

function sendScenarios() {
  postReplica({
    type: 'tf-demo:scenarios',
    clanEnabled: state.clanEnabled,
    pollEnabled: state.pollEnabled,
    marathonActive: state.marathonActive,
    poll: state.poll,
    clanResponses: state.clanResponses
  });
}

function focusSelector() {
  const focused = document.activeElement;
  if (!screen.contains(focused)) return '';
  const safe = value => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
  if (focused.matches('[data-party-select]')) return '[data-party-select]';
  if (focused.matches('[data-task]')) return `[data-task="${safe(focused.dataset.task)}"]`;
  if (focused.matches('[data-day]')) return `[data-day="${safe(focused.dataset.day)}"]`;
  if (focused.matches('[data-clan-event]'))
    return `[data-clan-event="${safe(focused.dataset.clanEvent)}"][data-response="${safe(focused.dataset.response)}"]`;
  if (focused.matches('[data-guild-poll] input')) return `[data-guild-poll] input[value="${safe(focused.value)}"]`;
  if (focused.matches('[data-guild-poll] button')) return '[data-guild-poll] button';
  return '';
}

function render(focus = '') {
  if (state.variant !== 'original') screen.innerHTML = renderVariant(state);
  panel.setAttribute('aria-labelledby', `tab-${state.variant}`);
  variantButtons.forEach(button => {
    const active = button.dataset.variant === state.variant;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  navigation.forEach(button => {
    const active = button.dataset.navSection === currentPage;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  title.textContent = pages[currentPage].title;
  const showingReplica = currentPage !== 'today' || state.variant === 'original';
  screen.hidden = showingReplica;
  frame.hidden = !showingReplica;
  if (currentPage === 'today') panel.setAttribute('role', 'tabpanel');
  else panel.removeAttribute('role');
  clanToggle.checked = state.clanEnabled;
  pollToggle.checked = state.pollEnabled;
  pollToggle.disabled = !state.clanEnabled;
  marathonToggle.checked = state.marathonActive;
  if (focus && !showingReplica) screen.querySelector(focus)?.focus();
}

function navigate(page, send = true) {
  if (!pages[page]) return;
  currentPage = page;
  render();
  if (send && (page !== 'today' || state.variant === 'original')) {
    postReplica({ type: 'tf-demo:navigate', section: pages[page].replica });
  }
}

function chooseVariant(id) {
  if (!VARIANTS.some(variant => variant.id === id)) return;
  state.variant = id;
  navigate('today');
}

variantButtons.forEach((button, index) => {
  button.addEventListener('click', () => chooseVariant(button.dataset.variant));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? variantButtons.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + variantButtons.length) % variantButtons.length;
    variantButtons[next].focus();
    chooseVariant(variantButtons[next].dataset.variant);
  });
});

clanToggle.addEventListener('change', () => {
  state.clanEnabled = clanToggle.checked;
  render();
  sendScenarios();
});
pollToggle.addEventListener('change', () => {
  state.pollEnabled = pollToggle.checked;
  render();
  sendScenarios();
});
marathonToggle.addEventListener('change', () => {
  state.marathonActive = marathonToggle.checked;
  if (state.marathonActive && !state.marathon) state.marathon = { title: 'Путь героя', days: 7, percent: 0 };
  render();
  sendScenarios();
});
document.querySelector('#reset-demo').addEventListener('click', () => {
  const variant = state.variant;
  if (replicaReady) postReplica({ type: 'tf-demo:reset' });
  replicaReady = false;
  state = createDemoState();
  state.variant = variant;
  currentPage = 'today';
  render();
  showToast('Пример сброшен. Данные приложения не изменялись.');
});

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== 'null' || !event.data) return;
  if (event.data.type === 'tf-demo:ready') {
    replicaReady = true;
    sendScenarios();
    if (currentPage !== 'today' || state.variant === 'original')
      postReplica({ type: 'tf-demo:navigate', section: pages[currentPage].replica });
  } else if (event.data.type === 'tf-demo:snapshot' && replicaReady) {
    const focus = focusSelector();
    const pollBefore = JSON.stringify(state.poll);
    const unsentChoices =
      !screen.hidden && screen.querySelector('[data-guild-poll]')
        ? [...screen.querySelectorAll('[data-guild-poll] input:checked')].map(input => input.value)
        : null;
    if (applyAppSnapshot(state, event.data.snapshot)) {
      render(focus);
      // Периодическая сводка не должна стирать ещё не отправленный выбор в опросе.
      if (unsentChoices && pollBefore === JSON.stringify(state.poll)) {
        screen.querySelectorAll('[data-guild-poll] input').forEach(input => {
          input.checked = unsentChoices.includes(input.value);
        });
      }
    }
  } else if (event.data.type === 'tf-demo:notice') {
    showToast(event.data.message);
  } else if (event.data.type === 'tf-demo:navigated') {
    const page = Object.keys(pages).find(key => pages[key].replica === event.data.section);
    if (!page) return;
    if (page === 'today') state.variant = 'original';
    navigate(page, false);
  }
});

function dialogFrame(titleText, subtitle, body, footer = '') {
  return `<div class="t-dialog-head"><div><h2 id="dialog-title">${esc(titleText)}</h2><p>${esc(subtitle)}</p></div><button type="button" class="t-icon-btn" data-close-dialog aria-label="Закрыть">${icon('close')}</button></div>
    <div class="t-dialog-body">${body}</div><div class="t-dialog-foot">${footer || '<button type="button" class="t-btn t-btn-quiet" data-close-dialog>Закрыть</button>'}</div>`;
}

function authText(auth) {
  return auth === 'online' ? 'Вход подтверждён' : auth === 'checking' ? 'Проверка' : 'Нужен вход';
}

function launchDialog() {
  const party = partyInfo(state.favoriteParty, state);
  if (!party.id) return;
  const rows = party.members
    .map(
      c =>
        `<li><span><span class="t-dot ${c.auth === 'online' ? 'green' : c.auth === 'checking' ? 'amber' : 'red'}"></span><span><strong>${esc(c.nick)}</strong><br/><small>${esc(c.className)} · ${authText(c.auth)}</small></span></span></li>`
    )
    .join('');
  dialogContent.innerHTML = dialogFrame(
    `Запуск: ${party.label}`,
    'Это демонстрация, окна игры не запускаются.',
    `<p>В примере выбрано <b>${party.members.length} участника</b>. Цвета показывают вход на сайт, а не состояние окна игры.</p><ul class="t-dialog-list">${rows}</ul><div class="t-dialog-note">После подтверждения изменится только надпись в этом макете.</div>`,
    `<button type="button" class="t-btn t-btn-quiet" data-close-dialog>Отмена</button><button type="button" class="t-btn t-btn-primary" data-confirm-launch>${icon('play')} Имитировать запуск</button>`
  );
  if (!dialog.open) dialog.showModal();
}

function openSection(section) {
  if (section === 'calendar') {
    chooseVariant('original');
    return;
  }
  if (section === 'coins') {
    navigate('characters');
    return;
  }
  if (pages[section]) {
    navigate(section);
    return;
  }
  if (section === 'launch') {
    launchDialog();
    return;
  }
  if (section === 'refresh' || section === 'clan-refresh') {
    showToast('Обновление имитируется: запросы на сайт не отправляются.');
    return;
  }
  if (section === 'clan-copy') {
    showToast('Пример копирования ников — буфер обмена не изменялся.');
    return;
  }
  if (section === 'clan-site') {
    dialogContent.innerHTML = dialogFrame(
      'Сайт клана',
      'Безопасная демонстрация',
      '<p>В настоящем приложении здесь открывается сайт клана.</p><p>В демо переход на настоящий сайт не выполняется.</p>'
    );
    if (!dialog.open) dialog.showModal();
  }
}

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-nav-section]');
  if (nav) {
    navigate(nav.dataset.navSection);
    return;
  }
  const open = event.target.closest('[data-open-section]');
  if (open) {
    openSection(open.dataset.openSection);
    return;
  }
  const response = event.target.closest('[data-clan-event]');
  if (response) {
    const { clanEvent, response: value } = response.dataset;
    state.clanResponses[clanEvent] = value;
    render(`[data-clan-event="${clanEvent}"][data-response="${value}"]`);
    sendScenarios();
    showToast('Ответ отмечен в примере; на сайт ничего не отправлено.');
    return;
  }
  const day = event.target.closest('[data-day]');
  if (day) {
    state.chosenDay = Number(day.dataset.day);
    render(`[data-day="${state.chosenDay}"]`);
    return;
  }
  if (event.target.closest('[data-close-dialog]')) {
    dialog.close();
    return;
  }
  if (event.target.closest('[data-confirm-launch]')) {
    state.lastLaunch = state.favoriteParty;
    dialog.close();
    render();
    showToast('Имитация завершена: окна игры не запускались.');
  }
});

dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
});
screen.addEventListener('change', event => {
  const target = event.target;
  if (target.matches('[data-party-select]')) {
    if (!state.parties.some(party => party.id === target.value)) return;
    state.favoriteParty = target.value;
    render('[data-party-select]');
  } else if (target.matches('[data-task]')) {
    state.tasks[target.dataset.task] = target.checked;
    render(`[data-task="${target.dataset.task}"]`);
  }
});

screen.addEventListener('submit', event => {
  const form = event.target.closest('[data-guild-poll]');
  if (!form) return;
  event.preventDefault();
  const selected = [...form.querySelectorAll('input:checked')].map(input => input.value);
  if (!selected.length) {
    showToast('Выберите вариант ответа в примере.');
    return;
  }
  state.poll.options.forEach(option => {
    option.selected = selected.includes(option.id);
  });
  render('[data-guild-poll] button[type="submit"]');
  sendScenarios();
  showToast('Демо-голос сохранён на этой странице; на сайт он не отправлен.');
});

render();

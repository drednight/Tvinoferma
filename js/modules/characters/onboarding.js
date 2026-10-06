// js/modules/characters/onboarding.js
// Приветственное окно первых шагов, когда данных ещё нет (Issue #45).
//
// Пустой список персонажей ничего не объясняет: непонятно, с чего начинать и что делать дальше.
// Здесь три шага **карточками в ряд** и кнопка в каждой. Окно показывается один раз —
// когда персонажей нет и пользователь его ещё не закрывал; дальше его можно открыть кнопкой.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';

/** Ключ в настройках: показывалось ли приветствие. */
const SEEN_KEY = 'onboardingSeen';

/**
 * Показывать ли приветствие: только на пустых данных и только один раз.
 */
export function shouldShowOnboarding(appState = state) {
  if ((appState.characters || []).length > 0) return false;
  return appState.settings?.ui?.[SEEN_KEY] !== true;
}

/** Шаги первых действий: что делать и почему именно так. */
export const ONBOARDING_STEPS = [
  {
    icon: '👤',
    title: 'Добавьте персонажа',
    text: 'Ник, класс и уровень. Пароли и почты хранятся в защищённом хранилище учётных данных ОС, а не в файле данных.',
    action: 'new-character',
    button: 'Добавить персонажа'
  },
  {
    icon: '🛡',
    title: 'Соберите пати',
    text: 'Пати — это группы аккаунтов. Из карточки пати игру можно запустить одной кнопкой, а порядок запуска задать перетаскиванием.',
    action: 'new-party',
    button: 'Создать пати'
  },
  {
    icon: '🌐',
    title: 'Войдите на сайт игры',
    text: 'Кнопка «Открыть сайт» в карточке персонажа открывает браузер с уже подставленным входом. После входа приложение запомнит сессию.',
    action: 'open-help',
    button: 'Как это работает'
  }
];

/** Вводный текст окна: что это за приложение и что оно делает. */
export const ONBOARDING_INTRO = 'Это кабинет для нескольких аккаунтов Perfect World: вход на сайт, баланс монет, '
  + 'марафоны и запуск игры. Начните с трёх шагов ниже — они займут пару минут.';

/** Разметка приветственного окна: те же шаги, но карточками в ряд. */
export function onboardingModalHtml() {
  return `
    <div class="onb onb-modal">
      <div class="onb-head">
        <h3>С чего начать</h3>
        <p class="muted">${escapeHtml(ONBOARDING_INTRO)}</p>
      </div>
      <ol class="onb-cards">
        ${ONBOARDING_STEPS.map((s, i) => `
          <li class="onb-card">
            <span class="onb-card-top">
              <span class="onb-num">${i + 1}</span>
              <span class="onb-ico" aria-hidden="true">${s.icon}</span>
            </span>
            <b>${escapeHtml(s.title)}</b>
            <p class="muted">${escapeHtml(s.text)}</p>
            <button type="button" class="btn secondary small" data-onb="${escapeHtml(s.action)}">${escapeHtml(s.button)}</button>
          </li>`).join('')}
      </ol>
      <p class="muted onb-note">Данные хранятся только на этом компьютере. Приложение читает страницы сайта,
        но ничего не нажимает за вас. Это окно можно открыть снова — кнопка «С чего начать» в разделе «Персонажи».</p>
    </div>`;
}

/**
 * Разметка подсказки на странице. Возвращает пустую строку, если персонажи уже есть.
 * @param {any} [appState]
 */
export function onboardingHtml(appState = state) {
  if ((appState.characters || []).length > 0) return '';
  return `
    <div class="onb">
      <div class="onb-head">
        <h3>С чего начать</h3>
        <p class="muted">Три шага, чтобы приложение стало полезным. Подсказка исчезнет, как только появится первый персонаж.</p>
      </div>
      <ol class="onb-steps">
        ${ONBOARDING_STEPS.map((s, i) => `
          <li class="onb-step">
            <span class="onb-num">${i + 1}</span>
            <span class="onb-ico" aria-hidden="true">${s.icon}</span>
            <div class="onb-body">
              <b>${escapeHtml(s.title)}</b>
              <p class="muted">${escapeHtml(s.text)}</p>
            </div>
            <button type="button" class="btn secondary small" data-onb="${escapeHtml(s.action)}">${escapeHtml(s.button)}</button>
          </li>`).join('')}
      </ol>
      <p class="muted onb-note">Данные хранятся только на этом компьютере. Приложение читает страницы сайта, но ничего не нажимает за вас.</p>
    </div>`;
}

/** Отметить приветствие показанным: само оно больше не откроется. */
export async function markOnboardingSeen(appState = state) {
  if (appState.settings?.ui?.[SEEN_KEY] === true) return;
  if (!appState.settings.ui) appState.settings.ui = {};
  appState.settings.ui[SEEN_KEY] = true;
  await persist();
}

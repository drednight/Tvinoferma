// js/modules/characters/onboarding.js
// Подсказка первых шагов, когда данных ещё нет (Issue #45).
//
// Пустой список персонажей ничего не объясняет: непонятно, с чего начинать и что делать дальше.
// Здесь три шага с кнопками, которые ведут прямо к нужному действию. Подсказка исчезает,
// как только появляется первый персонаж, поэтому опытным пользователям она не мешает.

import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/utils.js';

/**
 * Нужно ли показывать подсказку: только на пустых данных.
 * Пати и марафоны без персонажей смысла не имеют, поэтому смотрим именно на персонажей.
 */
export function shouldShowOnboarding(appState = state) {
  return (appState.characters || []).length === 0;
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

/**
 * Разметка подсказки. Возвращает пустую строку, если показывать нечего.
 * @param {any} [appState]
 */
export function onboardingHtml(appState = state) {
  if (!shouldShowOnboarding(appState)) return '';
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

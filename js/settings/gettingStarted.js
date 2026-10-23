// js/settings/gettingStarted.js
// Базовый гайд по приложению: короткий мастер, который ведёт по разделам и показывает,
// что где лежит. Шаги проходятся по порядку, шаг назад и переход к любому пройденному шагу —
// по клику на степпере.
//
// Чем это отличается от того, что уже есть:
// - справочник (`guideData.js` + `guides.js`) — каталог инструкций «как сделать задачу»;
//   гайд — обзор «что где находится», который проходят один раз от начала до конца;
// - приветствие «С чего начать» (`modules/characters/onboarding.js`) — про первые три шага
//   на пустых данных; гайд доступен всегда, в том числе когда персонажи уже есть.
//
// Гайд показывается один раз при первом запуске (после приветствия, чтобы окна не легли
// друг на друга) и открывается вручную из двух мест: кнопка в шапке приложения и
// «Настройки → Справка». Чекбокс «не показывать снова» снимает автоматический показ —
// ручной вход работает в любом случае.

import { state } from '../core/state.js';
import { persist } from '../core/storage.js';
import { escapeHtml } from '../core/utils.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import { toast } from '../core/ui.js';
import { GUIDES } from './guideData.js';
import { revealGuide } from './guides.js';

/** Ключ в настройках: проходили ли гайд (и не снял ли его пользователь). */
const SEEN_KEY = 'guideSeen';

/** Через сколько после запуска показать гайд: приветствие «С чего начать» открывается сразу. */
const AUTO_SHOW_DELAY_MS = 20000;

const guideById = new Map(GUIDES.map(guide => [guide.id, guide]));

/**
 * Шаги гайда.
 *
 * `tab` — раздел, который открывает кнопка шага; `guides` — инструкции справочника, которые
 * объясняют задачи этого раздела подробнее; `screen` — снимок интерфейса из public/assets/guides.
 */
export const GUIDE_STEPS = [
  {
    id: 'about',
    title: 'Что это такое',
    text: 'Твиноферма держит несколько аккаунтов Perfect World в одном окне: карточки персонажей, вход на сайт, баланс монет, задания марафонов и запуск игры. Все данные хранятся только на этом компьютере.',
    hint: 'Дальше — короткий обзор разделов. На любом шаге можно вернуться назад.',
    guides: ['navigation']
  },
  {
    id: 'characters',
    title: 'Персонажи',
    tab: 'characters',
    text: 'Карточка персонажа показывает ник, класс, уровень, статус входа, пати, монеты и контакты. Клик по карточке открывает профиль: слева контакты, запуск игры и заметки, справа — характеристики плитками, проходки и история их изменений. Под каждым числом в профиле может быть подсказка «было → стало».',
    hint: 'В фильтрах сверху ищут по нику, классу, пати, статусу и тегам. Тег в профиле открывает список персонажей с этим тегом.',
    guides: ['first-character', 'character-edit', 'character-stats'],
    screen: {
      src: '/assets/guides/characters.webp',
      alt: 'Карточки персонажей, фильтры и кнопка «+»',
      notes: [
        'Слева фильтры: по нику, классу, пати и статусу',
        'На карточке — ник, класс, уровень, вход, монеты и теги',
        'Кнопка «+» внизу справа создаёт персонажа'
      ]
    }
  },
  {
    id: 'profile',
    title: 'Профиль и характеристики',
    tab: 'characters',
    text: 'Профиль открывается кликом по карточке. Слева — контактные данные (глаз показывает и скрывает их, кнопка «Показать все» действует сразу), настройка GameCenter и заметки. Справа — характеристики плитками: у каждой подпись сверху, значение снизу, а рядом разница с прошлым значением (+ зелёным, − красным).',
    hint: 'В редакторе под каждым полем видно прошлое значение и разницу с ним — она пересчитывается при вводе. Значения можно заполнить из скриншота окна характеристик.',
    guides: ['character-stats', 'character-edit'],
    screen: {
      src: '/assets/guides/character-profile.webp',
      alt: 'Профиль персонажа: контакты, характеристики, проходки',
      notes: [
        'Контакты и «Запуск игры» — слева, характеристики и проходки — справа',
        'У характеристик подпись сверху, значение снизу и разница с прошлым',
        '«Проходки» и «Последние изменения» — под примечаниями слева'
      ]
    }
  },
  {
    id: 'parties',
    title: 'Пати и запуск игры',
    tab: 'parties',
    text: 'Пати — это группы аккаунтов: из карточки пати игра запускается одной кнопкой, а порядок запуска задаётся перетаскиванием. Чтобы кнопка «Запуск» работала, персонажам привязывают GameCenter — это делается в настройках запуска игры.',
    guides: ['party-create', 'gamecenter', 'party-launch'],
    screen: {
      src: '/assets/guides/parties.webp',
      alt: 'Список пати и кнопка запуска окон игры',
      notes: [
        'Слева пати, в каждой — состав и кнопка запуска',
        'Привязка GameCenter к персонажам — «Настройки → Приложение»'
      ]
    }
  },
  {
    id: 'today',
    title: 'Сегодня и календарь',
    tab: 'today',
    text: '«Сегодня» — дела дня со статусами «ожидает / в работе / выполнено» и общая сводка. В календаре записи рисуются на шкале времени, повтор задаётся выбором дней, постоянные игровые ивенты показываются отдельной полосой.',
    guides: ['calendar-read', 'calendar-entry'],
    screen: {
      src: '/assets/guides/today.webp',
      alt: 'Вкладка «Сегодня» и календарь записей',
      notes: [
        'Слева календарь на неделю, справа — дела на сегодня',
        'Полоса внизу календаря — постоянные ивенты',
        'Часы по Москве и статус серверов — в левой панели'
      ]
    }
  },
  {
    id: 'marathons',
    title: 'Марафоны',
    tab: 'marathons',
    text: 'Марафон — это набор заданий на срок. Приложение считает запас дней и предупреждает, когда персонаж не успевает. Список разбит по состояниям: идут, ждут завершения, завершённые и будущие. Внутри марафона — таблица «персонажи × задания», где видно, кто не успевает и сколько монет заработано.',
    hint: 'Папка группирует марафоны сезона: она шире обычной карточки, внутри видно прогресс каждого.',
    guides: ['marathon-manual', 'marathon-progress', 'marathon-finish'],
    screen: {
      src: '/assets/guides/marathons.webp',
      alt: 'Список марафонов: карточки с прогрессом и монетами',
      notes: [
        'Сверху — сводка: сколько марафонов в каждом состоянии и сколько заработано',
        'На карточке: даты, подсказка, полоса прогресса и плитки с числами',
        'Папки шире карточек марафонов — в них список сезона'
      ]
    }
  },
  {
    id: 'tools',
    title: 'Скрипты и окна игры',
    tab: 'tools',
    text: '«Инструменты» — вход на сайт, балансы, промокоды, передача и подарки, список запущенных окон игры и состояние парсеров. Каждый скрипт показывает, что именно сделает, а ход работы виден в журнале.',
    guides: ['promo', 'transfer', 'logs'],
    screen: {
      src: '/assets/guides/scripts.webp',
      alt: 'Подменю скриптов сайта',
      notes: [
        'Скрипты идут сеткой: до четырёх в ряд на широком окне',
        'У каждого — название, что он делает и кнопка запуска'
      ]
    }
  },
  {
    id: 'settings',
    title: 'Настройки и данные',
    tab: 'settings',
    text: 'В настройках слева список разделов, справа — открытый раздел целиком: Приложение, Синхронизация, Обновления, Данные и безопасность, Справка и Опасные действия. Здесь же резервные копии, экспорт и перенос на другой компьютер, уведомления (всплывающие окна и звук), запуск игры и оформление.',
    hint: 'В уведомлениях можно выбрать набор звука и нажать «Послушать» — так сразу понятно, какой слышно поверх игры.',
    guides: ['backups', 'notifications', 'move-computer'],
    screen: {
      src: '/assets/guides/settings-app.webp',
      alt: 'Настройки приложения',
      notes: [
        'Слева — шесть разделов, открыт ровно один',
        'Справа — панели открытого раздела со свёрнутыми блоками',
        'Горячие клавиши лежат внутри «Помощь по приложению»'
      ]
    }
  },
  {
    id: 'done',
    title: 'Готово',
    text: 'Это весь обзор. Дальше — по задачам: в «Настройки → Справка» есть инструкция почти на каждое действие, от первого персонажа до переноса данных на другой компьютер. Открыть её можно в любой момент кнопкой «❔ Как всё работает» в шапке.',
    guides: []
  }
];

/** Показывать ли гайд при запуске: только когда его ещё не проходили. */
export function shouldShowGuide(appState = state) {
  return appState.settings?.ui?.[SEEN_KEY] !== true;
}

/** Запомнить, что гайд пройден (или снят галочкой). Повторный вызов ничего не пишет. */
export async function markGuideSeen(appState = state, seen = true) {
  if (appState.settings?.ui?.[SEEN_KEY] === seen) return; // значение и такое
  if (!appState.settings.ui) appState.settings.ui = {};
  appState.settings.ui[SEEN_KEY] = seen;
  await persist();
}

function stepHtml(step, index, total) {
  const guides = (step.guides || [])
    .filter(id => guideById.has(id))
    .map(
      id =>
        `<button type="button" class="btn ghost small" data-gs-guide="${escapeHtml(id)}">📖 ${escapeHtml(guideById.get(id).title)}</button>`
    )
    .join('');
  // Шаг разложен в две колонки: слева слова, справа снимок с пояснением «на что смотреть».
  // Раньше текст и снимок шли друг под другом, и на широком окне картинка занимала
  // половину высоты окна, хотя её нужно было только глянуть.
  const notes = (step.screen?.notes || []).map(note => `<li>${escapeHtml(note)}</li>`).join('');
  return `
    <article class="gs-step">
      <div class="gs-cols">
        <div class="gs-col">
          <header class="gs-head">
            <span class="gs-counter">Шаг ${index + 1} из ${total}</span>
            <h3>${escapeHtml(step.title)}</h3>
          </header>
          <p class="gs-text">${escapeHtml(step.text)}</p>
          ${step.hint ? `<p class="gs-hint">${escapeHtml(step.hint)}</p>` : ''}
          ${step.tab ? `<div class="row gap gs-go"><button type="button" class="btn secondary" data-gs-tab="${escapeHtml(step.tab)}">Открыть «${escapeHtml(step.title)}»</button></div>` : ''}
        </div>
        ${
          step.screen
            ? `<figure class="gs-screen">
          <img src="${escapeHtml(step.screen.src)}" alt="${escapeHtml(step.screen.alt)}" loading="lazy" decoding="async" />
          ${notes ? `<ul class="gs-notes">${notes}</ul>` : ''}
          <figcaption>${escapeHtml(step.screen.alt)}. Снимок на вымышленных данных.</figcaption>
        </figure>`
            : ''
        }
      </div>
      ${guides ? `<footer class="gs-more"><span class="muted">Подробнее в справочнике:</span><div class="row gap">${guides}</div></footer>` : ''}
    </article>`;
}

/**
 * Открыть гайд с нужного шага.
 * @param {{ startAt?: number }} [opts]
 */
export function openGettingStarted({ startAt = 0 } = {}) {
  let current = Math.min(Math.max(startAt, 0), GUIDE_STEPS.length - 1);
  const ov = openOverlay({ title: 'Как работает Твиноферма', wide: true });

  const render = () => {
    const step = GUIDE_STEPS[current];
    ov.sub.innerHTML = `<div class="tf-stepper gs-stepper" role="tablist" aria-label="Шаги гайда">
      ${GUIDE_STEPS.map(
        (item, i) => `
        <div class="tf-step${i === current ? ' is-current' : ''}${i < current ? ' is-done' : ''}" data-gs-step="${i}"${i === current ? ' aria-current="step"' : ''} role="tab" aria-selected="${i === current}">
          <span class="tf-step-num">${i < current ? '✓' : i + 1}</span>${escapeHtml(item.title)}
        </div>`
      ).join('<span class="tf-step-line"></span>')}
    </div>`;
    // Пройденные шаги кликабельны: вернуться назад можно и кнопкой, и сразу на нужный шаг
    ov.sub.querySelectorAll('[data-gs-step]').forEach(el => {
      el.onclick = () => {
        current = Number(el.dataset.gsStep);
        render();
      };
    });

    ov.body.innerHTML = stepHtml(step, current, GUIDE_STEPS.length);
    // Кнопка «Открыть раздел» ведёт в этот раздел: гайд закрывается, чтобы не мешал смотреть
    const goBtn = ov.body.querySelector('[data-gs-tab]');
    if (goBtn) {
      goBtn.addEventListener('click', () => {
        document.querySelector(`.tab[data-tab="${goBtn.dataset.gsTab}"]`)?.click();
        ov.close();
      });
      goBtn.focus();
    }

    ov.body.querySelectorAll('[data-gs-guide]').forEach(el => {
      el.onclick = () => {
        // Справочник: статья открывается в настройках, гайд при этом закрывается
        if (revealGuide(el.dataset.gsGuide)) ov.close();
      };
    });

    const last = current === GUIDE_STEPS.length - 1;
    ov.foot.innerHTML = `
      <label class="gs-dont-show"><input type="checkbox" data-gs-dont-show${shouldShowGuide() ? '' : ' checked'} /> Больше не показывать при запуске</label>
      <div class="row gap">
        ${current > 0 ? '<button type="button" class="btn ghost" data-gs-back>← Назад</button>' : ''}
        ${
          last
            ? '<button type="button" class="btn primary" data-gs-done>Готово</button>'
            : '<button type="button" class="btn primary" data-gs-next>Далее →</button>'
        }
      </div>`;
    ov.foot.querySelector('[data-gs-back]')?.addEventListener('click', () => {
      current--;
      render();
    });
    ov.foot.querySelector('[data-gs-next]')?.addEventListener('click', () => {
      current++;
      render();
    });
    ov.foot.querySelector('[data-gs-done]')?.addEventListener('click', () => ov.close());
    ov.foot.querySelector('[data-gs-dont-show]')?.addEventListener('change', async e => {
      // Галочка пишется сразу: иначе закрытие окна крестиком отменило бы выбор
      await markGuideSeen(state, e.target.checked);
      toast(
        e.target.checked
          ? 'Гайд больше не будет открываться сам. Открыть его можно кнопкой в шапке.'
          : 'Гайд снова будет открываться при запуске.',
        'info'
      );
    });
  };

  render();
  return ov;
}

/**
 * Точка входа: кнопка «Как всё работает» в шапке приложения.
 *
 * В «Настройках → Справка» кнопки гайда больше нет: страница справки и мастер-обзор —
 * разные вещи, и вторая точка входа рядом с первой только путала.
 */
function bindEntries() {
  document.getElementById('guide-start-btn')?.addEventListener('click', () => openGettingStarted());
}

/**
 * Инициализация гайда: кнопки входа и один автоматический показ.
 * Вызывается из `js/main.js` при загрузке приложения.
 */
export function initGettingStarted() {
  bindEntries();
  if (!shouldShowGuide()) return;
  // Не сразу: при первом запуске сначала открывается приветствие «С чего начать»,
  // и два окна друг на друге только мешали бы
  setTimeout(() => {
    if (shouldShowGuide()) openGettingStarted();
  }, AUTO_SHOW_DELAY_MS);
}

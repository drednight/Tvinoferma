// Каталог примеров внешнего API: готовые сценарии «запрос → ответ → объяснение».
//
// Это единственный источник правды об примерах. Из него собираются:
//   - страница API, вкладка «Рецепты» (web/app.js рисует эти же данные);
//   - `docs/EXTERNAL-API-EXAMPLES.md` (скрипт scripts/build-external-api-examples.mjs);
//   - проверка синхронности (tests/externalApiRecipes.test.js).
//
// Почему каталог на JS, а не на JSON: страница отдаётся приложением как статические
// файлы, и каталог должен приехать вместе с ней одним запросом, без лишнего fetch.
//
// Формат рецепта:
//   {
//     id, group, title,            // что это и как называется
//     scenario,                    // когда это нужно: живая ситуация
//     method, path, template,      // запрос: метод, конкретный путь и его форма
//     scope,                       // право: read | modify | launchClose
//     body,                        // пример тела (null — тела нет)
//     response,                    // пример ответа (как приходит на самом деле)
//     explanation,                 // разбор ответа: что означают поля
//     errors: [{ status, code, why }]
//   }
//
// Правило: примеры настоящие. Путь и тело копируются в готовый запрос, ответ
// повторяет форму настоящего ответа API, а объяснение говорит, что делать дальше.
(() => {
  'use strict';

  /** Базовый адрес в примерах: тот же, что и в справочнике. */
  const BASE = 'http://127.0.0.1:47831';

  const groups = [
    { id: 'start', title: 'Начало работы' },
    { id: 'read', title: 'Чтение данных' },
    { id: 'write', title: 'Изменение данных' },
    { id: 'launch', title: 'Запуск и окна' },
    { id: 'export', title: 'Выгрузки' },
    { id: 'errors', title: 'Диагностика ошибок' }
  ];

  const recipes = [
    /* ------------------------------ начало работы ------------------------------ */
    {
      id: 'health',
      group: 'start',
      title: 'Проверить, что приложение живо',
      scenario:
        'Убедиться, что API отвечает, и заранее узнать текущие права: пока права «Изменение» выключены, любой PATCH вернёт 403.',
      method: 'GET',
      path: '/api/v1/health',
      template: '/api/v1/health',
      scope: 'read',
      body: null,
      response: {
        ok: true,
        app: { version: '3.0.0', build: 'stable' },
        api: { version: 1, uptimeSec: 128 },
        storage: { writable: true },
        scopes: { read: true, modify: true, launchClose: true },
        launch: { busy: false }
      },
      explanation:
        '`ok: true` — сервер на месте. `app.build` — профиль сборки (`stable`, `acceptance`, `acceptance-shared`): у тестовых сборок обновление выключено. `scopes` — текущие права: `modify` открывает PATCH/POST, `launchClose` — запуск и закрытие окон. `storage.writable: false` означает, что запись в базу заблокирована и изменения не сохранятся. `launch.busy: true` — уже идёт запуск, второй запрос получит 429.',
      errors: [
        { status: 401, code: 'unauthorized', why: 'Не передан заголовок `Authorization: Bearer <токен>` или токен перевыпущен в приложении.' }
      ]
    },
    {
      id: 'status',
      group: 'start',
      title: 'Узнать всё одним запросом',
      scenario:
        'Программа хочет понять, что приложение живо и что в нём происходит, не разбирая пять списков: сколько персонажей, что осталось на сегодня, сколько денег в реестре, открыто ли окно игры.',
      method: 'GET',
      path: '/api/v1/status',
      template: '/api/v1/status',
      scope: 'read',
      body: null,
      response: {
        ok: true,
        app: { version: '3.0.0', build: 'stable' },
        api: { version: 1, uptimeSec: 128 },
        storage: { writable: true },
        scopes: { read: true, modify: true, launchClose: true },
        launch: { busy: false },
        counts: { characters: 3, parties: 2, marathons: 1, plannerEntries: 12, windows: 1, financeOperations: 7 },
        today: { date: '2026-11-24', total: 4, done: 1 },
        finance: { balances: { gold: 125000, coins: 340 } }
      },
      explanation:
        '`counts` — размеры списков, `today` — дела на сегодня (`done` из `total`), `finance.balances` — текущий баланс реестра денег. Здесь нет ни контактов, ни паролей, ни содержимого заметок: сводка безопасна для показа в чужой программе. Если нужно больше — берите адресные методы (`/characters`, `/planner`, `/finance`).',
      errors: [{ status: 401, code: 'unauthorized', why: 'Нет токена или он перевыпущен.' }]
    },

    /* ------------------------------ чтение данных ------------------------------ */
    {
      id: 'characters',
      group: 'read',
      title: 'Кто есть в твин-ферме',
      scenario:
        'Своя программа хочет показать список персонажей: кто есть на ферме — и не утонуть в карточках, которых она не просила.',
      method: 'GET',
      path: '/api/v1/characters',
      template: '/api/v1/characters',
      scope: 'read',
      body: null,
      response: {
        characters: [
          { id: 'Mag_1', nick: 'Маг' },
          { id: 'Luchnik_2', nick: 'Лучник' }
        ],
        count: 2,
        fields: null,
        detail: 'brief',
        omitted: [
          'class',
          'level',
          'favorite',
          'sky',
          'partyIds',
          'mainPartyId',
          'stats',
          'dungeonPasses',
          'ancientCoins',
          'isLoggedIn',
          'lastLoginCheck',
          'updatedAt',
          'notes',
          'tags',
          'coinHistory',
          'createdAt',
          'running'
        ],
        detailHint:
          'detail=list — карточки без статов, detail=full — целиком; fields=id,nick,level — что нужно; /characters.stats — статы и проходки у всех'
      },
      explanation:
        'Список по умолчанию краткий: id и ник. Это ровно то, за чем в него идут, — опознать персонажа и сослаться на него; остальное спрашивают явно. `detail=list` отдаёт карточки, но без статов, заметок и истории монет, `detail=full` (он же прежний `?full=true`) — карточки целиком, `fields=id,nick,level,stats.hp` — только названные поля (вложенные через точку; `fields` перекрывает `detail`). О том, что список сокращён, сказано в самом ответе: `detail: "brief"`, `omitted` и `detailHint` — а не молчанием. `count` — сколько строк вернулось после фильтра, а не сколько всего. Ещё полезно: `party` (только одна пати), `sort`/`order`, `lang=ru` — русские подписи.',
      errors: [{ status: 422, code: 'invalid_value', why: 'В `fields` есть неизвестное поле — API отвечает списком допустимых имён.' }]
    },
    {
      id: 'characters-stats',
      group: 'read',
      title: 'Цифры по всей ферме одним запросом',
      scenario:
        'Нужна таблица для сравнения: у кого какой уровень, небо, статы и проходки — по всем персоназам разом, без карточек и заметок в ответе.',
      method: 'GET',
      path: '/api/v1/characters.stats',
      template: '/api/v1/characters.stats',
      scope: 'read',
      body: null,
      response: {
        characters: [
          {
            id: 'Mag_1',
            nick: 'Маг',
            class: 'Маг',
            level: 100,
            sky: { name: 'Звезда', level: 5 },
            stats: { hp: 120, mp: 30, physAttack: 12 },
            dungeonPasses: { weapon: 3, armor: 1, relic: 0 },
            ancientCoins: 12
          },
          {
            id: 'Luchnik_2',
            nick: 'Лучник',
            class: 'Лучник',
            level: 99,
            sky: { name: null, level: 0 },
            stats: { hp: 140, mp: 10, physAttack: 20 },
            dungeonPasses: { weapon: 2, armor: 1, relic: 0 },
            ancientCoins: 8
          }
        ],
        count: 2,
        fields: null,
        detail: 'stats',
        totals: { weapon: 5, armor: 2, relic: 0, sum: 7 }
      },
      explanation:
        'Отдельная команда для «чисел», потому что краткий `/characters` их не несёт, а `detail=full` ради одной колонки тянул бы заметки и историю монет. Строки идут в том же отборе и порядке, что `/characters` (те же `party`, `sort`, `order`, `lang`), и совпадают по id — два ответа склеиваются без угадывания. `totals` — суммы проходок на весь выданный список: «сколько у фермы оружия» считается на сервере, а не в вашем цикле. Одного персонажа подробно читают адресом `GET /characters/{id}/stats` и `…/dungeon-passes/{pass}`.',
      errors: [
        { status: 403, code: 'forbidden_scope', why: 'Право «чтение» выключено в настройках — без него цифры не отдаются.' },
        { status: 200, code: '—', why: 'Неизвестная `party` — не ошибка, а пустой список (`count: 0`): API не угадывает пати по части названия.' }
      ]
    },
    {
      id: 'character-card',
      group: 'read',
      title: 'Карточка одного персонажа',
      scenario: 'Нужно узнать, что за персонаж и в каком он окне игры сейчас.',
      method: 'GET',
      path: '/api/v1/characters/Mag_1',
      template: '/api/v1/characters/{id}',
      scope: 'read',
      body: null,
      response: {
        character: {
          id: 'Mag_1',
          nick: 'Маг',
          class: 'Маг',
          level: 100,
          stats: { hp: 40 },
          dungeonPasses: { weapon: 2, armor: 1, relic: 0 },
          running: { pid: 4321, title: 'Маг — Маг' }
        }
      },
      explanation:
        '`running` — окно игры этого персонажа: `pid` нужен, чтобы закрыть окно, `title` — заголовок окна. `null` означает, что персонаж сейчас не запущен. Идентификатор персонажа — это `id` в адресе: он же используется во всех правках.',
      errors: [{ status: 404, code: 'not_found', why: 'Персонажа с таким id нет. Список id — в `GET /characters`.' }]
    },
    {
      id: 'windows',
      group: 'read',
      title: 'Кто сейчас в игре',
      scenario: 'Своя программа хочет показать открытые окна игры и понять, к какому персонажу какое относится.',
      method: 'GET',
      path: '/api/v1/windows',
      template: '/api/v1/windows',
      scope: 'read',
      body: null,
      response: {
        windows: [{ pid: 4321, title: 'Маг — Маг', known: true, charId: 'Mag_1', nick: 'Маг' }]
      },
      explanation:
        '`pid` — идентификатор процесса: он нужен для закрытия окна. `known: false` — окно игры, но персонаж ему не сопоставлен; закрывать такое окно можно, но вот привязать к персонажу нельзя.',
      errors: []
    },
    {
      id: 'planner',
      group: 'read',
      title: 'Что запланировано',
      scenario: 'Программа показывает список дел на сегодня и на будущее — из планировщика приложения.',
      method: 'GET',
      path: '/api/v1/planner',
      template: '/api/v1/planner',
      scope: 'read',
      body: null,
      response: {
        entries: [
          {
            id: 'pe_1',
            title: 'Ежедневка',
            date: '2026-11-24',
            time: '',
            durationMinutes: 60,
            kind: 'task',
            priority: 'normal',
            recurrence: 'daily',
            status: 'todo',
            notes: ''
          }
        ]
      },
      explanation:
        'У повторяющейся записи (`recurrence: daily`) своё состояние на каждый день: общий `status` показывает последний день, а точный статус за конкретный день меняется через `PATCH` с полем `date`. Правку записи делает рецепт «Отметить задачу».',
      errors: []
    },
    {
      id: 'finance',
      group: 'read',
      title: 'Реестр денег',
      scenario: 'Своя программа показывает приход, расход, позиции магазина и долги.',
      method: 'GET',
      path: '/api/v1/finance',
      template: '/api/v1/finance',
      scope: 'read',
      body: null,
      response: {
        operations: [
          { id: 'op_1', date: '2026-11-24', currency: 'gold', kind: 'in', amount: 25000, counterparty: 'Продажа зелья', note: '', characterId: null }
        ],
        shopItems: [],
        loans: []
      },
      explanation:
        '`kind: in` — приход, `out` — расход; `currency` — `gold` или `coins`. Реестр — единственная правда о деньгах: записи из интерфейса и из API округляются одинаково, поэтому суммы не расходятся.',
      errors: []
    },
    {
      id: 'marathons',
      group: 'read',
      title: 'Прогресс марафонов',
      scenario: 'Программа показывает, сколько заданий марафона закрыто у каждого персонажа.',
      method: 'GET',
      path: '/api/v1/marathons',
      template: '/api/v1/marathons',
      scope: 'read',
      body: null,
      response: {
        marathons: [
          {
            id: 'm1',
            title: 'Ноябрь',
            kind: 'marathon',
            startDate: '2026-11-01',
            endDate: '2026-11-30',
            participantIds: ['Mag_1'],
            tasks: [{ id: 't1', title: 'Задание' }]
          }
        ]
      },
      explanation:
        'Список заданий — в `tasks`, участники — в `participantIds`. Отметка дня делается через `POST /marathons/{id}/marks` (тело: `characterId`, `taskId`, `date`).',
      errors: []
    },

    /* ------------------------------ изменение данных ------------------------------ */
    {
      id: 'stat-set',
      group: 'write',
      title: 'Поставить стат персонажу',
      scenario:
        'Своя программа вносит правку в карточку: например, поправить HP после боя. У нас есть право «Изменение статов и проходок».',
      method: 'PATCH',
      path: '/api/v1/characters/Mag_1/stats/hp',
      template: '/api/v1/characters/{id}/stats/{stat}',
      scope: 'modify',
      body: { value: 40 },
      response: { id: 'Mag_1', nick: 'Маг', stat: 'hp', value: 40, before: 35, changed: true },
      explanation:
        'Тело — `{"value": N}`: поставить значение. `{"mode":"inc","by":5}` — прибавить, `{"mode":"dec","by":5}` — отнять. В ответе `before` — что было, `value` — что стало: разницу видно сразу, а история «было → стало» сохраняется в базе.',
      errors: [
        { status: 403, code: 'forbidden_scope', why: 'В настройках приложения выключено право «Изменение статов и проходок».' },
        { status: 422, code: 'invalid_value', why: 'Такого стата нет: список допустимых — в `GET /characters/{id}/stats`.' }
      ]
    },
    {
      id: 'pass-set',
      group: 'write',
      title: 'Поставить проходку',
      scenario: 'Отметить, что оружие усилено до второго уровня.',
      method: 'PATCH',
      path: '/api/v1/characters/Mag_1/dungeon-passes/weapon',
      template: '/api/v1/characters/{id}/dungeon-passes/{pass}',
      scope: 'modify',
      body: { value: 2 },
      response: { id: 'Mag_1', nick: 'Маг', pass: 'weapon', value: 2, before: 1, total: 3, changed: true },
      explanation:
        'Проходки — `weapon`, `armor`, `relic`. `total` — сколько всего усилений у этого вида, `value` — текущий уровень. Как и у статов, в ответе видно, что было до правки.',
      errors: [{ status: 403, code: 'forbidden_scope', why: 'Нет права «Изменение статов и проходок».' }]
    },
    {
      id: 'planner-complete',
      group: 'write',
      title: 'Отметить задачу в планировщике',
      scenario:
        'Своя программа закрывает дело: ставит «сделано» или переносит запись на другой день. Запись должна вести себя ровно так же, как в интерфейсе приложения.',
      method: 'PATCH',
      path: '/api/v1/planner/entries/pe_1',
      template: '/api/v1/planner/entries/{id}',
      scope: 'modify',
      body: { status: 'done', date: '2026-11-24' },
      response: {
        entry: { id: 'pe_1', title: 'Ежедневка', date: '2026-11-24', time: '', status: 'done' },
        statusDate: '2026-11-24',
        statusValue: 'done',
        changed: ['status']
      },
      explanation:
        'Поля: `status` (`todo`, `doing`, `done`), `date` — день, к которому относится статус (для повтора это конкретный день: у повторов своё состояние на каждый день), `moveToDate` — перенести саму запись на другой день, `title`, `time`. Ответ `changed` перечисляет, что действительно поменялось, а `statusDate` и `statusValue` показывают состояние именно за запрошенный день: у повтора оно своё, поэтому отметка не сбрасывается — отметили вчера, сегодня снова «не сделано».',
      errors: [
        { status: 403, code: 'forbidden_scope', why: 'Нет права «Изменение статов и проходок».' },
        { status: 404, code: 'no_such_entry', why: 'Записи с таким id нет: id берётся из `GET /planner`.' },
        { status: 422, code: 'invalid_value', why: 'Неизвестное поле или неверная дата (нужен формат `ГГГГ-ММ-ДД`).' }
      ]
    },
    {
      id: 'planner-create',
      group: 'write',
      title: 'Создать задачу в планировщике',
      scenario: 'Программа добавляет дело в календарь: «сходить в игру на 19:00».',
      method: 'POST',
      path: '/api/v1/planner/entries',
      template: '/api/v1/planner/entries',
      scope: 'modify',
      body: { title: 'Сходить в игру', date: '2026-11-24', time: '19:00', durationMinutes: 120, kind: 'task' },
      response: { entry: { id: 'pe_2', title: 'Сходить в игру', date: '2026-11-24', time: '19:00', status: 'todo' } },
      explanation:
        'Обязательно только `title`; остальное необязательно: `date` (сегодня, если не указать), `time`, `durationMinutes`, `kind` (`task`, `event`, `note`), `priority`, `recurrence` (`none`, `daily`, `weekly`, `monthly`). Запись создаётся тем же нормализатором, что и в интерфейсе, поэтому повторы и длительность посчитаются одинаково.',
      errors: [
        { status: 403, code: 'forbidden_scope', why: 'Нет права «Изменение статов и проходок».' },
        { status: 422, code: 'invalid_value', why: 'Пустое `title` или неизвестное поле — API отвечает, что именно не так.' }
      ]
    },
    {
      id: 'finance-operation',
      group: 'write',
      title: 'Записать приход или расход',
      scenario:
        'Своя программа ведёт реестр денег рядом с приложением: продал зелье — записал приход, купил расходник — записал расход.',
      method: 'POST',
      path: '/api/v1/finance/operations',
      template: '/api/v1/finance/operations',
      scope: 'modify',
      body: { kind: 'in', amount: 25000, currency: 'gold', date: '2026-11-24', note: 'Продажа зелья' },
      response: {
        operation: { id: 'op_2', kind: 'in', amount: 25000, currency: 'gold', date: '2026-11-24', counterparty: '', note: 'Продажа зелья' }
      },
      explanation:
        '`kind` — `in` (приход) или `out` (расход, по умолчанию), `amount` — положительное число, `currency` — `gold` или `coins`. Запись идёт через модель учёта приложения: сумма округляется под валюту, поэтому балансы в приложении и в своей программе не разойдутся.',
      errors: [
        { status: 403, code: 'forbidden_scope', why: 'Нет права «Изменение статов и проходок».' },
        { status: 422, code: 'invalid_value', why: 'Сумма не положительна или валюта неизвестна.' }
      ]
    },
    {
      id: 'character-create',
      group: 'write',
      title: 'Добавить персонажа',
      scenario: 'Программа заводит нового персонажа в твин-ферме.',
      method: 'POST',
      path: '/api/v1/characters',
      template: '/api/v1/characters',
      scope: 'modify',
      body: { id: 'Mag_3', nick: 'Маг', class: 'Маг', level: 1 },
      response: { character: { id: 'Mag_3', nick: 'Маг', class: 'Маг', level: 1 } },
      explanation:
        'Обязателен `id` — он же станет именем файла персонажа и ключом во всех правках. `nick`, `class`, `level` необязательны, но без них персонаж будет выглядеть пустым в списке.',
      errors: [{ status: 403, code: 'forbidden_scope', why: 'Нет права «Изменение статов и проходок».' }]
    },

    /* ------------------------------ запуск и окна ------------------------------ */
    {
      id: 'launch-party',
      group: 'launch',
      title: 'Запустить пати',
      scenario: 'Нажали «играть» у пати: окна должны открыться в порядке участников, а не одновременно.',
      method: 'POST',
      path: '/api/v1/launch/party',
      template: '/api/v1/launch/party',
      scope: 'launchClose',
      body: { partyName: 'Основа' },
      response: { jobId: 'job_1', state: 'running', accepted: 2, skipped: [] },
      explanation:
        'Ответ — `202`: запуск идёт в фоне, приложение не блокируется. Дальше состояние смотрится по `jobId`: `GET /api/v1/jobs/{jobId}` → `state` (`running`, `done`, `failed`) и `skipped` — список участников, которых пропустили, с причиной. Нужен запуск только для одного окна — `POST /launch/character`, для выбранных в нужном порядке — `POST /launch/selection`.',
      errors: [
        { status: 403, code: 'forbidden_scope', why: 'Выключено право «Запуск и закрытие окон».' },
        { status: 429, code: 'launch_busy', why: 'Уже идёт другой запуск: одно задание одновременно.' }
      ]
    },
    {
      id: 'job-status',
      group: 'launch',
      title: 'Дождаться запуска',
      scenario: 'Программа запустила пати и хочет показать прогресс: что открылось, что нет и почему.',
      method: 'GET',
      path: '/api/v1/jobs/job_1',
      template: '/api/v1/jobs/{jobId}',
      scope: 'read',
      body: null,
      response: { job: { jobId: 'job_1', state: 'done', done: 2, skipped: [] } },
      explanation:
        '`state` — `running`, `done` или `failed`. `skipped` — честный список: кто не запустился и по какой причине (например, «персонаж уже в игре»). Задание живёт недолго: если `jobId` протух, придёт 404 — тогда нужно запускать заново.',
      errors: [{ status: 404, code: 'not_found', why: 'Задание не найдено или устарело.' }]
    },
    {
      id: 'close-windows',
      group: 'launch',
      title: 'Закрыть окна игры',
      scenario: 'Программа закрывает окна, о которых сказал человек. Закрытие необратимо, поэтому требует явного подтверждения.',
      method: 'POST',
      path: '/api/v1/windows/close',
      template: '/api/v1/windows/close',
      scope: 'launchClose',
      body: { pids: [4321], confirm: true },
      response: { found: 1, closed: 1, failed: 0, denied: 0, elevated: false, details: [], error: '' },
      explanation:
        'Закрываются именно `pid` из `GET /windows`, а не персонажи: pid — это процесс, он однозначен. `confirm: true` обязателен — без него придёт 400 `confirm_required`. В ответе `closed` — сколько окон реально закрылось, `failed` и `denied` — сколько не закрылось и почему.',
      errors: [
        { status: 400, code: 'confirm_required', why: 'Не хватает `"confirm": true` — закрывать окна без подтверждения нельзя.' },
        { status: 403, code: 'forbidden_scope', why: 'Выключено право «Запуск и закрытие окон».' }
      ]
    },

    /* --------------------------------- выгрузки --------------------------------- */
    {
      id: 'export-csv',
      group: 'export',
      title: 'Выгрузить список в CSV',
      scenario: 'Человек открывает файл в Excel: с «;» и BOM, чтобы русские подписи не рассыпались.',
      method: 'GET',
      path: '/api/v1/export/characters.csv',
      template: '/api/v1/export/{набор}.{csv|json}',
      scope: 'read',
      body: null,
      response: 'id;nick;class;level\nMag_1;Маг;Маг;100',
      explanation:
        'Наборы: `characters`, `parties`, `marathons`, `windows`, `planner`, `finance`. Формат — `csv` или `json` (`.json` в адресе или `?format=json`). Большие списки лучше сузить фильтром `party`: выгрузка ограничена 64 КиБ. Ответ приходит файлом, а не JSON.',
      errors: [{ status: 422, code: 'invalid_value', why: 'Формат выгрузки: csv, json или txt.' }]
    },

    /* ------------------------------ диагностика ------------------------------ */
    {
      id: 'error-401',
      group: 'errors',
      title: '401 unauthorized: не тот токен',
      scenario: 'Программа вдруг начала получать 401, хотя вчера всё работало.',
      method: 'GET',
      path: '/api/v1/health',
      template: '/api/v1/health',
      scope: 'read',
      body: null,
      response: { error: { code: 'unauthorized', message: 'Нужен заголовок Authorization: Bearer <токен>' } },
      explanation:
        'Сначала сверьте значение: «Настройки → 🔌 Внешний API → Скопировать токен» читает его из хранилища и не меняет — это безопасная проверка. Перевыпуск («Перевыпустить») нужен, только если токен утёк: после него старый перестаёт работать, а обновить `TF_API_TOKEN` придётся во всех программах. Бывает и другое: в заголовке `Bearer` без пробела, токен с пробелами или кавычками внутри — его надо вырезать целиком, без переносов строки.',
      errors: []
    },
    {
      id: 'error-403',
      group: 'errors',
      title: '403 forbidden_scope: не хватает права',
      scenario: 'Чтение работает, а PATCH отвечает 403 — как понять, что именно сломано.',
      method: 'PATCH',
      path: '/api/v1/characters/Mag_1/stats/hp',
      template: '/api/v1/characters/{id}/stats/{stat}',
      scope: 'modify',
      body: { value: 40 },
      response: { error: { code: 'forbidden_scope', message: 'Нужно право «Изменение статов и проходок»' } },
      explanation:
        'Права проверяются дважды: в Rust (по таблице маршрутов) и в мосте (по текущим настройкам). Значит, либо выключено право в настройках приложения, либо маршруту нужно другое право: запуск и закрытие окон — «Запуск и закрытие окон», а не «Изменение». Текущие права видно в `GET /health` → `scopes`.',
      errors: []
    },
    {
      id: 'error-422',
      group: 'errors',
      title: '422 invalid_value: запрос не поняли',
      scenario: 'Ответ 422: значит адрес и права в порядке, но содержимое запроса не подошло.',
      method: 'PATCH',
      path: '/api/v1/planner/entries/pe_1',
      template: '/api/v1/planner/entries/{id}',
      scope: 'modify',
      body: { status: 'готово' },
      response: { error: { code: 'invalid_value', message: 'status: todo, doing или done' } },
      explanation:
        'Сообщение в ответе объясняет, что именно не так: неизвестное поле, пустое название, неверная дата (`ГГГГ-ММ-ДД`) или недопустимое значение статуса. Значения перечисляются прямо в тексте ошибки — обычно достаточно поправить одно поле.',
      errors: []
    },
    {
      id: 'error-429',
      group: 'errors',
      title: '429: лимит запросов',
      scenario: 'Программа долго шлёт запросы и начала получать отказы.',
      method: 'GET',
      path: '/api/v1/characters',
      template: '/api/v1/characters',
      scope: 'read',
      body: null,
      response: { error: { code: 'too_many_requests', message: 'Слишком много запросов' } },
      explanation:
        'Ограничение — 60 запросов в минуту с одного адреса (окно 60 секунд, с запасом на всплески). В ответе есть заголовок `Retry-After`: столько секунд надо подождать. Чаще всего виноват цикл без паузы: сначала спросите `GET /status` и забирайте всё нужное одним запросом.',
      errors: []
    }
  ];

  /* ------------------------------ сборка примеров ------------------------------ */

  /** Тело запроса одной строкой — так его удобно положить в `-d`. */
  const bodyText = body => (body === null || body === undefined ? '' : JSON.stringify(body));

  /** Тело запроса для Python: словарь в удобном виде. */
  const pythonBody = body => {
    if (!body) return 'None';
    const lines = Object.entries(body).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    return `{\n${lines.join(',\n')}\n}`;
  };

  /** curl-пример: одна команда, готовая к копированию. */
  function curl(recipe) {
    const lines = [`curl -s -X ${recipe.method} \\`, `  -H "Authorization: Bearer <токен>" \\`];
    if (recipe.body) {
      lines.push('  -H "Content-Type: application/json" \\');
      lines.push(`  -d '${bodyText(recipe.body)}' \\`);
    }
    lines.push(`  ${BASE}${recipe.path}`);
    return lines.join('\n');
  }

  /** Python-пример: urllib из стандартной библиотеки, без зависимостей. */
  function python(recipe) {
    const method = recipe.method.toLowerCase();
    const lines = [
      'import json, urllib.request',
      '',
      'BASE = "' + BASE + '/api/v1"',
      'TOKEN = "<токен>"',
      ''
    ];
    if (recipe.body) {
      lines.push(`body = ${pythonBody(recipe.body)}`, '');
    }
    lines.push('request = urllib.request.Request(');
    lines.push(`    BASE + "${recipe.path.replace('/api/v1', '')}",`);
    lines.push(`    method="${method}",`);
    lines.push('    headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},');
    if (recipe.body) {
      lines.push('    data=json.dumps(body).encode("utf-8"),');
    } else {
      lines.push('    data=None,');
    }
    lines.push(')');
    lines.push('with urllib.request.urlopen(request, timeout=30) as response:');
    lines.push('    print(json.load(response))');
    return lines.join('\n');
  }

  /** PowerShell-пример: Invoke-RestMethod, как в Windows-скриптах. */
  function powershell(recipe) {
    const method = recipe.method.toLowerCase();
    const lines = [
      `$token = "<токен>"`,
      `$base = "${BASE}/api/v1"`,
      '$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }',
      ''
    ];
    if (recipe.body) {
      lines.push(`$body = @'`, JSON.stringify(recipe.body, null, 2), `'@ | ConvertFrom-Json | ConvertTo-Json`, '');
    }
    const path = recipe.path.replace('/api/v1', '');
    if (recipe.body) {
      lines.push(`Invoke-RestMethod -Method ${recipe.method} -Uri "$base${path}" -Headers $headers -Body $body`);
    } else {
      lines.push(`Invoke-RestMethod -Method ${recipe.method} -Uri "$base${path}" -Headers $headers`);
    }
    return lines.join('\n');
  }

  window.TF_API_RECIPE_GROUPS = groups;
  window.TF_API_RECIPES = recipes;
  window.TF_API_RECIPE_SNIPPETS = { curl, python, powershell };
})();

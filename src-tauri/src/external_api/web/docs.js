// Справочник методов внешнего API для страницы /docs.
//
// Здесь только данные: группы, методы, параметры, ответы и примеры. Разметку
// строит app.js — поэтому справочник можно проверить тестом (jsdom), не поднимая
// сервер. Каждый метод описан одинаково:
//
//   { method, path, scope, summary, description, params[], response, example, exampleBody? }
//
// `path` — как вызывать; сегменты в фигурных скобках заменяются на значения,
// `example` — подставленный путь с тестовыми значениями (чтобы было видно вид).
//
// Правило: примеры должны быть настоящими. Если метод меняет данные, в примере
// стоит `PATCH`/`POST` с телом; если только читает — `curl` без тела. Проверка —
// tests/externalApiDocs.test.js: он сверяет, что все маршруты существуют в мосте.
(() => {
  'use strict';

  const STATS = [
    ['hp', 'HP'],
    ['mp', 'MP'],
    ['endurance', 'Выносливость'],
    ['intelligence', 'Интеллект'],
    ['strength', 'Сила'],
    ['agility', 'Ловкость'],
    ['levelBonus', 'Бонус уровня'],
    ['physAttack', 'Физ. атака'],
    ['physDefense', 'Физ. защита'],
    ['magAttack', 'Маг. атака'],
    ['magDefense', 'Маг. защита'],
    ['critChance', 'Крит, %'],
    ['critDamage', 'Крит. урон'],
    ['atkSpeed', 'Скорость атаки'],
    ['evasion', 'Уклонение'],
    ['accuracy', 'Меткость'],
    ['pa', 'PA'],
    ['pz', 'PZ'],
    ['morale', 'Дух'],
    ['pvePa', 'PvE PA'],
    ['pvePz', 'PvE PZ'],
    ['physPenetration', 'Физ. пробивание'],
    ['magPenetration', 'Маг. пробивание']
  ];

  const PASSES = [
    ['weapon', 'Оружие', 'оружие'],
    ['armor', 'Доспех', 'доспех'],
    ['relic', 'Реликвия', 'реликвия']
  ];

  const groups = [
    {
      id: 'start',
      title: 'Начало работы',
      summary: 'Адрес, токен, права, лимиты и общие правила. Прочитайте до первого запроса.',
      methods: [
        {
          id: 'base',
          method: '—',
          path: 'http://127.0.0.1:47831/api/v1',
          scope: '—',
          summary: 'Базовый адрес и правила подключения.',
          description:
            'Сервер поднимается приложением и слушает только 127.0.0.1 — с других компьютеров и по сети он недоступен. Порт по умолчанию 47831, меняется в настройках. Каждый запрос должен нести заголовок Authorization: Bearer <токен>; токен создаётся и перевыпускается в «Настройки → 🔌 Внешний API».',
          params: [],
          response: 'Все ответы — JSON, кроме выгрузок (/export/*): они приходят файлом.',
          example: 'http://127.0.0.1:47831/api/v1',
          exampleBody: null
        },
        {
          id: 'headers',
          method: '—',
          path: 'Заголовки запроса',
          scope: '—',
          summary: 'Authorization обязателен, Content-Type — для тел.',
          description:
            'Заголовок Authorization проверяется до чтения тела: без него — 401. Заголовок Host тоже проверяется (защита от DNS rebinding): допустимы только 127.0.0.1:<порт> и localhost:<порт>. CORS-заголовков нет: запросы из чужой вкладки браузера не пройдут.',
          params: [],
          response: 'Не JSON-ошибка, а обычный ответ: {"error":{"code":"…","message":"…"}}.',
          example:
            'Authorization: Bearer 0123…(64 hex)\nContent-Type: application/json\nAccept: application/json',
          exampleBody: null
        },
        {
          id: 'scopes',
          method: '—',
          path: 'Права (scopes)',
          scope: '—',
          summary: 'Три галочки в настройках: чтение, изменение, запуск.',
          description:
            '«Чтение» включено по умолчанию: /characters, /parties, /marathons, /planner, /finance, /windows, /export, /audit, /jobs. «Изменение статов и проходок» открывает PATCH и POST, которые меняют данные. «Запуск и закрытие окон» — /launch/* и /windows/close. Если право выключено, ответ 403 forbidden_scope и данные не меняются.',
          params: [],
          response: 'Текущие права видны в GET /health → scopes.',
          example: 'GET /health → {"scopes":{"read":true,"modify":false,"launchClose":false}}',
          exampleBody: null
        },
        {
          id: 'limits',
          method: '—',
          path: 'Лимиты и размеры',
          scope: '—',
          summary: '60 запросов в минуту, 16 соединений, тело до 64 КиБ.',
          description:
            'Не больше 60 запросов в минуту с одного адреса (запас на всплески до 20 — окно 60 секунд). Одновременно не больше 16 соединений. Заголовки — до 16 КиБ, тело — до 64 КиБ. Выгрузка /export — до 64 КиБ на файл: очень большие списки режьте фильтром party. Запуск окон — одно задание одновременно, второй POST получает 429 launch_busy.',
          params: [],
          response: 'При 429 приходит Retry-After: через сколько секунд повторять.',
          example: 'HTTP/1.1 429 Too Many Requests\nRetry-After: 12\n{"error":{"code":"too_many_requests","message":"…"}}',
          exampleBody: null
        },
        {
          id: 'errors',
          method: '—',
          path: 'Коды ошибок',
          scope: '—',
          summary: 'Единый формат {"error":{"code","message"}}.',
          description:
            'Код всегда в теле и всегда машиночитаемый: 400 invalid_json/bad_request/confirm_required, 401 unauthorized, 403 forbidden_host/forbidden_scope/forbidden, 404 not_found/no_such_character/no_such_party/no_such_marathon/no_such_task, 405 method_not_allowed, 408 timeout, 409 launch_not_ready/marathon_not_ready, 413 payload_too_large, 415 unsupported_media_type, 422 invalid_value, 423 storage_blocked, 429 launch_busy/too_many_requests, 500 internal_error/save_failed, 503 app_not_ready/too_many_connections, 504 timeout.',
          params: [],
          response: '{"error":{"code":"invalid_value","message":"Неизвестный стат «nope»: …"}}',
          example: 'HTTP/1.1 422 Unprocessable Entity\n{"error":{"code":"invalid_value","message":"…"}}',
          exampleBody: null
        }
      ]
    },
    {
      id: 'health',
      title: 'Состояние и журнал',
      summary: 'Проверка связи, версия, права, занятость запуска и журнал вызовов.',
      methods: [
        {
          id: 'get-health',
          method: 'GET',
          path: '/health',
          scope: 'чтение',
          summary: 'Живой ли сервер, какая версия, какие права и идёт ли запуск.',
          description:
            'Первый запрос, который стоит делать: он подтверждает токен и показывает, что включено. storage.writable=false значит, что защита остановила запись: изменения вернут 423 storage_blocked.',
          params: [],
          response:
            '{ ok, app: { version, build }, api: { version, uptimeSec }, storage: { writable }, scopes: { read, modify, launchClose }, launch: { busy } }.',
          example: 'GET /health',
          exampleBody: null
        },
        {
          id: 'get-audit',
          method: 'GET',
          path: '/audit',
          scope: 'чтение',
          summary: 'Последние 100 вызовов: время, метод, путь, код, длительность.',
          description:
            'Кольцевой журнал в памяти. Тел запросов и токенов в нём нет. Сбрасывается кнопкой в настройках (POST /audit/clear через приложение) и при перезапуске.',
          params: [],
          response: '{ audit: [{ atMs, method, path, status, ms }] }.',
          example: 'GET /audit',
          exampleBody: null
        }
      ]
    },
    {
      id: 'characters',
      title: 'Персонажи',
      summary: 'Списки, карточка, отдельные статы и проходки — чтение и точечная запись.',
      methods: [
        {
          id: 'list-characters',
          method: 'GET',
          path: '/characters',
          scope: 'чтение',
          summary: 'Все персонажи со статами, проходками и признаком запущенного окна.',
          description:
            'Секретов в ответе нет: контакты, пароль, путь запуска и куки не отдаются никогда. party — id или название пати: список сузится до её состава. fields — через запятую: вернуть только эти поля (id остаётся всегда), удобно для узких отчётов.',
          params: [
            ['party', 'query', 'string', 'id или название пати (без регистра).'],
            ['fields', 'query', 'string', 'Список полей через запятую, например id,nick,hp.'],
            ['running', 'в ответе', 'object|null', 'Окно игры, если запущено: { pid, title, charId, nick }.']
          ],
          response:
            '{ characters: [{ id, nick, class, level, favorite, partyIds, mainPartyId, sky, stats, dungeonPasses, ancientCoins, tags, coinHistory, notes, createdAt, updatedAt, running }] }.',
          example: 'GET /characters?party=Основа&fields=id,nick,level,dungeonPasses',
          exampleBody: null
        },
        {
          id: 'get-character',
          method: 'GET',
          path: '/characters/{id}',
          scope: 'чтение',
          summary: 'Карточка одного персонажа: всё, что есть в списке, плюс окно.',
          description:
            'Основной запрос «раскрыть персонажа». Для «одного поля» есть короче: /characters/{id}/stats/{stat} и /characters/{id}/dungeon-passes/{pass}.',
          params: [['id', 'путь', 'string', 'id персонажа, например Mag_1.']],
          response: '{ character: { … } } — та же форма, что в списке.',
          example: 'GET /characters/Mag_1',
          exampleBody: null
        },
        {
          id: 'get-character-stats',
          method: 'GET',
          path: '/characters/{id}/stats',
          scope: 'чтение',
          summary: 'Все статы персонажа: и таблицей, и строками с подписями.',
          description:
            'Возвращает два взгляда на одно и то же: character — плоский объект { id, nick, hp, mp, physAttack, … }, stats — массив { key, label, value } для таблиц и логов. Порядок и набор ключей — как в интерфейсе персонажа.',
          params: [['id', 'путь', 'string', 'id персонажа.']],
          response:
            '{ character: { id, nick, hp, mp, endurance, …, magPenetration }, stats: [{ key, label, value }], count }.',
          example: 'GET /characters/Mag_1/stats',
          exampleBody: null
        },
        {
          id: 'get-character-stat',
          method: 'GET',
          path: '/characters/{id}/stats/{stat}',
          scope: 'чтение',
          summary: 'Одно значение стата: «сколько HP у персонажа id».',
          description:
            'Стат — один из ключей: hp, mp, endurance, intelligence, strength, agility, levelBonus, physAttack, physDefense, magAttack, magDefense, critChance, critDamage, atkSpeed, evasion, accuracy, pa, pz, morale, pvePa, pvePz, physPenetration, magPenetration. Неизвестный ключ — 422 invalid_value, а не тихий ноль.',
          params: [
            ['id', 'путь', 'string', 'id персонажа.'],
            ['stat', 'путь', 'string', 'ключ стата (hp, physAttack, …).']
          ],
          response: '{ id, nick, stat, label, value }.',
          example: 'GET /characters/Mag_1/stats/hp',
          exampleBody: null
        },
        {
          id: 'patch-character',
          method: 'PATCH',
          path: '/characters/{id}',
          scope: 'изменение',
          summary: 'Изменить персонажа: статы, проходки и поля карточки одним запросом.',
          description:
            'Меняются только переданные ключи. stats — числа 0…1 000 000 000; dungeonPasses — целые. Поля карточки: nick, class, level (0…1000), notes (до 5000), tags (строка через запятую или массив), favorite, sky { name, level }. Перед изменением статов снимается снимок истории — как при сохранении карточки в интерфейсе.',
          params: [
            ['stats', 'body', 'object', '{ hp: 150, physAttack: 12 }'],
            ['dungeonPasses', 'body', 'object', '{ weapon: 5, armor: 3, relic: 1 }'],
            ['nick, class, level, notes, tags, favorite, sky', 'body', 'разное', 'Поля карточки — необязательны.']
          ],
          response: '{ character: { id, nick, class, level, favorite, tags, stats, dungeonPasses, updatedAt }, changed: ["stats.hp"], statsHistoryAdded }.',
          example: 'PATCH /characters/Mag_1',
          exampleBody: { stats: { hp: 150 }, dungeonPasses: { weapon: 5 }, nick: 'Маг II' }
        },
        {
          id: 'patch-character-stat',
          method: 'PATCH',
          path: '/characters/{id}/stats/{stat}',
          scope: 'изменение',
          summary: 'Задать один стат — или прибавить/вычесть: «+1 к HP».',
          description:
            'Два режима: явное значение {"value":150} и прибавка {"mode":"inc","by":5} (или "dec"). by по умолчанию 1. Точно так же, как PATCH общего вида, но адрес короче и понятнее в скриптах. Снимок истории статов создаётся только при реальном изменении.',
          params: [
            ['id', 'путь', 'string', 'id персонажа.'],
            ['stat', 'путь', 'string', 'ключ стата.'],
            ['value', 'body', 'number', 'Для mode=set (по умолчанию): новое значение 0…1 000 000 000.'],
            ['mode', 'body', 'string', 'set | inc | dec.'],
            ['by', 'body', 'number', 'Для inc/dec: на сколько, по умолчанию 1.']
          ],
          response: '{ id, nick, stat, value, before, changed }.',
          example: 'PATCH /characters/Mag_1/stats/hp',
          exampleBody: { value: 150 }
        },
        {
          id: 'get-character-passes',
          method: 'GET',
          path: '/characters/{id}/dungeon-passes',
          scope: 'чтение',
          summary: 'Все проходки персонажа: оружие, доспех, реликвия — и сумма.',
          description:
            'Проходки в API называются dungeonPasses; здесь они разложены на строки { key, label, value } и дополнены total — суммой трёх. То же самое лежит в карточке персонажа, но таблицей пользоваться удобнее.',
          params: [['id', 'путь', 'string', 'id персонажа.']],
          response: '{ id, nick, total, dungeonPasses: { weapon, armor, relic }, passes: [{ key, label, value }] }.',
          example: 'GET /characters/Mag_1/dungeon-passes',
          exampleBody: null
        },
        {
          id: 'get-character-pass',
          method: 'GET',
          path: '/characters/{id}/dungeon-passes/{pass}',
          scope: 'чтение',
          summary: 'Одно число проходок: «сколько проходок оружия у Mag_1».',
          description:
            'Имя проходки принимается по-английски и по-русски: weapon/оружие, armor/доспех, relic/реликвия (регистр не важен). Русское имя в адресе нужно кодировать: %D0%BE%D1%80%D1%83%D0%B6%D0%B8%D0%B5 — curl с --data-urlencode или Python с quote() сделают это сами.',
          params: [
            ['id', 'путь', 'string', 'id персонажа.'],
            ['pass', 'путь', 'string', 'weapon/оружие, armor/доспех, relic/реликвия.']
          ],
          response: '{ id, nick, pass, label, value }.',
          example: 'GET /characters/Mag_1/dungeon-passes/weapon',
          exampleBody: null
        },
        {
          id: 'patch-character-pass',
          method: 'PATCH',
          path: '/characters/{id}/dungeon-passes/{pass}',
          scope: 'изменение',
          summary: 'Изменить одно число проходок — тело может быть просто числом.',
          description:
            'Тело: {"value": 5} или голое число 5 — второе короче в curl и PowerShell. Имена проходок те же, что у чтения. Ответ содержит и остальные две проходки, и новый total — чтобы не делать второй запрос.',
          params: [
            ['id', 'путь', 'string', 'id персонажа.'],
            ['pass', 'путь', 'string', 'weapon/оружие, armor/доспех, relic/реликвия.'],
            ['value', 'body', 'number', 'Целое неотрицательное число.']
          ],
          response: '{ id, nick, pass, value, before, changed, dungeonPasses, total }.',
          example: 'PATCH /characters/Mag_1/dungeon-passes/weapon',
          exampleBody: { value: 5 }
        },
        {
          id: 'post-character',
          method: 'POST',
          path: '/characters',
          scope: 'изменение',
          summary: 'Создать персонажа: обязателен только ник.',
          description:
            'Остальные поля — необязательны. Одинаковые ники допустимы (разные аккаунты): duplicateNick=true — предупреждение, а не ошибка. id генерируется приложением.',
          params: [
            ['nick', 'body', 'string', 'Обязателен.'],
            ['class, level, notes, tags, favorite, sky', 'body', 'разное', 'Необязательны.']
          ],
          response: '{ character: { id, nick, level, class }, duplicateNick }.  Код 201.',
          example: 'POST /characters',
          exampleBody: { nick: 'Новый', class: 'Маг', level: 1 }
        },
        {
          id: 'bulk-update',
          method: 'POST',
          path: '/characters/bulk-update',
          scope: 'изменение',
          summary: 'Один и тот же патч сразу нескольким персонажам (до 100).',
          description:
            'Частичный успех — нормальный ответ: updated и failed перечисляют, что вышло. Патч проверяется один раз до правок: если он неверный, не меняется никто. Дубликаты и пустые id — 422.',
          params: [
            ['ids', 'body', 'string[]', '1…100 уникальных id.'],
            ['patch', 'body', 'object', 'Как у PATCH /characters/{id}.']
          ],
          response: '{ updated: [{ id, nick, changed }], failed: [{ id, code, message }] }.',
          example: 'POST /characters/bulk-update',
          exampleBody: { ids: ['Mag_1', 'Luchnik_2'], patch: { dungeonPasses: { weapon: 5 } } }
        }
      ]
    },
    {
      id: 'parties',
      title: 'Пати',
      summary: 'Состав в сохранённом порядке — он же порядок запуска. Название и цвет меняются.',
      methods: [
        {
          id: 'list-parties',
          method: 'GET',
          path: '/parties',
          scope: 'чтение',
          summary: 'Все пати с составом в порядке перетаскивания.',
          description:
            'Порядок members — тот же, что в карточке пати, и он же определяет порядок запуска окон. Если порядок задан вручную, он сохраняется и в API.',
          params: [],
          response: '{ parties: [{ id, name, color, members: [{ id, nick, order }] }] }.',
          example: 'GET /parties',
          exampleBody: null
        },
        {
          id: 'get-party',
          method: 'GET',
          path: '/parties/{id}',
          scope: 'чтение',
          summary: 'Одна пати по id.',
          description: '404 no_such_party, если такой нет.',
          params: [['id', 'путь', 'string', 'id пати, например p-osnova.']],
          response: '{ party: { id, name, color, members } }.',
          example: 'GET /parties/p-osnova',
          exampleBody: null
        },
        {
          id: 'patch-party',
          method: 'PATCH',
          path: '/parties/{id}',
          scope: 'изменение',
          summary: 'Переименовать пати или сменить цвет.',
          description:
            'Меняются только переданные поля. Пустое имя — 422. color=null сбрасывает цвет. Состав меняется в интерфейсе — так задумано: он влияет на запуск, и правки через API здесь были бы опаснее пользы.',
          params: [
            ['name', 'body', 'string', 'Новое имя, 1…80 символов.'],
            ['color', 'body', 'string|null', 'Цвет или null для сброса.']
          ],
          response: '{ party: { id, name, color }, changed }.',
          example: 'PATCH /parties/p-osnova',
          exampleBody: { name: 'Основа+' }
        }
      ]
    },
    {
      id: 'marathons',
      title: 'Марафоны',
      summary: 'Список, карточка, участники, ручные отметки и поправки.',
      methods: [
        {
          id: 'list-marathons',
          method: 'GET',
          path: '/marathons',
          scope: 'чтение',
          summary: 'Все марафоны с прогрессом по каждому персонажу и итогами.',
          description:
            'totals считает marathonTotals из модели интерфейса — второй правды о прогрессе API не заводит. Если данных не хватает, totals=null: список всё равно придёт. Папки-серии (kind=series) — отдельные записи с childIds и без заданий.',
          params: [],
          response:
            '{ marathons: [{ id, kind, title, startDate, endDate, status, participantIds, tasks, bonuses, awards, progress, totals, createdAt, updatedAt }] }.',
          example: 'GET /marathons',
          exampleBody: null
        },
        {
          id: 'get-marathon',
          method: 'GET',
          path: '/marathons/{id}',
          scope: 'чтение',
          summary: 'Один марафон: задания, награды, прогресс.',
          description:
            'progress[characterId][taskId] = { marks: ["2026-11-24"], adjust: 0, site: 2 }. marks — ручные отметки дней, adjust — поправка, site — число с сайта. totals — итоги по персонажам и заданиям.',
          params: [['id', 'путь', 'string', 'id марафона.']],
          response: '{ marathon: { … } } — форма как в списке. 404 no_such_marathon.',
          example: 'GET /marathons/m1',
          exampleBody: null
        },
        {
          id: 'marathon-participants',
          method: 'GET',
          path: '/marathons/{id}/participants',
          scope: 'чтение',
          summary: 'Кто участвует и в каких пати они состоят.',
          description: 'Удобно, чтобы собрать отчёт «персонажи марафона по пати».',
          params: [['id', 'путь', 'string', 'id марафона.']],
          response: '{ marathonId, characters: [{ id, nick }], parties: [{ id, name }] }.',
          example: 'GET /marathons/m1/participants',
          exampleBody: null
        },
        {
          id: 'marathon-marks',
          method: 'POST',
          path: '/marathons/{id}/marks',
          scope: 'изменение',
          summary: 'Поставить или снять ручную отметку дня.',
          description:
            'Дата должна быть в формате YYYY-MM-DD и попадать в сроки марафона. Персонаж обязан участвовать, задание — существовать. Это те же поля, что пишет интерфейс марафонов: отдельного «своего» прогресса у API нет.',
          params: [
            ['characterId', 'body', 'string', 'Участник марафона.'],
            ['taskId', 'body', 'string', 'Задание марафона.'],
            ['date', 'body', 'string', 'YYYY-MM-DD в пределах сроков.'],
            ['marked', 'body', 'boolean', 'true — поставить (по умолчанию), false — снять.']
          ],
          response: '{ marathonId, characterId, taskId, date, marked, changed, marks }.',
          example: 'POST /marathons/m1/marks',
          exampleBody: { characterId: 'Mag_1', taskId: 't1', date: '2026-11-24' }
        },
        {
          id: 'marathon-adjust',
          method: 'POST',
          path: '/marathons/{id}/adjust',
          scope: 'изменение',
          summary: 'Поправка к счётчику задания: абсолютное значение.',
          description:
            'Для дел, которые не попали на сайт: value — новое значение поправки (может быть отрицательным). Целое от −100 000 до 100 000. Сохраняется только при реальном изменении.',
          params: [
            ['characterId', 'body', 'string', 'Участник марафона.'],
            ['taskId', 'body', 'string', 'Задание.'],
            ['value', 'body', 'number', 'Новая поправка, целое.']
          ],
          response: '{ marathonId, characterId, taskId, adjust, previous, changed }.',
          example: 'POST /marathons/m1/adjust',
          exampleBody: { characterId: 'Mag_1', taskId: 't1', value: 4 }
        }
      ]
    },
    {
      id: 'other',
      title: 'Планировщик и учёт',
      summary: 'Календарь дел, движения денег, магазин, долги и курс.',
      methods: [
        {
          id: 'get-planner',
          method: 'GET',
          path: '/planner',
          scope: 'чтение',
          summary: 'Записи планировщика: что, когда и с каким повтором.',
          description: 'Только даты и статусы — заметок персонажей и контактов здесь нет.',
          params: [],
          response:
            '{ entries: [{ id, title, date, time, durationMinutes, kind, priority, recurrence, status }] }.',
          example: 'GET /planner',
          exampleBody: null
        },
        {
          id: 'get-finance',
          method: 'GET',
          path: '/finance',
          scope: 'чтение',
          summary: 'Учёт: операции, позиции магазина, долги и настройки курса.',
          description:
            'characterId у операции — ссылка на персонажа, но контактов и паролей в учёте нет. settings: goldRate, commissionPct, goldRateAt, opening.',
          params: [],
          response: '{ operations: [{ id, date, kind, amount, currency, counterparty, note, characterId }], shopItems, loans, settings }.',
          example: 'GET /finance',
          exampleBody: null
        }
      ]
    },
    {
      id: 'windows',
      title: 'Окна игры',
      summary: 'Какие окна запущены, какой у них PID и как их закрыть.',
      methods: [
        {
          id: 'get-windows',
          method: 'GET',
          path: '/windows',
          scope: 'чтение',
          summary: 'Запущенные окна: PID, заголовок, персонаж и время запуска.',
          description:
            'charId берётся из заголовка окна и может быть null, если окно не сопоставлено. PID из этого ответа — единственный правильный аргумент для закрытия: персонажей закрывать «по имени» нельзя.',
          params: [],
          response: '{ windows: [{ pid, title, charId, nick, class, elevated, startedAt }] }.',
          example: 'GET /windows',
          exampleBody: null
        },
        {
          id: 'windows-close',
          method: 'POST',
          path: '/windows/close',
          scope: 'запуск и закрытие',
          summary: 'Закрыть окна по PID — только с подтверждением.',
          description:
            'Требуется {"confirm": true} и PID из GET /windows. Без confirm — 400 confirm_required. Закрываются только известные окна: чужие процессы API не трогает.',
          params: [
            ['pids', 'body', 'number[]', 'PID из GET /windows.'],
            ['confirm', 'body', 'boolean', 'Обязательно true.']
          ],
          response: '{ found, closed, failed, denied, elevated, details }.',
          example: 'POST /windows/close',
          exampleBody: { pids: [4321], confirm: true }
        }
      ]
    },
    {
      id: 'launch',
      title: 'Запуск и задания',
      summary: 'Запуск персонажа, пати или выбранных — заданием с прогрессом.',
      methods: [
        {
          id: 'launch-character',
          method: 'POST',
          path: '/launch/character',
          scope: 'запуск и закрытие',
          summary: 'Запустить окно одного персонажа.',
          description:
            'Ответ приходит сразу: 202 { id, kind, status, … } — это задание, а не «уже запущено». Проверки (GameCenter, запомненный вход, уже открытое окно) идут тем же кодом, что у кнопки. Прогресс — GET /jobs/{jobId}. Запуск один за раз: второй POST — 429 launch_busy.',
          params: [
            ['characterId', 'body', 'string', 'id персонажа.'],
            ['gcId', 'body', 'string', 'Необязательный GameCenter; иначе — у персонажа или из настроек.']
          ],
          response: '{ id, kind: "character", status, createdAt, progress: { done, total, percent, stage } }.  Код 202.',
          example: 'POST /launch/character',
          exampleBody: { characterId: 'Mag_1' }
        },
        {
          id: 'launch-party',
          method: 'POST',
          path: '/launch/party',
          scope: 'запуск и закрытие',
          summary: 'Запустить пати целиком или её часть.',
          description:
            'partyId или partyName (без регистра). memberIds фильтруется по составу: чужие id не запускаются, а возвращаются в ignoredIds итога. Без memberIds запускается вся пати в сохранённом порядке.',
          params: [
            ['partyId', 'body', 'string', 'id пати (можно вместо partyName).'],
            ['partyName', 'body', 'string', 'Название пати (без регистра).'],
            ['memberIds', 'body', 'string[]', 'Необязательно: кого именно из пати.']
          ],
          response: '{ id, kind: "party", status, progress }.  Код 202.',
          example: 'POST /launch/party',
          exampleBody: { partyName: 'Основа' }
        },
        {
          id: 'launch-selection',
          method: 'POST',
          path: '/launch/selection',
          scope: 'запуск и закрытие',
          summary: 'Запустить выбранных персонажей из разных пати в заданном порядке.',
          description:
            'Главный сценарий фермы: «запусти вот этих двенадцать». До 100 уникальных id, порядок сохраняется: первый в списке запускается первым. Неизвестные id попадают в ignoredIds, а не ломают запуск; архивные не запускаются.',
          params: [
            ['characterIds', 'body', 'string[]', '1…100 уникальных id в нужном порядке.'],
            ['gcId', 'body', 'string', 'Необязательный GameCenter.']
          ],
          response: '{ id, kind: "selection", status, progress }.  Код 202.',
          example: 'POST /launch/selection',
          exampleBody: { characterIds: ['Mag_1', 'Luchnik_2'] }
        },
        {
          id: 'get-job',
          method: 'GET',
          path: '/jobs/{jobId}',
          scope: 'чтение',
          summary: 'Прогресс и итог задания запуска.',
          description:
            'status: queued | running | done | failed. result.items — строка на каждого: ok, failed (с error) или skipped с причиной: already_running, no_gc, no_saved_login. ignoredIds — то, что отфильтровано по пати. Задания живут 30 минут.',
          params: [['jobId', 'путь', 'string', 'id из ответа 202.']],
          response: '{ id, kind, status, createdAt, startedAt, finishedAt, progress, result: { requested, launched, skipped, failed, ignoredIds, items } }.',
          example: 'GET /jobs/job_1abc',
          exampleBody: null
        }
      ]
    },
    {
      id: 'export',
      title: 'Выгрузки',
      summary: 'Готовые файлы CSV и JSON — по одной команде, без разбора JSON.',
      methods: [
        {
          id: 'export',
          method: 'GET',
          path: '/export/{набор}.{csv|json}',
          scope: 'чтение',
          summary: 'Скачать список файлом: characters, parties, marathons, windows, planner, finance.',
          description:
            'Ответ приходит вложением: Content-Disposition: attachment; filename="tvinoferma_characters_2026-11-25.csv". CSV — с «;» и BOM: Excel на русской локали открывает без настройки кодировки. Значения с «;», кавычками и переводами строк экранируются по RFC 4180. Формат задаётся суффиксом или ?format=csv|json; txt — тот же CSV. Секреты в выгрузку не попадают никогда.',
          params: [
            ['набор', 'путь', 'string', 'characters | parties | marathons | windows | planner | finance'],
            ['format', 'query', 'string', 'csv (по умолчанию) | json | txt'],
            ['party, fields', 'query', 'string', 'Те же фильтры, что у GET /characters.']
          ],
          response: 'Файл. Для JSON-клиента в теле сводка: { dataset, format, rows, fileName }.',
          example: 'GET /export/characters.csv',
          exampleBody: null
        }
      ]
    }
  ];

  // Какие поля существуют — для подсказок на странице.
  const fieldLists = {
    stats: STATS.map(([key, label]) => ({ key, label })),
    passes: PASSES.map(([key, label, ru]) => ({ key, label, ru }))
  };

  window.TF_API_DOCS = { groups, fieldLists };
})();

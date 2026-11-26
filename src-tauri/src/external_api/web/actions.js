// Модель действий страницы API: что можно нажать и что при этом уйдёт на сервер.
//
// Зачем отдельный файл: страница должна быть не только справочником, но и
// консолью — «изменить статы», «запустить пати», «выгрузить CSV». Если описывать
// такие действия разметкой, они разъедутся с контрактом: обработчик забудет поле,
// форма — подтверждение. Поэтому действие описано данными, а разметку и запрос
// строит app.js по этому описанию. Проверка соответствия — tests/externalApiActions.test.js.
//
// Формат действия:
//   {
//     id, title, summary, group, method, path,
//     scope: 'read' | 'modify' | 'launchClose',
//     danger?: true,            // требует подтверждения перед отправкой
//     confirmText?: string,     // что показываем в подтверждении
//     fields: [{ name, label, type, required?, hint?, default?, options?, example? }],
//     body?: (values) => object | undefined,   // тело запроса из значений формы
//     query?: (values) => string,              // ?… для GET
//     pathOf?: (values) => string,             // подстановка {id} и подобных
//     result?: (body, values) => string        // короткая строка «что получилось»
//   }
//
// Типы полей: text, number, select, list (через запятую → массив), checkbox,
// date, character (выбор из загруженных персонажей), party (выбор пати),
// window (PID из запущенных окон).

(() => {
  'use strict';

  /** Поле-выбор персонажа: варианты приходят из GET /characters. */
  const CHARACTER = 'character';
  /** Поле-выбор пати: варианты приходят из GET /parties. */
  const PARTY = 'party';

  /** Число из поля формы: пустая строка — «не задано». */
  const num = value => (value === '' || value === null || value === undefined ? undefined : Number(value));
  /** Список id через запятую или пробел. */
  const list = value =>
    String(value || '')
      .split(/[,\s]+/)
      .map(item => item.trim())
      .filter(Boolean);

  const actions = [
    /* ---------------------------------- данные --------------------------------- */
    {
      id: 'list-characters',
      group: 'Чтение данных',
      title: 'Все персонажи',
      summary: 'Все персонажи по id: класс, уровень, проходки — без двух десятков статов на каждого.',
      method: 'GET',
      path: '/api/v1/characters',
      scope: 'read',
      fields: [
        {
          name: 'fields',
          label: 'Поля',
          type: 'text',
          hint: 'Через запятую; вложенные — через точку. Пусто — список без статов, заметок и истории монет.',
          default: ''
        },
        { name: 'lang', label: 'Подписи', type: 'select', options: ['en', 'ru'], default: 'en' },
        { name: 'sort', label: 'Сортировка', type: 'select', options: ['id', 'nick', 'level', 'none'], default: 'id' },
        { name: 'order', label: 'Порядок', type: 'select', options: ['asc', 'desc'], default: 'asc' },
        { name: 'party', label: 'Только пати', type: PARTY },
        { name: 'flat', label: 'Плоские ключи', type: 'checkbox', default: true },
        {
          name: 'full',
          label: 'Полные карточки',
          type: 'checkbox',
          hint: 'Со статами, заметками и историей монет — ответ втрое длиннее.'
        }
      ],
      query: values => {
        const params = new URLSearchParams();
        if (values.fields) params.set('fields', values.fields);
        // `full` — только когда попросили: по умолчанию список лёгкий.
        if (values.full === true || values.full === 'true') params.set('full', 'true');
        if (values.lang && values.lang !== 'en') params.set('lang', values.lang);
        if (values.sort && values.sort !== 'id') params.set('sort', values.sort);
        if (values.order && values.order !== 'asc') params.set('order', values.order);
        if (values.party) params.set('party', values.party);
        if (values.flat === false) params.set('flat', 'false');
        const text = params.toString();
        return text ? `?${text}` : '';
      },
      result: body => `${body.count} персонаж(ей); поля: ${(body.fields || ['все']).join(', ')}`
    },
    {
      id: 'character-card',
      group: 'Чтение данных',
      title: 'Карточка персонажа',
      summary: 'Всё про одного персонажа: статы, проходки, окно игры.',
      method: 'GET',
      path: '/api/v1/characters/{id}',
      scope: 'read',
      fields: [{ name: 'id', label: 'Персонаж', type: CHARACTER, required: true }],
      pathOf: values => `/api/v1/characters/${encodeURIComponent(values.id)}`,
      result: body => `${body.character?.nick || body.character?.id}: уровень ${body.character?.level ?? '—'}`
    },
    {
      id: 'character-stats',
      group: 'Чтение данных',
      title: 'Все статы',
      summary: 'Статы с русскими подписями — список, а не сплошной объект.',
      method: 'GET',
      path: '/api/v1/characters/{id}/stats',
      scope: 'read',
      fields: [{ name: 'id', label: 'Персонаж', type: CHARACTER, required: true }],
      pathOf: values => `/api/v1/characters/${encodeURIComponent(values.id)}/stats`,
      result: body => `${body.count} статов у ${body.character?.nick || body.character?.id}`
    },
    {
      id: 'character-passes',
      group: 'Чтение данных',
      title: 'Проходки',
      summary: 'Оружие, доспех, реликвия и сумма — по одному или все сразу.',
      method: 'GET',
      path: '/api/v1/characters/{id}/dungeon-passes',
      scope: 'read',
      fields: [{ name: 'id', label: 'Персонаж', type: CHARACTER, required: true }],
      pathOf: values => `/api/v1/characters/${encodeURIComponent(values.id)}/dungeon-passes`,
      result: body => `сумма проходок: ${body.total ?? '—'}`
    },
    {
      // Один стат и одна проходка — отдельными карточками: внешнему клиенту (и `tf`)
      // дешевле читать нужное поле, чем разбирать весь объект. Маршрут для этого есть,
      // не хватало описания в каталоге.
      id: 'character-stat',
      group: 'Чтение данных',
      title: 'Один стат',
      summary: 'Значение одного стата с подписью: дешевле, чем читать все статы.',
      method: 'GET',
      path: '/api/v1/characters/{id}/stats/{stat}',
      scope: 'read',
      fields: [
        { name: 'id', label: 'Персонаж', type: CHARACTER, required: true },
        { name: 'stat', label: 'Стат', type: 'select', required: true, options: ['hp', 'mp', 'endurance', 'strength', 'agility', 'intelligence'] }
      ],
      pathOf: values => `/api/v1/characters/${encodeURIComponent(values.id)}/stats/${encodeURIComponent(values.stat)}`,
      result: body => `${body.label || body.stat}: ${body.value ?? '—'}`
    },
    {
      id: 'character-pass',
      group: 'Чтение данных',
      title: 'Одна проходка',
      summary: 'Оружие, доспех или реликвия: значение, остаток и максимум.',
      method: 'GET',
      path: '/api/v1/characters/{id}/dungeon-passes/{pass}',
      scope: 'read',
      fields: [
        { name: 'id', label: 'Персонаж', type: CHARACTER, required: true },
        { name: 'pass', label: 'Проходка', type: 'select', required: true, options: ['weapon', 'armor', 'relic'] }
      ],
      pathOf: values =>
        `/api/v1/characters/${encodeURIComponent(values.id)}/dungeon-passes/${encodeURIComponent(values.pass)}`,
      result: body => `${body.nick || body.id}: ${body.label || body.pass} — ${body.value ?? '—'}`
    },
    {
      id: 'list-parties',
      group: 'Чтение данных',
      title: 'Пати с составом',
      summary: 'Кто в какой пати и в каком порядке запускается.',
      method: 'GET',
      path: '/api/v1/parties',
      scope: 'read',
      fields: [],
      result: body => `${(body.parties || []).length} пати`
    },
    {
      id: 'party-card',
      group: 'Чтение данных',
      title: 'Одна пати',
      summary: 'Состав и порядок запуска пати по её id.',
      method: 'GET',
      path: '/api/v1/parties/{id}',
      scope: 'read',
      fields: [{ name: 'id', label: 'Пати', type: PARTY, required: true }],
      pathOf: values => `/api/v1/parties/${encodeURIComponent(values.id)}`,
      result: body => `${body.party?.name || body.party?.id}: ${(body.party?.members || []).length} участников`
    },
    {
      id: 'list-marathons',
      group: 'Чтение данных',
      title: 'Марафоны',
      summary: 'Задания, прогресс по персонажам и итоги.',
      method: 'GET',
      path: '/api/v1/marathons',
      scope: 'read',
      fields: [],
      result: body => `${(body.marathons || []).length} марафон(ов)`
    },
    {
      id: 'marathon-card',
      group: 'Чтение данных',
      title: 'Один марафон',
      summary: 'Задания, прогресс и итоги одного марафона — без разбора всего списка.',
      method: 'GET',
      path: '/api/v1/marathons/{id}',
      scope: 'read',
      fields: [{ name: 'id', label: 'Марафон', type: 'text', required: true, hint: 'id из «Марафоны».' }],
      pathOf: values => `/api/v1/marathons/${encodeURIComponent(values.id)}`,
      result: body =>
        `${body.marathon?.title || body.marathon?.id}: ${(body.marathon?.tasks || []).length} заданий, ` +
        `${(body.marathon?.participantIds || []).length} участников`
    },
    {
      id: 'marathon-participants',
      group: 'Чтение данных',
      title: 'Участники марафона',
      summary: 'Кто участвует и что у каждого по заданиям.',
      method: 'GET',
      path: '/api/v1/marathons/{id}/participants',
      scope: 'read',
      fields: [{ name: 'id', label: 'Марафон', type: 'text', required: true }],
      pathOf: values => `/api/v1/marathons/${encodeURIComponent(values.id)}/participants`,
      result: body => `${(body.characters || []).length} участников, ${(body.parties || []).length} пати`
    },
    {
      id: 'list-windows',
      group: 'Чтение данных',
      title: 'Окна игры',
      summary: 'Запущенные окна: PID, заголовок, к какому персонажу относятся.',
      method: 'GET',
      path: '/api/v1/windows',
      scope: 'read',
      fields: [],
      result: body => `${(body.windows || []).length} окон`
    },
    {
      id: 'planner',
      group: 'Чтение данных',
      title: 'Планировщик',
      summary: 'Что запланировано: задачи, сроки, назначения.',
      method: 'GET',
      path: '/api/v1/planner',
      scope: 'read',
      fields: []
    },
    {
      id: 'finance',
      group: 'Чтение данных',
      title: 'Учёт финансов',
      summary: 'Доходы и расходы по персонажам и пати.',
      method: 'GET',
      path: '/api/v1/finance',
      scope: 'read',
      fields: []
    },
    {
      id: 'health',
      group: 'Чтение данных',
      title: 'Жив ли сервер',
      summary: 'Версия, сборка, включённые права, доступна ли запись и занят ли запуск.',
      method: 'GET',
      path: '/api/v1/health',
      scope: 'read',
      fields: [],
      result: body =>
        `${body.app?.version || '?'} (${body.app?.build || '?'}); права: ` +
        `${Object.entries(body.scopes || {}).filter(([, on]) => on).map(([name]) => name).join(', ') || 'нет'}; ` +
        `запуск: ${body.launch?.busy ? 'занят' : 'свободен'}`
    },
    {
      id: 'status',
      group: 'Чтение данных',
      title: 'Сводка «как дела»',
      summary: 'Один запрос: счётчики, дела на сегодня, баланс, права и занятость запуска.',
      method: 'GET',
      path: '/api/v1/status',
      scope: 'read',
      fields: [],
      result: body =>
        `персонажей: ${body.counts?.characters ?? 0}; окон: ${body.counts?.windows ?? 0}; ` +
        `дел на сегодня: ${body.today?.done ?? 0} из ${body.today?.total ?? 0}`
    },
    {
      id: 'audit',
      group: 'Чтение данных',
      title: 'Журнал вызовов',
      summary: 'Последние 100 запросов к API: время, путь, код.',
      method: 'GET',
      path: '/api/v1/audit',
      scope: 'read',
      fields: [],
      result: body => `${(body.entries || body.log || []).length} записей`
    },

    /* -------------------------------- изменения -------------------------------- */
    {
      id: 'set-stat',
      group: 'Изменение данных',
      title: 'Изменить стат',
      summary: 'Поставить значение, прибавить или отнять. История «было → стало» сохраняется.',
      method: 'PATCH',
      path: '/api/v1/characters/{id}/stats/{stat}',
      scope: 'modify',
      fields: [
        { name: 'id', label: 'Персонаж', type: CHARACTER, required: true },
        {
          name: 'stat',
          label: 'Стат',
          type: 'select',
          required: true,
          options: [
            'hp',
            'mp',
            'physAttack',
            'magAttack',
            'physDefense',
            'magDefense',
            'critChance',
            'critDamage',
            'atkSpeed',
            'evasion',
            'accuracy',
            'pa',
            'pz',
            'morale',
            'pvePa',
            'pvePz',
            'physPenetration',
            'magPenetration',
            'endurance',
            'intelligence',
            'strength',
            'agility',
            'levelBonus'
          ]
        },
        { name: 'mode', label: 'Что сделать', type: 'select', options: ['set', 'inc', 'dec'], default: 'set' },
        { name: 'value', label: 'Значение', type: 'number', required: true, hint: 'Для «поставить» — новое, для «прибавить/отнять» — на сколько.' }
      ],
      pathOf: values =>
        `/api/v1/characters/${encodeURIComponent(values.id)}/stats/${encodeURIComponent(values.stat)}`,
      body: values =>
        values.mode && values.mode !== 'set'
          ? { mode: values.mode, by: num(values.value) ?? 1 }
          : { value: num(values.value) ?? 0 },
      confirmText: values => `Изменить «${values.stat}» у ${values.id}: ${values.mode === 'set' ? 'поставить' : values.mode === 'inc' ? 'прибавить' : 'отнять'} ${values.value}?`,
      // Ответ: { id, nick, stat, value, before, changed }.
      result: body => `${body.stat || 'стат'}: ${body.before ?? '—'} → ${body.value ?? '—'}${body.changed === false ? ' (без изменений)' : ''}`
    },
    {
      id: 'set-pass',
      group: 'Изменение данных',
      title: 'Изменить проходки',
      summary: 'Оружие, доспех или реликвия — одно целое число.',
      method: 'PATCH',
      path: '/api/v1/characters/{id}/dungeon-passes/{pass}',
      scope: 'modify',
      fields: [
        { name: 'id', label: 'Персонаж', type: CHARACTER, required: true },
        { name: 'pass', label: 'Проходка', type: 'select', options: ['weapon', 'armor', 'relic'], default: 'weapon' },
        { name: 'value', label: 'Значение', type: 'number', required: true }
      ],
      pathOf: values =>
        `/api/v1/characters/${encodeURIComponent(values.id)}/dungeon-passes/${encodeURIComponent(values.pass)}`,
      body: values => ({ value: num(values.value) ?? 0 }),
      confirmText: values => `Поставить проходку «${values.pass}» = ${values.value} у ${values.id}?`,
      // Ответ: { id, nick, pass, value, before, changed, dungeonPasses, total }.
      result: body => `${body.pass || 'проходка'}: ${body.before ?? '—'} → ${body.value ?? '—'}, сумма ${body.total ?? '—'}`
    },
    {
      id: 'bulk-pass',
      group: 'Изменение данных',
      title: 'Проходки сразу нескольким',
      summary: 'Один запрос на 1…100 персонажей: удобно после фарм-забега.',
      method: 'POST',
      path: '/api/v1/characters/bulk-update',
      scope: 'modify',
      danger: true,
      fields: [
        {
          name: 'ids',
          label: 'Персонажи',
          type: 'list',
          required: true,
          hint: 'id через запятую или пробел.',
          example: 'Mag_1,Luchnik_2'
        },
        { name: 'pass', label: 'Проходка', type: 'select', options: ['weapon', 'armor', 'relic'], default: 'weapon' },
        { name: 'value', label: 'Значение', type: 'number', required: true }
      ],
      body: values => ({
        ids: list(values.ids),
        patch: { dungeonPasses: { [values.pass]: num(values.value) ?? 0 } }
      }),
      confirmText: values => `Поставить «${values.pass}» = ${values.value} для ${list(values.ids).length} персонаж(ей)?`,
      // Ответ: { updated: [{ id, nick, changed: [...] }, …] }.
      result: body => {
        const rows = Array.isArray(body.updated) ? body.updated : [];
        const changed = rows.filter(row => (row.changed || []).length).length;
        return `обновлено: ${rows.length}, из них изменено: ${changed}`;
      }
    },
    {
      id: 'patch-character',
      group: 'Изменение данных',
      title: 'Поля карточки',
      summary: 'Ник, класс, уровень, заметки, теги — только заполненные поля.',
      method: 'PATCH',
      path: '/api/v1/characters/{id}',
      scope: 'modify',
      fields: [
        { name: 'id', label: 'Персонаж', type: CHARACTER, required: true },
        { name: 'nick', label: 'Ник', type: 'text' },
        { name: 'class', label: 'Класс', type: 'text' },
        { name: 'level', label: 'Уровень', type: 'number' },
        { name: 'notes', label: 'Заметки', type: 'text' },
        { name: 'tags', label: 'Теги', type: 'list', hint: 'Через запятую.' }
      ],
      pathOf: values => `/api/v1/characters/${encodeURIComponent(values.id)}`,
      body: values => {
        const patch = {};
        if (values.nick) patch.nick = values.nick;
        if (values.class) patch.class = values.class;
        if (num(values.level) !== undefined) patch.level = num(values.level);
        if (values.notes) patch.notes = values.notes;
        if (values.tags) patch.tags = list(values.tags);
        return patch;
      },
      confirmText: values => `Изменить карточку ${values.id}?`,
      result: body => `обновлён ${body.character?.nick || body.character?.id || 'персонаж'}`
    },
    {
      id: 'create-character',
      group: 'Изменение данных',
      title: 'Создать персонажа',
      summary: 'Обязателен только ник; id придумает приложение.',
      method: 'POST',
      path: '/api/v1/characters',
      scope: 'modify',
      fields: [
        { name: 'nick', label: 'Ник', type: 'text', required: true },
        { name: 'class', label: 'Класс', type: 'text' },
        { name: 'level', label: 'Уровень', type: 'number' }
      ],
      body: values => {
        const body = { nick: values.nick };
        if (values.class) body.class = values.class;
        if (num(values.level) !== undefined) body.level = num(values.level);
        return body;
      },
      confirmText: values => `Создать персонажа «${values.nick}»?`,
      result: body => `создан ${body.character?.id || 'персонаж'}${body.duplicateNick ? ' (ник уже был)' : ''}`
    },
    {
      id: 'rename-party',
      group: 'Изменение данных',
      title: 'Переименовать пати',
      summary: 'Название и цвет пати.',
      method: 'PATCH',
      path: '/api/v1/parties/{id}',
      scope: 'modify',
      fields: [
        { name: 'id', label: 'Пати', type: PARTY, required: true },
        { name: 'name', label: 'Новое название', type: 'text', required: true },
        { name: 'color', label: 'Цвет', type: 'text', hint: 'Например #6e8ef8. Пусто — не менять.' }
      ],
      pathOf: values => `/api/v1/parties/${encodeURIComponent(values.id)}`,
      body: values => {
        const body = { name: values.name };
        if (values.color) body.color = values.color;
        return body;
      },
      confirmText: values => `Переименовать пати ${values.id} в «${values.name}»?`,
      result: body => `пати ${body.party?.name || body.party?.id || 'обновлена'}`
    },
    {
      id: 'marathon-mark',
      group: 'Изменение данных',
      title: 'Отметка в марафоне',
      summary: 'Поставить или снять день задания у участника.',
      method: 'POST',
      path: '/api/v1/marathons/{id}/marks',
      scope: 'modify',
      fields: [
        { name: 'id', label: 'Марафон', type: 'text', required: true, hint: 'id марафона из списка.' },
        { name: 'characterId', label: 'Персонаж', type: CHARACTER, required: true },
        { name: 'taskId', label: 'Задание', type: 'text', required: true },
        { name: 'date', label: 'Дата', type: 'date', required: true },
        { name: 'marked', label: 'Поставить (иначе — снять)', type: 'checkbox', default: true }
      ],
      pathOf: values => `/api/v1/marathons/${encodeURIComponent(values.id)}/marks`,
      body: values => ({
        characterId: values.characterId,
        taskId: values.taskId,
        date: values.date,
        marked: values.marked !== false
      }),
      confirmText: values => `${values.marked === false ? 'Снять' : 'Поставить'} отметку ${values.date} у ${values.characterId}?`,
      result: body => `отметка ${body.marked === false ? 'снята' : 'поставлена'}`
    },
    {
      id: 'marathon-adjust',
      group: 'Изменение данных',
      title: 'Поправка марафона',
      summary: 'Ручная поправка прогресса задания.',
      method: 'POST',
      path: '/api/v1/marathons/{id}/adjust',
      scope: 'modify',
      fields: [
        { name: 'id', label: 'Марафон', type: 'text', required: true },
        { name: 'characterId', label: 'Персонаж', type: CHARACTER, required: true },
        { name: 'taskId', label: 'Задание', type: 'text', required: true },
        { name: 'value', label: 'Поправка', type: 'number', required: true }
      ],
      pathOf: values => `/api/v1/marathons/${encodeURIComponent(values.id)}/adjust`,
      body: values => ({
        characterId: values.characterId,
        taskId: values.taskId,
        value: num(values.value) ?? 0
      }),
      confirmText: values => `Поправка ${values.value} для ${values.characterId} в задании ${values.taskId}?`,
      result: body => `поправка: ${body.value ?? body.adjust ?? '—'}`
    },
    {
      id: 'planner-entry',
      group: 'Изменение данных',
      title: 'Задача в планировщике',
      summary: 'Отметить выполненной, перенести на другой день, поправить название и заметку.',
      method: 'PATCH',
      path: '/api/v1/planner/entries/{id}',
      scope: 'modify',
      fields: [
        { name: 'id', label: 'Запись', type: 'text', required: true, hint: 'id из «Планировщика».' },
        {
          name: 'status',
          label: 'Статус',
          type: 'select',
          options: ['todo', 'doing', 'done'],
          default: 'done'
        },
        {
          name: 'date',
          label: 'День статуса',
          type: 'date',
          hint: 'Для повтора — конкретный день; пусто — день самой записи.'
        },
        { name: 'moveToDate', label: 'Перенести на', type: 'date', hint: 'Пусто — не переносить.' },
        { name: 'title', label: 'Название', type: 'text' },
        { name: 'time', label: 'Время', type: 'text', hint: 'ЧЧ:ММ' }
      ],
      pathOf: values => `/api/v1/planner/entries/${encodeURIComponent(values.id)}`,
      body: values => {
        const body = { status: values.status || 'done' };
        if (values.date) body.date = values.date;
        if (values.moveToDate) body.moveToDate = values.moveToDate;
        if (values.title) body.title = values.title;
        if (values.time) body.time = values.time;
        return body;
      },
      result: body => `изменено: ${(body.changed || []).join(', ') || 'ничего'}`
    },
    {
      id: 'planner-add',
      group: 'Изменение данных',
      title: 'Новая задача',
      summary: 'Добавить запись в календарь планировщика.',
      method: 'POST',
      path: '/api/v1/planner/entries',
      scope: 'modify',
      fields: [
        { name: 'title', label: 'Название', type: 'text', required: true },
        { name: 'date', label: 'Дата', type: 'date' },
        { name: 'time', label: 'Время', type: 'text', hint: 'ЧЧ:ММ' },
        { name: 'durationMinutes', label: 'Длительность, мин', type: 'number' },
        {
          name: 'kind',
          label: 'Тип',
          type: 'select',
          options: ['task', 'event', 'note'],
          default: 'task'
        },
        {
          name: 'priority',
          label: 'Приоритет',
          type: 'select',
          options: ['low', 'normal', 'high'],
          default: 'normal'
        },
        {
          name: 'recurrence',
          label: 'Повтор',
          type: 'select',
          options: ['none', 'daily', 'weekly', 'monthly'],
          default: 'none'
        },
      ],
      body: values => {
        const body = { title: String(values.title || '').trim() };
        if (values.date) body.date = values.date;
        if (values.time) body.time = values.time;
        if (values.durationMinutes !== '') body.durationMinutes = num(values.durationMinutes);
        if (values.kind) body.kind = values.kind;
        if (values.priority) body.priority = values.priority;
        if (values.recurrence) body.recurrence = values.recurrence;
        return body;
      },
      result: body => `создано: ${body.entry?.title || '—'}`
    },
    {
      id: 'finance-operation',
      group: 'Изменение данных',
      title: 'Запись в реестр денег',
      summary: 'Приход или расход: сумма, валюта, комментарий.',
      method: 'POST',
      path: '/api/v1/finance/operations',
      scope: 'modify',
      fields: [
        { name: 'kind', label: 'Тип', type: 'select', options: ['in', 'out'], default: 'out' },
        { name: 'amount', label: 'Сумма', type: 'number', required: true },
        { name: 'currency', label: 'Валюта', type: 'select', options: ['gold', 'coins'], default: 'gold' },
        { name: 'date', label: 'Дата', type: 'date' },
        { name: 'counterparty', label: 'Контрагент', type: 'text' },
        { name: 'note', label: 'Комментарий', type: 'text' }
      ],
      body: values => {
        const body = { kind: values.kind || 'out', amount: num(values.amount) ?? 0 };
        if (values.currency) body.currency = values.currency;
        if (values.date) body.date = values.date;
        if (values.counterparty) body.counterparty = values.counterparty;
        if (values.note) body.note = values.note;
        return body;
      },
      confirmText: values =>
        `Записать ${values.kind === 'in' ? 'приход' : 'расход'} ${values.amount} ${values.currency || 'gold'}?`,
      result: body => `${body.operation?.kind === 'in' ? 'приход' : 'расход'} ${body.operation?.amount ?? '—'}`
    },

    /* ------------------------------ запуск и окна ------------------------------ */
    {
      id: 'launch-character',
      group: 'Запуск и окна',
      title: 'Запустить персонажа',
      summary: 'Открыть одно окно игры. Ответ — 202 и номер задания.',
      method: 'POST',
      path: '/api/v1/launch/character',
      scope: 'launchClose',
      fields: [{ name: 'characterId', label: 'Персонаж', type: CHARACTER, required: true }],
      body: values => ({ characterId: values.characterId }),
      confirmText: values => `Запустить окно для ${values.characterId}?`,
      result: body => `задание: ${body.jobId || '—'}`
    },
    {
      id: 'launch-party',
      group: 'Запуск и окна',
      title: 'Запустить пати',
      summary: 'Вся пати в сохранённом порядке — или выбранные участники.',
      method: 'POST',
      path: '/api/v1/launch/party',
      scope: 'launchClose',
      fields: [
        { name: 'partyId', label: 'Пати', type: PARTY, required: true },
        { name: 'memberIds', label: 'Только эти участники', type: 'list', hint: 'Пусто — вся пати.', example: 'Mag_1' }
      ],
      body: values => {
        const body = { partyId: values.partyId };
        if (values.memberIds) body.memberIds = list(values.memberIds);
        return body;
      },
      confirmText: values => `Запустить пати ${values.partyId}?`,
      result: body => `задание: ${body.jobId || '—'}`
    },
    {
      id: 'launch-selection',
      group: 'Запуск и окна',
      title: 'Запустить выбранных',
      summary: 'Персонажи из разных пати в указанном порядке.',
      method: 'POST',
      path: '/api/v1/launch/selection',
      scope: 'launchClose',
      fields: [
        {
          name: 'characterIds',
          label: 'Персонажи',
          type: 'list',
          required: true,
          hint: 'Через запятую, порядок сохраняется.',
          example: 'Mag_1,Luchnik_2'
        }
      ],
      body: values => ({ characterIds: list(values.characterIds) }),
      confirmText: values => `Запустить ${list(values.characterIds).length} персонаж(ей)?`,
      result: body => `задание: ${body.jobId || '—'}`
    },
    {
      id: 'close-windows',
      group: 'Запуск и окна',
      title: 'Закрыть окна',
      summary: 'Только по PID из списка окон; без confirm не сработает.',
      method: 'POST',
      path: '/api/v1/windows/close',
      scope: 'launchClose',
      danger: true,
      fields: [
        {
          name: 'pids',
          label: 'PID окон',
          type: 'list',
          required: true,
          hint: 'Через запятую, из «Окна игры».',
          example: '4321,99'
        }
      ],
      body: values => ({ pids: list(values.pids).map(Number), confirm: true }),
      confirmText: values => `Закрыть ${list(values.pids).length} окно(окон)? Несохранённый прогресс игры потеряется.`,
      result: body => `закрыто: ${(body.closed || []).length}`
    },
    {
      id: 'job-status',
      group: 'Запуск и окна',
      title: 'Состояние задания',
      summary: 'Прогресс запуска и итог с причинами пропуска.',
      method: 'GET',
      path: '/api/v1/jobs/{jobId}',
      scope: 'read',
      fields: [
        { name: 'jobId', label: 'Задание', type: 'text', required: true, hint: 'jobId из ответа на запуск.', example: 'job_8f2c1a' }
      ],
      pathOf: values => `/api/v1/jobs/${encodeURIComponent(values.jobId)}`,
      result: body => `${body.job?.state || '—'}${body.job?.done ? ' (готово)' : ''}`
    },

    /* --------------------------------- выгрузки -------------------------------- */
    {
      id: 'export',
      group: 'Выгрузки',
      title: 'Выгрузить в файл',
      summary: 'CSV (с «;» и BOM — Excel открывает без настройки) или JSON.',
      method: 'GET',
      path: '/api/v1/export/{set}.{format}',
      scope: 'read',
      fields: [
        {
          name: 'set',
          label: 'Что выгрузить',
          type: 'select',
          required: true,
          options: ['characters', 'parties', 'marathons', 'windows', 'planner', 'finance']
        },
        { name: 'format', label: 'Формат', type: 'select', options: ['csv', 'json'], default: 'csv' },
        { name: 'party', label: 'Только пати', type: PARTY }
      ],
      pathOf: values => `/api/v1/export/${values.set}.${values.format || 'csv'}`,
      query: values => (values.party ? `?party=${encodeURIComponent(values.party)}` : ''),
      result: body => (typeof body === 'string' ? `получено ${body.length} символов` : 'файл получен')
    }
  ];

  window.TF_API_ACTIONS = actions;
})();

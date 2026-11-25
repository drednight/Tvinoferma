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
//     fields: [{ name, label, type, required?, hint?, default?, options? }],
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
      summary: 'Список по id с классом, уровнем и проходками — один запрос вместо десяти.',
      method: 'GET',
      path: '/api/v1/characters',
      scope: 'read',
      fields: [
        {
          name: 'fields',
          label: 'Поля',
          type: 'text',
          hint: 'Через запятую; вложенные — через точку. Пусто — полная карточка.',
          default: 'id,class,level,dungeonPasses'
        },
        { name: 'lang', label: 'Подписи', type: 'select', options: ['en', 'ru'], default: 'en' },
        { name: 'sort', label: 'Сортировка', type: 'select', options: ['id', 'nick', 'level', 'none'], default: 'id' },
        { name: 'order', label: 'Порядок', type: 'select', options: ['asc', 'desc'], default: 'asc' },
        { name: 'party', label: 'Только пати', type: PARTY },
        { name: 'flat', label: 'Плоские ключи', type: 'checkbox', default: true }
      ],
      query: values => {
        const params = new URLSearchParams();
        if (values.fields) params.set('fields', values.fields);
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
        { name: 'ids', label: 'Персонажи', type: 'list', required: true, hint: 'id через запятую или пробел.' },
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
        { name: 'memberIds', label: 'Только эти участники', type: 'list', hint: 'Пусто — вся пати.' }
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
      fields: [{ name: 'characterIds', label: 'Персонажи', type: 'list', required: true, hint: 'Через запятую, порядок сохраняется.' }],
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
      fields: [{ name: 'pids', label: 'PID окон', type: 'list', required: true, hint: 'Через запятую, из «Окна игры».' }],
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
      fields: [{ name: 'jobId', label: 'Задание', type: 'text', required: true, hint: 'jobId из ответа на запуск.' }],
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

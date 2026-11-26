# Справочник API Твинофермы

Полный список методов внешнего API: адрес, токен, права, лимиты, а затем каждый
метод с параметрами, ответом и примером. Это **справочник**; зачем API нужен и
как устроен — в [`EXTERNAL-API.md`](EXTERNAL-API.md). Интерактивная версия этого
же справочника — на странице `http://127.0.0.1:47831/` (вкладка «Справочник API»):
у каждого метода там своя панель запроса — «▶ Выполнить» отправляет его прямо из
карточки и печатает ответ под кнопками, «→ в тестовую строку» переносит запрос во
вкладку «Тестовый запрос».

- [Начало работы](#начало-работы)
  - [Базовый адрес](#базовый-адрес)
  - [Заголовки и аутентификация](#заголовки-и-аутентификация)
  - [Права (scopes)](#права-scopes)
  - [Лимиты и размеры](#лимиты-и-размеры)
  - [Формат ошибок](#формат-ошибок)
  - [Справочники полей](#справочники-полей)
- [Методы](#методы)
  - [Состояние и журнал](#состояние-и-журнал)
  - [Персонажи](#персонажи)
  - [Статы и проходки по отдельности](#статы-и-проходки-по-отдельности)
  - [Пати](#пати)
  - [Марафоны](#марафоны)
  - [Планировщик и учёт](#планировщик-и-учёт)
  - [Окна игры](#окна-игры)
  - [Запуск и задания](#запуск-и-задания)
  - [Выгрузки](#выгрузки)
- [Памятка: что можно делать](#памятка-что-можно-делать)

---

## Начало работы

### Базовый адрес

```
http://127.0.0.1:47831/api/v1
```

Сервер поднимает само приложение и слушает только `127.0.0.1` — с других
компьютеров и по сети он недоступен. Порт по умолчанию `47831`, меняется в
**Настройки → 🔌 Внешний API**. Пока приложение закрыто, сервера нет.

### Заголовки и аутентификация

| Заголовок | Обязателен | Зачем |
| --- | --- | --- |
| `Authorization: Bearer <токен>` | да | Токен из настроек: 64 hex-символа. Без него — `401 unauthorized` |
| `Content-Type: application/json` | для `POST`/`PATCH` | Иначе — `415 unsupported_media_type` |
| `Accept: application/json` | нет | Влияния не оказывает, ответ всегда JSON (кроме выгрузок) |

Где взять токен: «Настройки → 🔌 Внешний API». Кнопка **«Скопировать токен»**
кладёт значение в буфер обмена, **«Показать токен»** выводит его на минуту — обе только
читают запись из хранилища учётных данных ОС и ничего не меняют, поэтому копировать
можно сколько угодно раз. **«Перевыпустить токен»** нужен, только если значение утекло:
он меняет токен, и все уже настроенные программы получат `401` до перенастройки.
Значение живёт в хранилище ОС — в `state.json`, резервных копиях и `logs/api.jsonl`
его нет и попасть туда оно не может.

Токен проверяется **до** чтения тела. Заголовок `Host` тоже проверяется
(защита от DNS rebinding): допустимы только `127.0.0.1:<порт>` и
`localhost:<порт>`, иначе — `403 forbidden_host`. CORS-заголовков нет:
POST/PATCH из чужой вкладки браузера не пройдут.

Проверка связи с токеном:

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" \
  http://127.0.0.1:47831/api/v1/health
```

### Права (scopes)

Три галочки в настройках. Право проверяется и в Rust, и в мосте.

| Право | Что открывает | По умолчанию |
| --- | --- | --- |
| Чтение | `/characters*`, `/parties*`, `/marathons*`, `/planner`, `/finance`, `/windows`, `/export/*`, `/jobs/*`, `/health`, `/audit` | **включено** |
| Изменение статов и проходок | `PATCH /characters*`, `POST /characters*`, `PATCH /parties/*`, `POST /marathons/*/{marks,adjust}` | выключено |
| Запуск и закрытие окон | `/launch/*`, `/windows/close` | выключено |

Выключенное право — `403 forbidden_scope`, **данные не меняются**. Текущие права
видны в `GET /health → scopes`.

### Лимиты и размеры

| Ограничение | Значение | Ответ при превышении |
| --- | --- | --- |
| Частота | 60 запросов в минуту, окно 60 с | `429 too_many_requests` + `Retry-After` |
| Соединения | 16 одновременно | `503 too_many_connections` |
| Заголовки запроса | 16 КиБ | `413 payload_too_large` |
| Тело запроса | 64 КиБ | `413 payload_too_large` |
| Ответ выгрузки | 64 КиБ на файл | — (фильтруйте `party`) |
| Запуск окон | одно задание одновременно | `429 launch_busy` |
| Запрос без тела целиком | 5 с | `408 timeout` |
| Ответ JS на запрос | 15 с | `504 timeout` (Rust) |

### Формат ошибок

Все ошибки одинаковы, у любой есть машиночитаемый код и объяснение по-русски:

```json
{
  "error": {
    "code": "invalid_value",
    "message": "Неизвестные поля: hp, mana. Допустимые: id, nick, class, …"
  }
}
```

* `error.code` — короткий код латиницей, по нему ветвятся программы. Состав кодов
  не меняется между версиями API; новые коды добавляются, старые не переименовываются.
* `error.message` — текст для человека. Его можно показывать, но не разбирать: он
  может уточняться между версиями.

Один и тот же формат даёт и JS-мост, и HTTP-слой Rust — в том числе для ошибок
транспорта и перегрузки. Тело ошибки никогда не содержит секретов и путей.

#### Все коды

Столбиком — по одному коду на строку, чтобы каждый было видно отдельно:

| HTTP | `code` | Подпись | Что сделать |
| --- | --- | --- | --- |
| 400 | `bad_request` | Некорректный запрос | Строка запроса не похожа на HTTP. |
| 400 | `confirm_required` | Нужно подтверждение | Добавьте {"confirm": true}. |
| 400 | `invalid_json` | Тело не разобралось | Проверьте JSON и что тело — объект. |
| 401 | `unauthorized` | Токен не принят | Проверьте Bearer-токен из настроек. |
| 403 | `forbidden` | Запрос запрещён | CORS не поддерживается: запрос со сторонней страницы. |
| 403 | `forbidden_host` | Неверный Host | Обращайтесь на 127.0.0.1 или localhost. |
| 403 | `forbidden_scope` | Право выключено | Включите нужную галочку в настройках. |
| 404 | `no_such_character` | Персонаж не найден | Сверьте id со списком: GET /characters возвращает их все. |
| 404 | `no_such_marathon` | Марафон не найден | Список — GET /marathons. |
| 404 | `no_such_party` | Пати не найдена | Список — GET /parties. |
| 404 | `no_such_task` | Задание не найдено | Список заданий — в GET /marathons/{id}. |
| 404 | `not_found` | Не найдено | Проверьте адрес в справочнике. |
| 405 | `method_not_allowed` | Метод не поддерживается | Проверьте GET/POST/PATCH в справочнике. |
| 408 | `timeout` | Таймаут запроса | Запрос не дошёл целиком за 5 секунд. |
| 409 | `launch_not_ready` | Запускать некого | Список персонажей для запуска пуст. |
| 409 | `marathon_not_ready` | Это папка марафонов | Выберите марафон внутри папки. |
| 413 | `payload_too_large` | Слишком большой запрос | Заголовки до 16 КиБ, тело до 64 КиБ. |
| 415 | `unsupported_media_type` | Неверный Content-Type | Для тела нужен application/json. |
| 422 | `invalid_value` | Значение не принято | Проверьте значения полей: допустимые перечислены в тексте ошибки. |
| 423 | `storage_blocked` | Запись остановлена | Снимите защиту «Сохранение остановлено». |
| 429 | `launch_busy` | Уже идёт запуск | Дождитесь завершения задания. |
| 429 | `too_many_requests` | Слишком часто | 60 запросов в минуту; см. Retry-After. |
| 500 | `internal_error` | Внутренняя ошибка | Подробности — в журнале приложения. |
| 500 | `save_failed` | Не удалось сохранить | Изменение в памяти, но на диск не легло. |
| 503 | `app_not_ready` | Приложение не готово | Главное окно ещё загружается. |
| 503 | `too_many_connections` | Слишком много соединений | Не больше 16 одновременно. |
| 504 | `gateway_timeout` | Приложение не ответило | JS не уложился в 15 секунд. |

Сообщение зависит от места: например `invalid_value` в `fields` перечисляет
допустимые поля, а в `dungeon-passes` — допустимые проходки.

### Справочники полей

**Статы** (`stats`, ключи API — слева):

| Ключ | Название |
| --- | --- |
| `hp` | HP |
| `mp` | MP |
| `endurance` | Выносливость |
| `intelligence` | Интеллект |
| `strength` | Сила |
| `agility` | Ловкость |
| `levelBonus` | Бонус уровня |
| `physAttack` | Физ. атака |
| `physDefense` | Физ. защита |
| `magAttack` | Маг. атака |
| `magDefense` | Маг. защита |
| `critChance` | Крит, % |
| `critDamage` | Крит. урон |
| `atkSpeed` | Скорость атаки |
| `evasion` | Уклонение |
| `accuracy` | Меткость |
| `pa` | PA |
| `pz` | PZ |
| `morale` | Дух |
| `pvePa` | PvE PA |
| `pvePz` | PvE PZ |
| `physPenetration` | Физ. пробивание |
| `magPenetration` | Маг. пробивание |

**Проходки** (`dungeonPasses`): в адресе принимаются и русские, и английские имена.

| Ключ | Русское имя | Название |
| --- | --- | --- |
| `weapon` | `оружие` | Оружие |
| `armor` | `доспех` | Доспех |
| `relic` | `реликвия` | Реликвия |

Русское имя в адресе нужно кодировать: `%D0%BE%D1%80%D1%83%D0%B6%D0%B8%D0%B5`
(«оружие»). `curl --data-urlencode` и `urllib.parse.quote()` делают это сами.

---

## Методы

Условные обозначения: **право** — какое из трёх нужно; «чтение» включено по
умолчанию. В примерах `$BASE` = `http://127.0.0.1:47831/api/v1`,
`$TF_API_TOKEN` — токен из настроек.

### Состояние и журнал

#### `GET /health`

Живой ли сервер, версия, права, запись и занятость запуска.

Параметров нет. Ответ:

```json
{
  "ok": true,
  "app": { "version": "3.0.0", "build": "stable" },
  "api": { "version": 1, "uptimeSec": 42 },
  "storage": { "writable": true },
  "scopes": { "read": true, "modify": false, "launchClose": false },
  "launch": { "busy": false }
}
```

`storage.writable: false` — защита остановила запись: изменения вернут
`423 storage_blocked`.

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/health"
```

#### `GET /audit`

Последние 100 вызовов: время, метод, путь, код, длительность. Тел запросов и
токенов в журнале нет. **Право:** чтение.

```json
{ "audit": [{ "atMs": 1763985600000, "method": "GET", "path": "/api/v1/characters", "status": 200, "ms": 12 }] }
```

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/audit"
```

#### `GET /status`

Сводка одним запросом: счётчики, дела на сегодня, баланс, права и занятость
запуска. **Право:** чтение.

Контактов, паролей и содержимого заметок в сводке нет — только счётчики и
итоги, поэтому её безопасно показывать в чужой программе.

```json
{
  "ok": true,
  "app": { "version": "3.0.0", "build": "stable" },
  "api": { "version": 1, "uptimeSec": 42 },
  "storage": { "writable": true },
  "scopes": { "read": true, "modify": true, "launchClose": true },
  "launch": { "busy": false },
  "counts": { "characters": 3, "parties": 2, "marathons": 1, "plannerEntries": 12, "windows": 1, "financeOperations": 7 },
  "today": { "date": "2026-11-25", "total": 4, "done": 1 },
  "finance": { "balances": { "gold": 125000, "coins": 340 } }
}
```

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/status"
```

---

### Персонажи

#### `GET /characters`

**Список всех персонажей** с проходками и признаком запущенного окна. По умолчанию
возвращаются все персонажи, **отсортированные по id** — так список читается глазами и
не «переезжает» между вызовами.

**Статы, заметки и история монет в список не входят** (`stats`, `notes`,
`coinHistory`): два десятка статов на каждого персонажа втрое удлиняют ответ, а в
списке их почти не читают — для них есть карточка (`GET /characters/{id}`, полные
ответы и `/stats`). Сокращение заявлено в самом ответе: `detail: "list"` и
`omitted: ["stats","notes","coinHistory"]`, плюс `fullHint`. Получить полные карточки
— `?full=true`; назвать поля явно (`fields=stats.hp`) — тоже достаточно, `fields`
перекрывает правило и ответ получает `detail: "picked"`.

Секретов в ответе нет: контакты, пароль, путь запуска и куки не отдаются.

**Право:** чтение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `party` | query | string | id или название пати (без регистра) — список сузится до состава |
| `fields` | query | string | Какие поля вернуть, через запятую. Вложенные — через точку: `stats.hp`, `dungeonPasses.weapon`. `id` остаётся всегда. Неизвестное поле → `422 invalid_value` со списком допустимых |
| `lang` | query | string | `en` (по умолчанию) — ключи как есть; `ru` — подписи по-русски: «Класс», «Уровень», «Проходки: оружие». Значения не меняются |
| `flat` | query | boolean | `true` (по умолчанию) — плоские ключи (`"stats.hp": 120`), удобно для CSV/Excel; `false` — вложенные объекты (`"stats": {"hp": 120}`) |
| `sort` | query | string | `id` (по умолчанию), `nick`, `level` или `none` — порядок хранения |
| `order` | query | string | `asc` (по умолчанию) или `desc` |
| `full` | query | boolean | `true` — полные карточки: со статами, заметками и историей монет. Принимаются `1`, `true`, `yes`, `да`, `full`; всё остальное — «нет» |

**Одним запросом — несколько полей.** Например, id, класс, уровень и проходки:

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/characters?fields=id,class,level,dungeonPasses"
```

Ответ:

```json
{
  "characters": [
    { "id": "Luchnik_2", "class": "Лучник", "level": 99,
      "dungeonPasses": { "weapon": 2, "armor": 1, "relic": 0 } },
    { "id": "Mag_1", "class": "Маг", "level": 100,
      "dungeonPasses": { "weapon": 3, "armor": 1, "relic": 0 } }
  ],
  "count": 2,
  "fields": ["id", "class", "level", "dungeonPasses"]
}
```

Плоский вид (по умолчанию) — те же данные одной строкой на персонажа:

```json
{ "characters": [
  { "id": "Mag_1", "class": "Маг", "level": 100, "dungeonPasses.weapon": 3, "dungeonPasses.armor": 1, "dungeonPasses.relic": 0 }
] }
```

По-русски — `&lang=ru`: ключи подписаны, значения те же:

```json
{ "characters": [
  { "id": "Mag_1", "Класс": "Маг", "Уровень": 100, "Проходки: оружие": 3, "Проходки: доспех": 1, "Проходки: реликвия": 0 }
] }
```

<details>
<summary>Все поля, которые можно просить в <code>fields</code></summary>

`id`, `nick`, `class`, `level`, `favorite`, `sky`, `sky.name`, `sky.level`,
`partyIds`, `mainPartyId`, `stats`, `stats.<стат>` (например `stats.hp`,
`stats.physAttack`), `dungeonPasses`, `dungeonPasses.weapon`,
`dungeonPasses.armor`, `dungeonPasses.relic`, `ancientCoins`, `isLoggedIn`,
`lastLoginCheck`, `updatedAt`, `notes`, `tags`, `coinHistory`, `createdAt`,
`running`, `running.pid`, `running.title`.

</details>

Полная карточка — `?full=true` (или адресный маршрут `GET /characters/{id}`):

```json
{
  "characters": [
    {
      "id": "Mag_1", "nick": "Маг", "class": "Маг", "level": 100, "favorite": true,
      "partyIds": ["p-osnova"], "mainPartyId": "p-osnova", "sky": { "name": "Звезда", "level": 5 },
      "stats": { "hp": 120, "mp": 30, "physAttack": 12 },
      "dungeonPasses": { "weapon": 3, "armor": 1, "relic": 0 },
      "ancientCoins": 12, "tags": ["основа"], "coinHistory": [{ "at": "2026-11-01T10:00:00Z", "coins": 50 }],
      "notes": "", "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-11-25T12:00:00Z",
      "running": { "pid": 4321, "title": "Маг — Маг", "charId": "Mag_1", "nick": "Маг" }
    }
  ],
  "count": 1,
  "fields": null,
  "detail": "full"
}
```

Без `full` тот же ответ выглядит так же, кроме тяжёлых полей, и добавлены
`detail: "list"`, `omitted` и `fullHint` — чтобы клиент видел, что статов тут нет
намеренно, а не потому, что их не сохранили.

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/characters?party=Основа&fields=id,nick,level"
```

#### `GET /characters/{id}`

Карточка одного персонажа — та же форма, что в списке. **Право:** чтение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `id` | путь | string | id персонажа |

Ответ: `{ "character": { … } }`. Нет id — `404 no_such_character`.

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/characters/Mag_1"
```

#### `PATCH /characters/{id}`

Изменить персонажа: статы, проходки и поля карточки одним запросом.
Меняются только переданные ключи. **Право:** изменение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `stats` | body | object | Числа `0…1 000 000 000`, например `{"hp": 150}` |
| `dungeonPasses` | body | object | Целые, `{"weapon": 5, "armor": 3, "relic": 1}` |
| `nick` | body | string | Ник, до 120 символов |
| `class` | body | string | Класс, до 80 символов |
| `level` | body | number | 0…1000 |
| `notes` | body | string | Заметки, до 5000 символов |
| `tags` | body | string \| string[] | Теги: строка через запятую или массив |
| `favorite` | body | boolean | Избранное |
| `sky` | body | object | `{ "name": "Звезда", "level": 5 }` |

Перед изменением статов снимается снимок истории — как при сохранении карточки.
Неизвестное поле — `422 invalid_value`.

```bash
curl -s -X PATCH -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"stats":{"hp":150},"nick":"Маг II","tags":"основа, PvP"}' \
  "$BASE/characters/Mag_1"
```

Ответ:

```json
{
  "character": { "id": "Mag_1", "nick": "Маг II", "class": "Маг", "level": 100, "favorite": false,
                 "tags": ["основа", "PvP"], "stats": { "hp": 150 }, "dungeonPasses": { "weapon": 3 },
                 "updatedAt": "2026-11-25T12:00:00Z" },
  "changed": ["stats.hp", "nick", "tags"],
  "statsHistoryAdded": true
}
```

#### `POST /characters`

Создать персонажа. Обязателен только `nick`. **Право:** изменение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `nick` | body | string | Обязателен |
| `class`, `level`, `notes`, `tags`, `favorite`, `sky` | body | разное | Необязательны |

Ответ `201`: `{ "character": { "id", "nick", "level", "class" }, "duplicateNick": false }`.
`duplicateNick: true` — предупреждение: такой ник уже есть (это допустимо).

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"nick":"Новый","class":"Маг","level":1}' "$BASE/characters"
```

#### `POST /characters/bulk-update`

Один патч сразу нескольким персонажам (до 100). **Право:** изменение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `ids` | body | string[] | 1…100 уникальных id |
| `patch` | body | object | Как у `PATCH /characters/{id}` |

Частичный успех — нормальный ответ: `updated` и `failed` показывают, что вышло.
Патч проверяется до правок: неверный — не меняется никто.

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"ids":["Mag_1","Luchnik_2"],"patch":{"dungeonPasses":{"weapon":5}}}' \
  "$BASE/characters/bulk-update"
```

---

### Статы и проходки по отдельности

Короткие адреса для тех же данных: удобны, когда нужен **один** стат или
**одна** проходка — без разбора всей карточки.

#### `GET /characters/{id}/stats`

Все статы: и плоским объектом, и строками с подписями. **Право:** чтение.

```json
{
  "character": { "id": "Mag_1", "nick": "Маг", "hp": 120, "mp": 30, "physAttack": 12 },
  "stats": [
    { "key": "hp", "label": "HP", "value": 120 },
    { "key": "mp", "label": "MP", "value": 30 }
  ],
  "count": 23
}
```

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/characters/Mag_1/stats"
```

#### `GET /characters/{id}/stats/{stat}`

Одно значение стата — «сколько HP у персонажа `id`». **Право:** чтение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `id` | путь | string | id персонажа |
| `stat` | путь | string | Ключ из [таблицы статов](#справочники-полей) |

```json
{ "id": "Mag_1", "nick": "Маг", "stat": "hp", "label": "HP", "value": 120 }
```

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/characters/Mag_1/stats/hp"
```

Неизвестный ключ — `422 invalid_value` (а не тихий ноль). Нет персонажа —
`404 no_such_character`.

#### `PATCH /characters/{id}/stats/{stat}`

Задать один стат — или прибавить/вычесть. **Право:** изменение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `id` | путь | string | id персонажа |
| `stat` | путь | string | Ключ стата |
| `value` | body | number | Для `mode=set` (по умолчанию): новое значение `0…1 000 000 000` |
| `mode` | body | string | `set` \| `inc` \| `dec` |
| `by` | body | number | Для `inc`/`dec`: на сколько (по умолчанию 1) |

Ответ: `{ "id", "nick", "stat", "value", "before", "changed" }`.
В минус нельзя; снимок истории создаётся только при реальном изменении.

```bash
# поставить 150
curl -s -X PATCH -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":150}' "$BASE/characters/Mag_1/stats/hp"

# прибавить 5
curl -s -X PATCH -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"inc","by":5}' "$BASE/characters/Mag_1/stats/hp"
```

```powershell
Invoke-RestMethod -Method Patch -Headers $h -ContentType 'application/json' `
  -Body '{"mode":"inc","by":5}' -Uri "$base/characters/Mag_1/stats/hp"
```

#### `GET /characters/{id}/dungeon-passes`

Все проходки персонажа и их сумма. **Право:** чтение.

```json
{
  "id": "Mag_1", "nick": "Маг", "total": 4,
  "dungeonPasses": { "weapon": 3, "armor": 1, "relic": 0 },
  "passes": [
    { "key": "weapon", "label": "Оружие", "value": 3 },
    { "key": "armor", "label": "Доспех", "value": 1 },
    { "key": "relic", "label": "Реликвия", "value": 0 }
  ]
}
```

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/characters/Mag_1/dungeon-passes"
```

#### `GET /characters/{id}/dungeon-passes/{pass}`

Одно число проходок — «сколько проходок оружия у `Mag_1`». **Право:** чтение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `id` | путь | string | id персонажа |
| `pass` | путь | string | `weapon`/`оружие`, `armor`/`доспех`, `relic`/`реликвия` |

```json
{ "id": "Mag_1", "nick": "Маг", "pass": "weapon", "label": "Оружие", "value": 3 }
```

```bash
# по-английски
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/characters/Mag_1/dungeon-passes/weapon"

# по-русски (curl кодирует кириллицу в адресе сам, если адрес собран через --data-urlencode)
curl -s -G -H "Authorization: Bearer $TF_API_TOKEN" \
  --data-urlencode "" "http://127.0.0.1:47831/api/v1/characters/Mag_1/dungeon-passes/оружие"
```

#### `PATCH /characters/{id}/dungeon-passes/{pass}`

Изменить одно число проходок. **Право:** изменение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `id` | путь | string | id персонажа |
| `pass` | путь | string | Имя проходки (рус. или англ.) |
| `value` | body | number | Целое `0…1 000 000 000`; тело может быть **просто числом** |

Ответ несёт и остальные проходки, и новый итог:

```json
{ "id": "Mag_1", "nick": "Маг", "pass": "weapon", "value": 5, "before": 3,
  "changed": true, "dungeonPasses": { "weapon": 5, "armor": 1, "relic": 0 }, "total": 6 }
```

```bash
# телом — число
curl -s -X PATCH -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '5' "$BASE/characters/Mag_1/dungeon-passes/weapon"

# телом — объект (то же самое)
curl -s -X PATCH -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":5}' "$BASE/characters/Mag_1/dungeon-passes/weapon"
```

```powershell
# PowerShell: тело-число работает как есть
Invoke-RestMethod -Method Patch -Headers $h -ContentType 'application/json' `
  -Body '5' -Uri "$base/characters/Mag_1/dungeon-passes/weapon"
```

---

### Пати

#### `GET /parties`

Все пати с составом в порядке перетаскивания — он же порядок запуска.
**Право:** чтение.

```json
{ "parties": [{ "id": "p-osnova", "name": "Основа", "color": "#6e8ef8",
               "members": [{ "id": "Mag_1", "nick": "Маг", "order": 1 }] }] }
```

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/parties"
```

#### `GET /parties/{id}`

Одна пати. **Право:** чтение. Нет — `404 no_such_party`.

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/parties/p-osnova"
```

#### `PATCH /parties/{id}`

Переименовать пати или сменить цвет. **Право:** изменение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `name` | body | string | 1…80 символов, не пустое |
| `color` | body | string \| null | Цвет или `null` для сброса |

Состав из API не меняется — намеренно: он влияет на запуск.

```bash
curl -s -X PATCH -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Основа+"}' "$BASE/parties/p-osnova"
```

---

### Марафоны

#### `GET /marathons`

Все марафоны с заданиями, прогрессом и итогами. **Право:** чтение.

`totals` считает модель интерфейса (`marathonTotals`); второй правды о
прогрессе нет. Битые данные — `totals: null`, список всё равно придёт.
Папки-серии (`kind: "series"`) — отдельные записи с `childIds`, без заданий.

```json
{
  "marathons": [
    {
      "id": "m1", "kind": "single", "title": "Марафон ноября",
      "startDate": "2026-11-01", "endDate": "2026-11-30", "status": "active",
      "participantIds": ["Mag_1"],
      "tasks": [{ "id": "t1", "title": "Ежедневки", "targetChecks": 10,
                  "schedule": { "mode": "everyDay", "dates": [], "weekStartDay": 1 },
                  "rewards": [{ "threshold": 5, "rewardText": "100 монет", "rewardCoins": 100 }] }],
      "progress": { "Mag_1": { "t1": { "marks": ["2026-11-02"], "adjust": 1, "site": 2 } } },
      "totals": { "checks": 3, "maxChecks": 10, "coins": 0, "maxCoins": 100 }
    }
  ]
}
```

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/marathons"
```

#### `GET /marathons/{id}`

Один марафон: `{ "marathon": { … } }`. **Право:** чтение. Нет — `404 no_such_marathon`.

В `progress[characterId][taskId]`: `marks` — ручные отметки дней, `adjust` —
поправка, `site` — число с сайта.

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/marathons/m1"
```

#### `GET /marathons/{id}/participants`

Кто участвует и в каких пати состоит. **Право:** чтение.

```json
{ "marathonId": "m1", "characters": [{ "id": "Mag_1", "nick": "Маг" }], "parties": [{ "id": "p-osnova", "name": "Основа" }] }
```

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/marathons/m1/participants"
```

#### `POST /marathons/{id}/marks`

Поставить или снять ручную отметку дня. **Право:** изменение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `characterId` | body | string | Участник марафона |
| `taskId` | body | string | Задание марафона |
| `date` | body | string | `YYYY-MM-DD` в пределах сроков |
| `marked` | body | boolean | `true` — поставить (по умолчанию), `false` — снять |

```json
{ "marathonId": "m1", "characterId": "Mag_1", "taskId": "t1", "date": "2026-11-24",
  "marked": true, "changed": true, "marks": ["2026-11-02", "2026-11-24"] }
```

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"characterId":"Mag_1","taskId":"t1","date":"2026-11-24"}' "$BASE/marathons/m1/marks"
```

#### `POST /marathons/{id}/adjust`

Поправка к счётчику задания — абсолютное значение (может быть отрицательным,
`−100 000…100 000`). **Право:** изменение.

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"characterId":"Mag_1","taskId":"t1","value":4}' "$BASE/marathons/m1/adjust"
```

---

### Планировщик и учёт

#### `GET /planner`

Записи планировщика. **Право:** чтение.

```json
{ "entries": [{ "id": "pe1", "title": "Собрать пати", "date": "2026-11-25", "time": "19:00",
                "durationMinutes": 60, "kind": "party", "priority": "high", "recurrence": "weekly", "status": null }] }
```

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/planner"
```

#### `GET /finance`

Учёт: операции, позиции магазина, долги и настройки курса. **Право:** чтение.
Контактов и паролей здесь нет.

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/finance"
```

#### `PATCH /planner/entries/{id}`

Правка записи планировщика. **Право:** изменение.

Поля тела:

| Поле | Тип | Что значит |
| --- | --- | --- |
| `status` | строка | `todo`, `doing` или `done` |
| `date` | строка | День, к которому относится статус, в формате `ГГГГ-ММ-ДД` |
| `moveToDate` | строка | Перенести саму запись на другой день |
| `title` | строка | Название |
| `time` | строка | Время `ЧЧ:ММ` или пустая строка |

У повторяющейся записи своё состояние на каждый день: `date` — конкретный
день повтора, а не «день записи». Правку делает тот же модуль, что и интерфейс
приложения, поэтому отметка не сбрасывается и не расходится с календарём.

```json
{ "entry": { "id": "pe1", "title": "Собрать пати", "date": "2026-11-25", "time": "19:00", "status": "done" },
  "statusDate": "2026-11-25", "statusValue": "done", "changed": ["status"] }
```

`statusDate` и `statusValue` — состояние за запрошенный день: у повторов оно своё
на каждый день, поэтому в ответе видно, что именно отмечено.

```bash
curl -s -X PATCH -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"done","date":"2026-11-25"}' "$BASE/planner/entries/pe1"
```

#### `POST /planner/entries`

Новая запись в календаре планировщика. **Право:** изменение.

Обязательно только `title`. Остальное необязательно: `date` (сегодня, если не
указать), `time`, `durationMinutes`, `kind` (`task`, `event`, `note`),
`priority`, `recurrence` (`none`, `daily`, `weekly`, `monthly`).

```json
{ "entry": { "id": "pe2", "title": "Сходить в игру", "date": "2026-11-25", "time": "19:00", "status": "todo" } }
```

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Сходить в игру","date":"2026-11-25","time":"19:00"}' "$BASE/planner/entries"
```

#### `POST /finance/operations`

Новая запись в реестре денег: приход или расход. **Право:** изменение.

| Поле | Тип | Что значит |
| --- | --- | --- |
| `kind` | строка | `in` (приход) или `out` (расход, по умолчанию) |
| `amount` | число | Сумма: положительное число |
| `currency` | строка | `gold` или `coins` |
| `date` | строка | Дата в формате `ГГГГ-ММ-ДД` |
| `counterparty` | строка | Контрагент |
| `note` | строка | Комментарий |
| `characterId` | строка | Персонаж, к которому относится операция |

Запись идёт через модель учёта приложения: сумма округляется под валюту, так
что балансы в приложении и в своей программе не разойдутся.

```json
{ "operation": { "id": "op2", "kind": "in", "amount": 25000, "currency": "gold", "date": "2026-11-25", "counterparty": "", "note": "Продажа зелья" } }
```

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"in","amount":25000,"currency":"gold","note":"Продажа зелья"}' "$BASE/finance/operations"
```

---

### Окна игры

#### `GET /windows`

Запущенные окна: PID, заголовок, персонаж, время запуска. **Право:** чтение.

```json
{ "windows": [{ "pid": 4321, "title": "Маг — Маг", "charId": "Mag_1", "nick": "Маг",
                "class": "Маг", "elevated": false, "startedAt": "2026-11-25T12:00:00Z" }] }
```

`charId` может быть `null`, если окно не сопоставлено.

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/windows"
```

#### `POST /windows/close`

Закрыть окна по PID — только с подтверждением. **Право:** запуск и закрытие.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `pids` | body | number[] | PID из `GET /windows` |
| `confirm` | body | boolean | Обязательно `true` |

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"pids":[4321],"confirm":true}' "$BASE/windows/close"
```

---

### Запуск и задания

Все три запуска отвечают одинаково: `202` с заданием. Ход работы — в
`GET /jobs/{jobId}`. Запуск один за раз: второй `POST` — `429 launch_busy`.
Задания живут 30 минут.

#### `POST /launch/character`

Запустить одного персонажа. **Право:** запуск и закрытие.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `characterId` | body | string | id персонажа |
| `gcId` | body | string | Необязательный GameCenter |

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"characterId":"Mag_1"}' "$BASE/launch/character"
```

#### `POST /launch/party`

Запустить пати целиком или её часть. **Право:** запуск и закрытие.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `partyId` | body | string | id пати |
| `partyName` | body | string | Название (без регистра), если нет id |
| `memberIds` | body | string[] | Необязательно: кого именно из пати |

Чужие `memberIds` не запускаются — попадают в `ignoredIds` итога.

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"partyName":"Основа"}' "$BASE/launch/party"
```

#### `POST /launch/selection`

Запустить выбранных персонажей из разных пати в заданном порядке — главный
сценарий фермы. **Право:** запуск и закрытие.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `characterIds` | body | string[] | 1…100 уникальных id **в нужном порядке** |
| `gcId` | body | string | Необязательный GameCenter |

Неизвестные id → `ignoredIds`, архивные не запускаются; если известных нет —
`404 no_such_character`.

```bash
curl -s -X POST -H "Authorization: Bearer $TF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"characterIds":["Mag_1","Luchnik_2","Zhrets_3"]}' "$BASE/launch/selection"
```

#### `GET /jobs/{jobId}`

Прогресс и итог задания. **Право:** чтение.

```json
{
  "id": "job_1abc", "kind": "selection", "status": "done",
  "progress": { "done": 3, "total": 3, "percent": 100, "stage": "Готово", "character": null },
  "result": {
    "requested": 3, "launched": 2, "alreadyRunning": 0, "skipped": 1, "failed": 0, "cancelled": 0, "ms": 45210,
    "ignoredIds": [],
    "items": [
      { "id": "Mag_1", "nick": "Маг", "status": "ok", "ms": 15000, "error": null },
      { "id": "Luchnik_2", "nick": "Лучник", "status": "ok", "ms": 14000, "error": null },
      { "id": "Zhrets_3", "nick": "Жрец", "status": "skipped", "ms": null, "error": "no_saved_login" }
    ]
  }
}
```

`status`: `queued` | `running` | `done` | `failed`. Причины `skipped`:
`already_running`, `no_gc`, `no_saved_login`.

```bash
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/jobs/job_1abc"
```

---

### Выгрузки

#### `GET /export/{набор}.{csv|json}`

Скачать готовый файл — без разбора JSON. **Право:** чтение.

| Набор | Что внутри |
| --- | --- |
| `characters` | Персонажи: ник, класс, уровень, статы, проходки, теги |
| `parties` | Пати: название, цвет, участники одной строкой |
| `marathons` | Марафоны: сроки, задания, отметки, монеты |
| `windows` | Запущенные окна: PID, персонаж, время |
| `planner` | Записи планировщика |
| `finance` | Движения денег |

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `format` | query | string | `csv` (по умолчанию) \| `json` \| `txt` |
| `party`, `fields` | query | string | Те же фильтры, что у `GET /characters` |

Файл приходит вложением: `Content-Disposition: attachment; filename="tvinoferma_characters_2026-11-25.csv"`.
CSV — с `;` и BOM: Excel на русской локали открывает без настройки кодировки,
значения с `;`, кавычками и переводами строк экранируются по RFC 4180.
**Секреты в выгрузку не попадают никогда.**

```bash
# CSV прямо в текущую папку (имя из Content-Disposition)
curl -s -OJ -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/export/characters.csv"

# JSON по тому же адресу
curl -s -H "Authorization: Bearer $TF_API_TOKEN" "$BASE/export/characters.json?party=Основа"
```

```powershell
Invoke-WebRequest -Headers @{ Authorization = "Bearer $env:TF_API_TOKEN" } `
  -Uri "$base/export/marathons.csv" -OutFile .\marathons.csv
```

---

## Памятка: что можно делать

Короткий перечень «вопрос → запрос» — чтобы не искать по всему справочнику.

| Хочу | Запрос |
| --- | --- |
| Убедиться, что API работает | `GET /health` |
| Всех персонажей списком | `GET /characters` |
| Только состав одной пати | `GET /characters?party=Основа` |
| Карточку персонажа | `GET /characters/{id}` |
| Только HP | `GET /characters/{id}/stats/{stat}` |
| Все статы | `GET /characters/{id}/stats` |
| Статы только нужные | `GET /characters?fields=id,nick,hp,physAttack` |
| Все проходки | `GET /characters/{id}/dungeon-passes` |
| Только проходки оружия | `GET /characters/{id}/dungeon-passes/{pass}` |
| Поставить HP = 150 | `PATCH /characters/{id}/stats/{stat}` `{"value":150}` |
| Прибавить 1 к HP | `PATCH /characters/{id}/stats/{stat}` `{"mode":"inc","by":1}` |
| Поставить 5 проходок оружия | `PATCH /characters/{id}/dungeon-passes/{pass}` `5` |
| Сразу всем +5 оружия | `POST /characters/bulk-update` `{"ids":[…],"patch":{"dungeonPasses":{"weapon":5}}}` |
| Переименовать пати | `PATCH /parties/{id}` `{"name":"…"}` |
| Кто участвует в марафоне | `GET /marathons/{id}/participants` |
| Отметить день в марафоне | `POST /marathons/{id}/marks` |
| Поправить счётчик задания | `POST /marathons/{id}/adjust` |
| Что запущено сейчас | `GET /windows` |
| Закрыть окно | `POST /windows/close` `{"pids":[…],"confirm":true}` |
| Запустить выбранных по порядку | `POST /launch/selection` |
| Узнать, как идёт запуск | `GET /jobs/{jobId}` |
| Выгрузить всё в Excel-совместимый CSV | `GET /export/characters.csv` |
| Выгрузить марафоны в JSON | `GET /export/marathons.json` |
| Посмотреть, кто и что вызывал | `GET /audit` |

**Чего через API нельзя** (намеренно): удалять и архивировать персонажей,
менять состав пати, менять настройки приложения, читать контакты, пароли, путь
запуска и облачные ключи. Это решения о данных, которые нельзя откатить или
которые являются секретами — они остаются в интерфейсе.

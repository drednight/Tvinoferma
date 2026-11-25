# Справочник API Твинофермы

Полный список методов внешнего API: адрес, токен, права, лимиты, а затем каждый
метод с параметрами, ответом и примером. Это **справочник**; зачем API нужен и
как устроен — в [`EXTERNAL-API.md`](EXTERNAL-API.md). Интерактивная версия этого
же справочника — на странице `http://127.0.0.1:47831/` (вкладка «Справочник API»)
с кнопкой «Попробовать в тестовой строке» у каждого метода.

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

Все ошибки одинаковы — JSON с машиночитаемым кодом:

```json
{ "error": { "code": "invalid_value", "message": "Неизвестный стат «nope»: список — GET /characters/Mag_1/stats" } }
```

| HTTP | `code` | Когда |
| --- | --- | --- |
| 400 | `invalid_json` | Тело не разобралось или это не объект |
| 400 | `bad_request` | Строка запроса не разбирается как HTTP |
| 400 | `confirm_required` | Закрытие окон без `{"confirm": true}` |
| 401 | `unauthorized` | Нет или неверный Bearer-токен |
| 403 | `forbidden_host` | `Host` не `127.0.0.1:<порт>` / `localhost:<порт>` |
| 403 | `forbidden_scope` | Право выключено в настройках |
| 403 | `forbidden` | `OPTIONS` или запрос со сторонней страницы |
| 404 | `not_found` | Неизвестный путь |
| 404 | `no_such_character` / `no_such_party` / `no_such_marathon` / `no_such_task` | Нет такой сущности |
| 405 | `method_not_allowed` | Метод не поддержан (например, `DELETE`) |
| 408 | `timeout` | Запрос не получен целиком за 5 с |
| 409 | `launch_not_ready` / `marathon_not_ready` | Запускать некого / действие над папкой марафонов |
| 413 | `payload_too_large` | Заголовки > 16 КиБ или тело > 64 КиБ |
| 415 | `unsupported_media_type` | Тело не `application/json` |
| 422 | `invalid_value` | Значение вне диапазона, неизвестное поле, неизвестный стат/проходка |
| 423 | `storage_blocked` | Запись состояния остановлена защитой |
| 429 | `launch_busy` / `too_many_requests` | Уже идёт запуск / лимит частоты (`Retry-After`) |
| 500 | `internal_error` / `save_failed` | Сбой приложения / не удалось сохранить |
| 503 | `app_not_ready` / `too_many_connections` | Главное окно не загрузилось / много соединений |
| 504 | `timeout` | JS не ответил за 15 с |

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

---

### Персонажи

#### `GET /characters`

Список всех персонажей со статами, проходками и признаком запущенного окна.
Секретов в ответе нет: контакты, пароль, путь запуска и куки не отдаются.

**Право:** чтение.

| Имя | Где | Тип | Описание |
| --- | --- | --- | --- |
| `party` | query | string | id или название пати (без регистра) — список сузится до состава |
| `fields` | query | string | Поля через запятую (`id` всегда остаётся), например `id,nick,hp` |

Ответ:

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
  ]
}
```

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

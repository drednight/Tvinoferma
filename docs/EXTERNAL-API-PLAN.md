# Внешний API Твинофермы — короткий план

Полный документ: [`docs/EXTERNAL-API.md`](./EXTERNAL-API.md) ·
макет страницы: `demo/external-api/` (`DEMO_ENTRY=/demo/external-api/index.html npm run demo`)

---

## 1. Главный ответ

**Да, сторонняя программа сможет запускать окна** — одно окно, пати целиком и выбранных
участников. Запуск уже работает в приложении, и внешний вызов пойдёт тем же кодом:
`launchOne(char, { interactive: false })` и
`launchPartyByName(partyName, { interactive: false, memberIds })`.

`interactive: false` — ключевая деталь: без диалогов и экранов проверки. Ровно так уже
запускают трей и макросы. Единственное условие — у персонажа прикреплён GameCenter и
запомнен вход: иначе задание завершится со строкой `skipped` (причина `no_gc` или
`no_saved_login`), а не откроет окно под чужим аккаунтом.

**Статы и проходки** меняются в базе Твинофермы (карточки, профиль, история изменений).
Поменять числа внутри игры нельзя — игра не даёт такого канала.

---

## 2. Как это устроено

```
Python / PowerShell / AHK
  │  HTTP на 127.0.0.1:47831, Bearer-токен
  ▼
Rust: external_api  ── проверка Host и токена, лимиты, журнал
  │  emit_to("main", "external-api-request", { requestId, action, payload })
  ▼
JS главного окна  ── существующие функции приложения
  │  чтение state · normalizeStats · rememberStatsBefore · persist · launchOne
  │  invoke("external_api_reply", { requestId, ok, data })
  ▼
HTTP-ответ
```

Прямая запись в `state.json` снаружи не годится: работающее приложение перезапишет
файл из памяти, а проверки целостности могут включить режим «Сохранение остановлено».
Поэтому изменения проходят через приложение.

Главное окно живёт в трее даже после закрытия, так что API работает, пока приложение
запущено. Выход из трея = `connection refused` — понятный признак «Твиноферма не работает».

---

## 3. Что сможет внешняя программа

| Действие | Запрос | Результат |
| --- | --- | --- |
| Проверить связь | `GET /api/v1/health` | версия, можно ли писать, занят ли запуск |
| Список персонажей | `GET /api/v1/characters` | ники, статы, проходки, окно запущено или нет |
| Один персонаж | `GET /api/v1/characters/{id}` | то же для одного |
| Изменить статы/проходки | `PATCH /api/v1/characters/{id}` | снимок в историю, сохранение, перерисовка |
| Массово (до 100) | `POST /api/v1/characters/bulk-update` | `updated` + `failed` |
| Пати и порядок | `GET /api/v1/parties` | участники в порядке запуска |
| Запущенные окна | `GET /api/v1/windows` | pid, заголовок, персонаж |
| Запустить окно | `POST /api/v1/launch/character` | `202 { jobId }` |
| Запустить пати | `POST /api/v1/launch/party` | `202 { jobId }`, можно с `memberIds` |
| Ход запуска | `GET /api/v1/jobs/{jobId}` | прогресс, итог по каждому персонажу |
| Закрыть окна | `POST /api/v1/windows/close` | только с `confirm: true` |
| Показать окно / оверлей | `POST /api/v1/app/show` | из трея или оверлей |

Пример на Python:

```python
import json, os, time, urllib.request

BASE = "http://127.0.0.1:47831/api/v1"
TOKEN = os.environ["TVINOFERMA_API_TOKEN"]

def api(method, path, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        BASE + path, data=body, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

job = api("POST", "/launch/party", {"partyName": "Основа"})
while True:
    status = api("GET", f"/jobs/{job['jobId']}")
    print(status["progress"].get("stage", status["status"]))
    if status["status"] not in ("queued", "running"):
        break
    time.sleep(2)
print(json.dumps(status["result"], ensure_ascii=False, indent=2))
```

---

## 4. Безопасность (обязательная часть, а не «потом»)

- **Выключено по умолчанию**, включается тумблером в «Настройки → Приложение → 🔌 Внешний API».
- Слушает только `127.0.0.1` — по сети управлять нельзя.
- **Bearer-токен**, сравнение постоянного времени; без токена `401`.
- **Проверка `Host`** — защита от DNS rebinding, иначе `403`.
- **Никакого CORS** — чужая вкладка браузера не сможет дергать `POST/PATCH`.
- Токен хранится **как хеш** в `state.json` (показывается один раз), либо в Credential Manager.
- API **не отдаёт** контакты, пароли, куки, токены GameCenter и не принимает команды
  `factory_reset`, восстановления копий, `promo`/`transfer`/`shop`.
- Права по группам: чтение · изменение · запуск/закрытие.
- Лимиты: тело ≤ 64 КиБ, 60 запросов в минуту, один активный запуск; журнал последних
  100 вызовов без тел и токенов.
- В тестовой сборке (`feature = "acceptance"`) сервер принудительно выключен.

---

## 5. Этапы

| Этап | Что делаем | Итог |
| --- | --- | --- |
| **M0** ✅ | контракт, безопасность, макет страницы | согласовать до кода |
| **M1** | Rust-сервер + чтение (`health`, `characters`, `parties`, `windows`) | можно читать, менять нельзя |
| **M2** | `PATCH`, `bulk-update`, история статов, ошибка `423` | можно менять статы и проходки |
| **M3** | задания запуска, `launch/character`, `launch/party`, закрытие окон | можно запускать окна и пати |
| **M4** | страница `GET /`, панель настроек, токен, справка, чек-лист Windows | готово к проверке на живом клиенте |

Код M1–M3 не требует новых Rust-зависимостей: `std::net` + поток (как в
`cloud_oauth_callback.rs`) и уже подключённый `sha2`. Это важно: CI собирает с
`--locked`, а локального `cargo` может не быть.

Переиспользуем, а не пишем заново: `normalizeStats`, `rememberStatsBefore`, `persist()`,
`renderCharacters()`, `partyById`/`charactersInPartyOrdered`/`selectMembersById`,
`launchOne`/`launchPartyByName`, очередь `startTask`, `runningClientDetails`/`closeClientsByPid`.

---

## 6. Что уже лежит в репозитории

- `docs/EXTERNAL-API.md` — полный контракт: все запросы и ответы, коды ошибок,
  безопасность, этапы, приёмочный чек-лист, список переиспользуемого кода.
- `demo/external-api/` — рабочий макет странички: подключение по токену, правка статов
  и проходок, массовое «+1», запуск персонажа и пати с прогрессом и строкой `skipped`,
  закрытие окон по pid, журнал вызовов с телами, примеры `curl`/Python/PowerShell.
  Проверен в jsdom: 401 без токена, сохранение, запуск пати, закрытие, все три примера.

Код приложения этот заход не менял — сначала согласуем контракт.

---

## 7. Что нужно решить

1. Кто будет вызывать API: Python, PowerShell, AHK, Excel, свой сайт?
2. Нужен ли запуск по расписанию (Планировщик Windows дёргает API)?
3. Токен показывать один раз (хеш) или хранить в Credential Manager?
4. Разрешать закрытие окон через API? (предлагаю да, только с `confirm: true`)
5. Нужно ли массовое изменение статов/проходок?
6. Порт `47831` подходит?
7. Страничка в браузере по `127.0.0.1` — достаточно, или нужна вкладка внутри приложения?

Ответите — начну с M1 (сервер + чтение), дальше по этапам.

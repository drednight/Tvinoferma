# Обновление снимков интерфейса

Снимки README находятся в `docs/screenshots/`, встроенной справки — в
`public/assets/guides/`. Это настоящий интерфейс на вымышленных данных из
`tests/fixtures/ui-demo-state.json`, не макеты. Даты учебной фикстуры сдвигаются
относительно даты её сохранения, чтобы события и марафон оставались видимыми.
Заголовки новостей для снимков учебные, они не читаются с сайта.

Нужны Node.js и установленный Edge/Chrome. В PowerShell VS Code:

```powershell
npm ci
$env:BROWSER_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm run shots
npm run shots -- --guides --only today,characters,parties,marathons,scripts,character-form,character-profile,marathon-wizard,planner-entry,calendar-month,settings-browser,gamecenters,settings-app,settings-launcher,settings-data,settings-updates,settings-security,settings-danger,notifications,settings-help,promo-dialog,transfer-dialog,shop-dialog,caravan-dialog,sync-task
```

Скрипт использует отдельный профиль браузера, не профиль установленного приложения.
Не снимайте реальные контакты, пароли и чужие данные. Просмотрите результаты перед
коммитом. Полный запуск справки включает также внутренние панели; для публичных
снимков используйте приведённый явный список.

Выборочные снимки:

```powershell
npm run shots -- --only today,browser,calendar
npm run shots -- --guides --only settings-browser,calendar-month
```

На Linux можно задать `BROWSER_PATH=/path/to/chromium`; в контейнере, если это
необходимо, — `BROWSER_ARGS="--no-sandbox --disable-gpu"`. Снимки браузерного
интерфейса не заменяют проверку нативных окон и cookies WebView2 на Windows.

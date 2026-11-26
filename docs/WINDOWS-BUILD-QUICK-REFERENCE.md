# Памятка: локальные сборки Windows

Короткая шпаргалка по сборке и запуску тестового EXE из текущего checkout. Подробности,
предварительные требования и приёмочные проверки — в [полной инструкции](LOCAL-WINDOWS-BUILD.md).
Команды запускайте из корня репозитория на Windows.

## Какой профиль выбрать

- **Isolated** — отдельный профиль приложения; это вариант по умолчанию. Разделение ещё
  не подтверждено на Windows: используйте отдельную тестовую учётную запись Windows и
  только искусственные данные.
- **Shared** — использует те же данные, vault, WebView-профили и облачные настройки, что
  и установленная версия. Может изменить их. Это **не отдельная тестовая база**.
  Перед сборкой/запуском закройте Твиноферму вместе с треем и сделайте независимую копию.

Оба варианта — неподписанные тестовые EXE, не установщики и не релизы. Скрипт не
запускает GitHub Actions и сам по себе не заполняет базу тестовыми данными.

## Сборка и запуск из PowerShell

### Isolated (безопасный вариант по умолчанию)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows-local.ps1 -Profile Isolated
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-windows-local.ps1 -Profile Isolated
```

### Shared (только если нужен именно общий профиль)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows-local.ps1 -Profile Shared -SharedProfileConfirmation I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-windows-local.ps1 -Profile Shared -SharedProfileConfirmation I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA
```

В `Shared` подтверждение потребуется и при сборке, и при запуске. Перед запуском
закройте обычное приложение полностью, включая трей. Не запускайте обе версии одновременно.

### Одна строка: собрать и сразу запустить Shared

Если PowerShell уже открыт в корне проекта и разрешает запуск локальных скриптов:

```powershell
& .\scripts\build-windows-local.ps1 -Profile Shared -SharedProfileConfirmation I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA; if ($?) { & .\scripts\run-windows-local.ps1 -Profile Shared -SharedProfileConfirmation I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA }
```

Запуск выполняется только если сборка завершилась успешно. Для Isolated можно убрать оба
параметра `-SharedProfileConfirmation ...` и заменить `Shared` на `Isolated`.

## То же через задачи VS Code

- **Isolated:** `Ctrl+Shift+B` собирает вариант по умолчанию; затем выполните задачу
  `Tvinoferma: Run latest Windows build (isolated)`.
- **Shared:** запустите через **Терминал → Выполнить задачу…** задачу
  `Tvinoferma: Windows build (shared current data)`, введите фразу подтверждения, затем
  задачу `Tvinoferma: Run latest Windows build (shared current data)` и подтвердите ещё раз.

## Тестовая сборка всегда от администратора

При запуске тестовой сборки Windows один раз спрашивает разрешение (UAC), окно
закрывается и открывается снова — уже с правами администратора. Так тестовая сборка
может подписывать и закрывать окна игры, запущенные с правами администратора.

- Отказались в UAC — приложение объяснит, что без прав не работает, и закроется.
  Запустите его ещё раз и разрешите запрос.
- Сборка уже запущена — повторный запуск просто сообщит об этом, второй раз права
  спрашивать не будут.
- Старый экземпляр без прав закрывается сам: он мешает новой копии с правами.
- Автозапуск тестовой сборки идёт через Планировщик с наивысшими правами — при входе
  в Windows запроса UAC не будет.

Подробнее — в [полной инструкции](LOCAL-WINDOWS-BUILD.md#41-тестовая-сборка-всегда-от-администратора).

## Полезные флаги и результат

- `-Checks Full` — добавить полный набор frontend-тестов и Rust library tests; дольше.
- `-SkipInstall` — пропустить `npm ci`, если зависимости уже установлены; соответствие
  `package-lock.json` при этом отдельно не проверяется.
- `-AllowDirty` — разрешить сборку с локальными изменениями. Используйте осознанно:
  в `BUILD-INFO.json` будет указано `dirty: true` и записан отпечаток исходников.
  VS Code build tasks уже передают этот флаг; ручной скрипт по умолчанию откажется
  собирать изменённую рабочую копию.

Готовые файлы появляются в `local-acceptance/`: `isolated-.../Tvinoferma.exe` или
`shared-.../Tvinoferma-SHARED-TEST.exe`. Старые сборки не перезаписываются. Скрипт запуска
проверяет профиль, манифест и SHA-256. Эта процедура не собирает стабильный подписанный
релиз — для релиза см. [инструкцию по выпуску](RELEASE.md).

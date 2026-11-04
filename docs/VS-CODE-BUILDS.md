# Тестовые сборки и workflows из VS Code

## Что выбрать

| Задача | Workflow | Результат |
| --- | --- | --- |
| Получить новый тестовый Windows exe | `windows-acceptance.yml` — **Windows acceptance build** | ZIP с exe, исходным SHA и контрольной суммой; без публикации релиза |
| Проверить изменения полностью | `ci.yml` — **CI** | Линтер, форматирование, типы, сборка интерфейса, полная JS-регрессия четырьмя группами при ручном запуске и проверки Rust |
| Пересобрать опубликованный сайт | `pages.yml` — **GitHub Pages** | Публикация сайта, **не** сборка Windows |
| Пересчитать прогресс задач | `roadmap.yml` — **Roadmap progress** | Обновление `ROADMAP.md`; workflow может записать commit |
| Подготовить стабильный выпуск | `release.yml` — **Release** | Установщики, пакет автообновления и черновик релиза; см. [RELEASE.md](RELEASE.md) |

`release-tag-guard.yml` запускается после публикации релиза, `add-to-project.yml` — по событиям Issues. Для обычной тестовой сборки они не нужны.

**Для тестирования выбирайте Windows acceptance build, а не Release.** Не создавайте тег и не меняйте версию ради каждого тестового exe. Пуш сам по себе не гарантирует запуск сборки рабочей ветки: запускайте её явно и проверяйте SHA.

## 1. Один раз подготовить VS Code

1. Откройте папку репозитория через **Файл → Открыть папку**.
2. Откройте **Терминал → Создать терминал**. Команды ниже рассчитаны на PowerShell в Windows.
3. Проверьте наличие Git и GitHub CLI:

   ```powershell
   git --version
   gh --version
   ```

   Если `gh` отсутствует, установите GitHub CLI, например через `winget install --id GitHub.cli --exact`, и перезапустите терминал.

4. При необходимости войдите через браузер:

   ```powershell
   gh auth status
   gh auth login --web --git-protocol https
   ```

   Выполняйте вход самостоятельно в браузере. Не отправляйте пароли, токены и коды подтверждения в чат, исходники или логи.

Для сборки **на GitHub** Node, Rust и Visual Studio на вашем ПК не требуются: их устанавливает runner. Нужны права на запуск Actions в репозитории.

## 2. Сохранить и отправить изменения

1. Нажмите **Сохранить всё** в VS Code. Несохранённый текст редактора в сборку не попадёт.
2. В левом меню **Контроль версий / Source Control** просмотрите diff каждого изменённого файла.
3. Кнопкой **+** добавьте только нужные файлы в staged changes. Не добавляйте exe, `node_modules`, `target`, пользовательские данные, пароли и токены.
4. Введите осмысленное сообщение и нажмите **Commit**.
5. В терминале проверьте ветку и отправьте commit:

   ```powershell
   $branch = (git branch --show-current).Trim()
   git status
   git log -1 --oneline
   git push origin $branch
   ```

Для текущей сессии ветка — **`arena/97d570a8-tvinoferma`**. Не переключайтесь на `main` ради тестовой сборки. Если push отклонён, остановитесь и разберите расхождение; **не используйте force push**.

GitHub собирает **отправленный commit**, а не локальную папку VS Code. Дождитесь успешного push до запуска workflow.

## 3. Запустить тестовую Windows-сборку и полный CI

В том же терминале, после успешного push:

```powershell
$branch = (git branch --show-current).Trim()
$sha = (git rev-parse HEAD).Trim()

gh workflow run ci.yml --ref $branch
gh workflow run windows-acceptance.yml --ref $branch

gh run list --workflow ci.yml --branch $branch --limit 5
gh run list --workflow windows-acceptance.yml --branch $branch --limit 5
```

Новые запуски могут появиться в списке не мгновенно. Если список пока пуст, повторите **только `gh run list`**, не запускайте новую сборку без необходимости.

Скопируйте номер Windows-запуска из столбца `ID` / `DATABASE ID`:

```powershell
$buildId = Read-Host 'Номер Windows-запуска'
gh run watch $buildId --exit-status
gh run view $buildId --json status,conclusion,headSha,url
```

Для CI используйте его собственный номер:

```powershell
$ciId = Read-Host 'Номер CI-запуска'
gh run watch $ciId --exit-status
gh run view $ciId --json status,conclusion,headSha,url
```

Окончательный успех — **`status: completed` и `conclusion: success`**. Сверьте `headSha` с `$sha`. Если после ожидания видите `queued` или `in_progress`, проверка ещё не завершилась: повторите просмотр позже. Успешная упаковка exe не заменяет успешный CI.

Повторный запуск того же workflow для той же ветки может отменить предыдущий: включён `cancel-in-progress`. Не отправляйте серию одинаковых запусков.

## 4. Скачать exe

После успешной Windows-сборки:

```powershell
$out = Join-Path $env:USERPROFILE "Downloads\Tvinoferma-$buildId"
gh run download $buildId --name "Tvinoferma-Windows-acceptance-$buildId" --dir $out
Invoke-Item $out
```

В папке будет `Tvinoferma.exe` и сопроводительные файлы. Встроенный номер версии может совпадать со стабильной версией: различайте сборки по commit SHA в приложенном описании. Артефакт хранится 14 дней; скачивайте его заранее.

Тестовый exe **не изолирует профиль данных** от установленной программы. Для безопасной приёмки используйте отдельную тестовую учётную запись Windows. Перед работой с основным профилем сделайте резервную копию и закройте прежнюю копию приложения. Нужен WebView2 Runtime; Windows может предупредить о неподписанном exe.

### То же самое без команд запуска

Из терминала VS Code можно открыть страницу Actions:

```powershell
gh repo view --web
```

Далее в браузере:

1. **Actions → Windows acceptance build → Run workflow**.
2. Выберите именно нужную ветку, затем **Run workflow**.
3. Откройте запуск и дождитесь зелёного результата.
4. Внизу страницы в **Artifacts** скачайте `Tvinoferma-Windows-acceptance-…` и распакуйте ZIP.
5. Аналогично запустите **CI**, выбрав ту же ветку и не меняя исходники между запусками.

Если кнопки **Run workflow** нет, проверьте выбранный workflow, права доступа и наличие `workflow_dispatch` в его настройках.

## 5. Другие workflows при необходимости

Полный CI уже показан выше. Пересборка сайта:

```powershell
gh workflow run pages.yml --ref $branch
gh run list --workflow pages.yml --branch $branch --limit 5
```

**Осторожно:** Pages публикует выбранный код на общем сайте. Это не приватный просмотр и не способ получить exe. Обычно используйте версию из `main` через страницу Actions, а не экспериментальную ветку.

Для Roadmap и Release используйте инструкции проекта. Roadmap обычно обновляется автоматически; ручной запуск может создать commit в выбранной ветке. Release — отдельное решение с согласованными номерами версии, CHANGELOG и настройками подписи, не повседневная тестовая сборка. Не запускайте его на случайной рабочей ветке. Подробнее: [RELEASE.md](RELEASE.md).

## 6. Если запуск упал

```powershell
gh run view $buildId --web
gh run view $buildId --log-failed
```

Откройте первый красный шаг, а не только последнее сообщение `exit code 1`. Исправьте причину, сделайте новый commit, push и запустите проверку нового SHA. **Re-run jobs** повторяет старый commit — новые изменения он не подхватит.

Если это подтверждённый временный сбой runner или сети и исходники менять не нужно:

```powershell
gh run rerun $buildId --failed
gh run watch $buildId --exit-status
```

При недоступной загрузке логов используйте страницу запуска и аннотации ошибок в Checks. Секреты и реальные данные пользователей в отчёты не копируйте.

## 7. Локальная разработка и сборка на Windows — необязательно

Для локальной Tauri-сборки нужны Node.js 22, Rust stable с MSVC toolchain, Visual Studio Build Tools с компонентами **«Разработка классических приложений на C++»**, Windows SDK и WebView2 Runtime. Зависимости ставятся по `package-lock.json`:

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run tauri -- dev
```

`dev` открывает приложение и следит за изменениями; завершение — `Ctrl+C`. Оно тоже может использовать реальные данные: соблюдайте те же меры безопасности профиля.

Обычный exe без установщика:

```powershell
npm run tauri -- build --no-bundle
```

Результат: `src-tauri\target\release\tvinoferma.exe` при стандартном каталоге Cargo. Для доставки тестовой сборки предпочтительнее GitHub Actions: там сохраняются исходный SHA, контрольная сумма и история проверок. Коммитить exe в репозиторий не нужно.

# Как работать с проектом

Коротко: как запустить, проверить и выпустить Твиноферму. Устройство приложения — в
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), правила работы с сайтом — в
[docs/COMPLIANCE.md](docs/COMPLIANCE.md), порядок работы с задачами — в
[docs/GITHUB-WORKFLOW.md](docs/GITHUB-WORKFLOW.md).

## Что нужно установить

- [Node.js](https://nodejs.org) 20.19 или новее.
- [Rust](https://rustup.rs) (stable) и [зависимости Tauri для Windows](https://tauri.app/start/prerequisites/)
  (Microsoft C++ Build Tools, WebView2).

```powershell
npm ci
```

## Запуск

| Команда | Что делает |
| --- | --- |
| `npm run tauri dev` | Приложение целиком (окно Tauri + Rust). Первая сборка Rust долгая, дальше быстрее |
| `npm run dev` | Только интерфейс в браузере (`http://localhost:1420`). Rust-команд нет: скрытые окна, пароли в хранилище ОС и обновления не работают |
| `npm run build` | Сборка интерфейса в `dist/` |
| `npm run shots` | Снимки интерфейса и проверка вёрстки в headless Edge: `node scripts/ui-shots.mjs --out docs/screenshots/after`. Данные — вымышленные из `tests/fixtures/ui-demo-state.json` |

## Проверки перед коммитом

```powershell
npm run check
```

Это три шага подряд:

1. `npm run lint` — ESLint (опечатки, неиспользуемые переменные, забытые импорты).
2. `npm run typecheck` — проверка типов по JSDoc. Пока включена только в файлах с первой строкой
   `// @ts-check` (сейчас `js/core/` и часть `js/data/`). Новые файлы в этих папках начинайте с неё.
   Чтобы включить в старом файле: добавьте строку, запустите `npm run typecheck`, исправьте ошибки.
3. `npm test` — тесты (vitest + jsdom). Парсеры проверяются на сохранённых страницах сайта в `tests/fixtures/`.

Для Rust (в папке `src-tauri`):

```powershell
cargo test
cargo fmt
cargo clippy --all-targets -- -D warnings
```

Форматирование: `npm run format -- путь/к/файлу.js` приводит файл к стилю Prettier (`.prettierrc.json`).
Весь старый код автоматически не переформатируется, чтобы не раздувать историю изменений. Форматируйте
только те файлы, которые правите.

CI (`.github/workflows/ci.yml`) запускает то же самое на GitHub для каждого pull request.

## Ветки, коммиты, Issues

- Каждая задача — Issue из [ROADMAP.md](ROADMAP.md); в PR пишите `Closes #N`.
- Ветки: `fix/…`, `feat/…`, `chore/…`. Коммиты — короткое описание на русском, что и зачем.
- Для парсеров: сохраните страницу в `tests/fixtures/` скриптом `scripts/sanitize-fixture.mjs`
  (он убирает личные данные), проверьте результат глазами и добавьте тест. Подробно: [docs/FIXTURES.md](docs/FIXTURES.md).
- Менялась схема `state.json` — добавьте миграцию в `js/core/migrations.js` и тест на старом файле
  (`tests/migrations.test.js`). Менялся формат экспорта — старые файлы должны импортироваться.

## Секреты и личные данные

- Не коммитьте пароли, e-mail, куки, токены, `*.key` (ключ подписи обновлений) и реальные `state.json`.
- Скриншоты и фикстуры проверяйте глазами: на них часто видны ники и баланс.

## Выпуск версии

Полная инструкция — [docs/RELEASE.md](docs/RELEASE.md). Кратко:

```powershell
npm run version:bump 0.4.0   # версия сразу в package.json, tauri.conf.json, Cargo.toml, Cargo.lock
git add -A
git commit -m "Версия 0.4.0"
git push
git tag v0.4.0
git push origin v0.4.0       # запускает сборку установщиков и черновик релиза
```

Поддерживается только сборка для Windows (`.msi` и `-setup.exe`). Сборки для macOS и Linux не
проверяются.

## Зависимости

Dependabot раз в неделю присылает PR с обновлениями npm, cargo и GitHub Actions. Пакеты Tauri
(`@tauri-apps/*` в npm и `tauri*` в Cargo) обновляйте вместе, иначе версии JS и Rust частей разойдутся.

# Твиноферма

Desktop-приложение (Tauri v2 + Vanilla JS) для учёта персонажей PW Online: пати, древние монеты,
проходки в данжи, марафоны с заданиями, этапами и наградами, синхронизация с pwonline.ru.

## Возможности

- **Персонажи и пати** — карточки, профили, теги, фильтры (класс, пати, вход, тег), массовые действия
  над выбранными персонажами (проверка входа, балансы, теги, перенос в пати, удаление).
- **Синхронизация с сайтом** — у каждого персонажа свой профиль браузера. Проверка входа, баланс ДМ,
  прогресс марафонов выполняются в скрытых окнах через общую очередь: лимит окон, повторы при
  таймауте и «Проверке безопасности».
- **Марафоны** — поиск на сайте, разбор страницы и новости (этапы, задания, награды, бонусы),
  сверка прогресса, запас дней, ручные поправки, итоги.
- **Безопасность** — email, пароли и телефоны хранятся в хранилище учётных данных ОС
  (Windows Credential Manager / macOS Keychain / Secret Service), а не в `state.json`.
- **Данные** — атомарная запись `state.json`, ротация бэкапов, бэкап перед миграцией / импортом /
  восстановлением, единая версия схемы (`schemaVersion`) с миграциями, экспорт/импорт JSON.
- **Уведомления** — «не успевает» по марафону, конец марафона, ежедневное напоминание.
- **Трей и горячие клавиши** — сворачивание в трей, быстрые действия из меню иконки, фоновая проверка входа.
  Список клавиш — в «Настройки → Горячие клавиши».
- **Автообновление** — из GitHub Releases (tauri-plugin-updater).

## Запуск

Требования: Node.js 20+, Rust stable, [зависимости Tauri](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev      # desktop-приложение
npm run dev            # только интерфейс в браузере (данные в localStorage, без синхронизации)
npm test               # тесты (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build    # установщик локально (без файлов автообновления)
```

## Данные

| Что | Где |
| --- | --- |
| Состояние | `%APPDATA%\com.tvinoferma.desktop\tvinoferma_data\state.json` |
| Бэкапы | там же, `state.backup-<время>[-метка].json` |
| Профили браузера персонажей | `%APPDATA%\com.tvinoferma.desktop\pw-sync-profiles\<id>` |
| Email / пароли / телефоны | хранилище учётных данных ОС, служба `com.tvinoferma.desktop` |

Бэкапы и `state.json` не содержат учётных данных. Для переноса на другой ПК используйте
«Экспорт всех данных» — в экспорт контакты попадают.

## Структура

```txt
index.html                  разметка вкладок
css/                        стили (variables, layout, cards, components, marathon, modal, fab…)
js/
  main.js                   загрузка: миграции → контакты из keychain → модули → фоновые задачи
  state.js                  состояние и нормализация
  migrations.js             версии схемы state.json и миграции
  storage.js                очередь записей, выбор адаптера, бэкапы
  storageAdapters/          tauriAdapter (Rust-команды) и localStorageAdapter (браузер)
  secrets.js                контакты ↔ хранилище учётных данных ОС
  characters.js             сетка персонажей, фильтры, теги, массовые действия
  characters/               форма, профиль, шаблон персонажа
  parties/                  пати
  marathon.js, marathons/   марафоны: модель, мастер, сверка, разбор новостей, графики
  syncManager.js            вход, балансы, помощник входа
  scripts/                  очередь скриптов, вызовы Rust-команд
  notifications.js          системные уведомления
  desktop.js                трей, фоновые проверки, горячие клавиши
  updater.js                автообновление
  taskLog.js                журнал фоновых задач
src-tauri/src/
  lib.rs                    сборка приложения, плагины, обработчики окон
  windows.rs                окна и профили браузера персонажей
  parsers.rs                ожидание ответа скрипта, «Проверка безопасности»
  auth.rs, balance.rs       вход и баланс
  marathons.rs              марафоны
  commands/                 state.json, бэкапы, keychain
  tray.rs                   иконка в трее
  scripts/*.js              скрипты, внедряемые в страницы сайта
tests/                      Vitest + фикстуры
.github/workflows/          CI (тесты) и Release (установщики + latest.json)
```

## Релиз и автообновление

1. Один раз создать ключ подписи: `npm run tauri signer generate -- -w ~/.tauri/tvinoferma.key`.
2. Публичный ключ вставить в `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
3. Приватный ключ и пароль добавить в секреты GitHub: `TAURI_SIGNING_PRIVATE_KEY`,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Поднять версию в `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, затем
   `git tag v0.2.0 && git push origin v0.2.0`. Workflow **Release** соберёт `.msi`/`.exe`
   и `latest.json` в черновик релиза — опубликуйте его.

## Миграции данных

Версия схемы — `SCHEMA_VERSION` в `js/migrations.js`. Чтобы изменить формат: увеличьте версию и
добавьте функцию в `MIGRATIONS`. При запуске старый файл сначала копируется в бэкап
`…-pre-migration-vN`, затем мигрирует. Тест — в `tests/migrations.test.js`.

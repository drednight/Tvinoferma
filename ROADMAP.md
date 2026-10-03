# Roadmap Tvinoferma

Планы развития [Tvinoferma](https://github.com/drednight/Tvinoferma): менеджер персонажей, партий и марафонов для Perfect World (Tauri 2 + JavaScript).

- Живой список задач: [Issues](../../issues) и [Milestones](../../milestones).
- Подробное описание каждого пункта, сравнение планов, риски и открытые вопросы: [docs/ROADMAP-FULL.md](docs/ROADMAP-FULL.md).
- Как вести роадмап на GitHub: [docs/GITHUB-WORKFLOW.md](docs/GITHUB-WORKFLOW.md).
- Предложить идею: [новый Issue](../../issues/new/choose).

> Блок ниже обновляется автоматически (workflow `Roadmap progress`) по состоянию Issues. Правьте не его, а сами Issues. Пункт с галочкой — закрытый Issue.

## Легенда

| Обозначение | Значение |
| --- | --- |
| `prio/critical` ... `prio/low` | Приоритет: критичный, высокий, средний, низкий |
| `effort/S`, `M`, `L` | Трудоёмкость: до дня, 2–5 дней, неделя и больше |
| `source/plan`, `pdf`, `idea` | Откуда пункт: исходный план, внешний роадмап, предложение |
| `type/bug`, `feature`, `infra` | Тип: ошибка, функция, репозиторий и CI |
| `stage/00` ... `stage/13` | Этап роадмапа |

## Версии

| Версия | Тема |
| --- | --- |
| v0.2.3 | Баги: баланс монет и фильтр классов |
| v0.3 | Описания заданий, несколько партий, заметки, чистый репозиторий |
| v0.4 | Устойчивость парсеров и данные |
| v0.5 | Умная очередь и «Проверка безопасности» |
| v0.6 | Промокоды, шифрование экспорта |
| v0.7 | Данжи, каталог контента, дашборд |
| v0.8 | Переводы и шаблоны рун |
| v0.9 | Поиск, безопасность данных |
| v1.0 | Стабильный релиз: changelog, E2E, тесты |
| После 1.0 | Инжекция, банк, арена, облако, косметика |

## Прогресс

<!-- roadmap:start -->
**Всего выполнено:** `█░░░░░░░░░` 10/71 (14%) · обновлено 2026-10-03

### v0.2.3 — Баги: баланс монет и фильтр классов

`██████████` 2/2 (100%)

- [x] [#1](https://github.com/drednight/Tvinoferma/issues/1) **0.1** Баланс монет: 28,5 превращается в 285 — Критичный, S
- [x] [#2](https://github.com/drednight/Tvinoferma/issues/2) **0.2** Фильтр по классам не обновляется после добавления персонажа — Высокий, S

### v0.3 — Описания заданий, несколько партий, заметки, чистый репозиторий

`████████░░` 7/9 (78%)

- [x] [#3](https://github.com/drednight/Tvinoferma/issues/3) **0.3** Описания заданий марафона — Высокий, M
- [x] [#4](https://github.com/drednight/Tvinoferma/issues/4) **0.4** Несколько партий у одного персонажа — Высокий, M
- [x] [#5](https://github.com/drednight/Tvinoferma/issues/5) **1.1** `ROADMAP.md` в репозитории и Issues — Высокий, S
- [ ] [#6](https://github.com/drednight/Tvinoferma/issues/6) **1.2** About, topics, скриншоты, лицензия — Средний, S
- [x] [#7](https://github.com/drednight/Tvinoferma/issues/7) **1.3** ESLint + Prettier + `checkJs` — Средний, S
- [ ] [#8](https://github.com/drednight/Tvinoferma/issues/8) **1.4** Rust: `clippy`, `rustfmt`, `cargo audit`; `npm audit` — Средний, S
- [x] [#11](https://github.com/drednight/Tvinoferma/issues/11) **1.7** Документация для разработчика — Низкий, S
- [x] [#20](https://github.com/drednight/Tvinoferma/issues/20) **3.2** Примечания в карточке персонажа — Высокий, S
- [x] [#21](https://github.com/drednight/Tvinoferma/issues/21) **3.3** Проверка авторизации вручную — Средний, S

### v0.4 — Устойчивость парсеров и данные

`█░░░░░░░░░` 1/9 (11%)

- [ ] [#9](https://github.com/drednight/Tvinoferma/issues/9) **1.5** Фикстуры страниц сайта и тесты парсеров — Высокий, M
- [ ] [#10](https://github.com/drednight/Tvinoferma/issues/10) **1.6** Единый лог с ротацией и диагностика — Средний, M
- [ ] [#12](https://github.com/drednight/Tvinoferma/issues/12) **2.1** Health-check парсеров — Высокий, M
- [ ] [#13](https://github.com/drednight/Tvinoferma/issues/13) **2.2** Селекторы и регулярные выражения в одном конфиге — Высокий, M
- [ ] [#16](https://github.com/drednight/Tvinoferma/issues/16) **2.5** Метки свежести данных — Средний, S
- [ ] [#19](https://github.com/drednight/Tvinoferma/issues/19) **3.1** Марафоны: довести до плана — Высокий, M
- [ ] [#22](https://github.com/drednight/Tvinoferma/issues/22) **3.4** Экспорт и импорт в CSV — Средний, M
- [x] [#70](https://github.com/drednight/Tvinoferma/issues/70) **7.9** Кнопка «Доступно обновление» вместо всплывающего окна — Средний, M
- [ ] [#71](https://github.com/drednight/Tvinoferma/issues/71) **7.10** Стилизованные полосы прокрутки — Низкий, S

### v0.5 — Умная очередь и «Проверка безопасности»

`░░░░░░░░░░` 0/4 (0%)

- [ ] [#14](https://github.com/drednight/Tvinoferma/issues/14) **2.3** Умная очередь — Средний, M
- [ ] [#15](https://github.com/drednight/Tvinoferma/issues/15) **2.4** Сценарий «Проверка безопасности» — Высокий, M
- [ ] [#17](https://github.com/drednight/Tvinoferma/issues/17) **2.6** Режим «только чтение» для скриптов чтения — Средний, S
- [ ] [#18](https://github.com/drednight/Tvinoferma/issues/18) **2.7** Устойчивость к сбоям окна и сети — Средний, M

### v0.6 — Промокоды, шифрование экспорта

`░░░░░░░░░░` 0/5 (0%)

- [ ] [#23](https://github.com/drednight/Tvinoferma/issues/23) **3.5** Серверы и статусы персонажей — Средний, S
- [ ] [#25](https://github.com/drednight/Tvinoferma/issues/25) **4.1** Активация промокодов — Высокий, L
- [ ] [#27](https://github.com/drednight/Tvinoferma/issues/27) **4.3** Общий «Журнал скриптов» — Средний, M
- [ ] [#28](https://github.com/drednight/Tvinoferma/issues/28) **4.4** Автобэкап перед массовыми операциями — Средний, S
- [ ] [#47](https://github.com/drednight/Tvinoferma/issues/47) **8.1** Шифрование экспорта паролем — Высокий, M

### v0.7 — Данжи, каталог контента, дашборд

`░░░░░░░░░░` 0/7 (0%)

- [ ] [#30](https://github.com/drednight/Tvinoferma/issues/30) **5.1** Циклический календарь — Высокий, S
- [ ] [#31](https://github.com/drednight/Tvinoferma/issues/31) **5.2** Таблица допусков по Sky Level — Высокий, M
- [ ] [#32](https://github.com/drednight/Tvinoferma/issues/32) **5.3** Сравнение статов с рекомендуемыми — Средний, M
- [ ] [#33](https://github.com/drednight/Tvinoferma/issues/33) **5.4** Учёт пропусков в данжи — Средний, S
- [ ] [#34](https://github.com/drednight/Tvinoferma/issues/34) **5.5** Вкладка «Данжи» и интеграция с дашбордом — Средний, S
- [ ] [#35](https://github.com/drednight/Tvinoferma/issues/35) **6.1** Удалённый каталог контента — Средний, M
- [ ] [#39](https://github.com/drednight/Tvinoferma/issues/39) **7.1** Дашборд «Сегодня» — Высокий, M

### v0.8 — Переводы и шаблоны рун

`░░░░░░░░░░` 0/3 (0%)

- [ ] [#26](https://github.com/drednight/Tvinoferma/issues/26) **4.2** Перевод предметов и ресурсов — Высокий, L
- [ ] [#36](https://github.com/drednight/Tvinoferma/issues/36) **6.2** Карточки шаблонов — Средний, M
- [ ] [#37](https://github.com/drednight/Tvinoferma/issues/37) **6.3** Шапка и форма заявок — Средний, S

### v0.9 — Поиск, безопасность данных

`░░░░░░░░░░` 0/8 (0%)

- [ ] [#40](https://github.com/drednight/Tvinoferma/issues/40) **7.2** Командная палитра Ctrl+K — Средний, M
- [ ] [#41](https://github.com/drednight/Tvinoferma/issues/41) **7.3** Уведомления и расписание — Средний, M
- [ ] [#42](https://github.com/drednight/Tvinoferma/issues/42) **7.4** Календарь / таймлайн марафонов — Средний, M
- [ ] [#48](https://github.com/drednight/Tvinoferma/issues/48) **8.2** Валидация `state.json` схемой — Средний, M
- [ ] [#49](https://github.com/drednight/Tvinoferma/issues/49) **8.3** Автобэкап и восстановление — Средний, M
- [ ] [#50](https://github.com/drednight/Tvinoferma/issues/50) **8.4** Блокировка PIN-кодом — Низкий, M
- [ ] [#51](https://github.com/drednight/Tvinoferma/issues/51) **8.5** Права и изоляция Tauri — Высокий, M
- [ ] [#52](https://github.com/drednight/Tvinoferma/issues/52) **8.6** Обнаружение дублей и защита от потери — Средний, S

### v1.0 — Стабильный релиз: changelog, E2E, тесты

`░░░░░░░░░░` 0/4 (0%)

- [ ] [#63](https://github.com/drednight/Tvinoferma/issues/63) **13.1** `CHANGELOG.md` и semver — Средний, S
- [ ] [#64](https://github.com/drednight/Tvinoferma/issues/64) **13.2** Подпись установщика Windows — Средний, M
- [ ] [#66](https://github.com/drednight/Tvinoferma/issues/66) **13.4** E2E-тесты (tauri-driver) — Средний, L
- [ ] [#67](https://github.com/drednight/Tvinoferma/issues/67) **13.5** Покрытие тестами — Средний, M

### После 1.0 — Инжекция, банк, арена, облако, косметика

`░░░░░░░░░░` 0/20 (0%)

- [ ] [#24](https://github.com/drednight/Tvinoferma/issues/24) **3.6** Сохранённые представления — Низкий, S
- [ ] [#29](https://github.com/drednight/Tvinoferma/issues/29) **4.5** Пресеты скриптов — Низкий, S
- [ ] [#38](https://github.com/drednight/Tvinoferma/issues/38) **6.4** Личные шаблоны пользователя — Низкий, S
- [ ] [#43](https://github.com/drednight/Tvinoferma/issues/43) **7.5** Виртуализация списка — Низкий, M
- [ ] [#44](https://github.com/drednight/Tvinoferma/issues/44) **7.6** Темы и компактный режим — Низкий, S
- [ ] [#45](https://github.com/drednight/Tvinoferma/issues/45) **7.7** Онбординг-мастер — Низкий, S
- [ ] [#46](https://github.com/drednight/Tvinoferma/issues/46) **7.8** Быстрый доступ и мелочи — Низкий, S
- [ ] [#53](https://github.com/drednight/Tvinoferma/issues/53) **9.1** CSS-очистка — Низкий, S
- [ ] [#54](https://github.com/drednight/Tvinoferma/issues/54) **9.2** Панель Tvinoferma поверх страницы — Низкий, M
- [ ] [#55](https://github.com/drednight/Tvinoferma/issues/55) **9.3** Оценка рисков — Низкий, S
- [ ] [#56](https://github.com/drednight/Tvinoferma/issues/56) **10.1** Журнал доходов и расходов — Низкий, M
- [ ] [#57](https://github.com/drednight/Tvinoferma/issues/57) **10.2** Отчёты и графики — Низкий, M
- [ ] [#58](https://github.com/drednight/Tvinoferma/issues/58) **10.3** ROI фермы — Низкий, M
- [ ] [#59](https://github.com/drednight/Tvinoferma/issues/59) **11.1** Интеграция внешнего трекера — Низкий, M
- [ ] [#60](https://github.com/drednight/Tvinoferma/issues/60) **12.1** Бэкап в папку, которую синхронизирует другой сервис — Низкий, S
- [ ] [#61](https://github.com/drednight/Tvinoferma/issues/61) **12.2** Google Sheets — экспорт таблиц — Низкий, L
- [ ] [#62](https://github.com/drednight/Tvinoferma/issues/62) **12.3** Синхронизация между ПК — Низкий, L
- [ ] [#65](https://github.com/drednight/Tvinoferma/issues/65) **13.3** Каналы stable / beta — Низкий, M
- [ ] [#68](https://github.com/drednight/Tvinoferma/issues/68) **13.6** Проверка сборок macOS / Linux — Низкий, M
- [ ] [#69](https://github.com/drednight/Tvinoferma/issues/69) **13.7** Размер установщика — Низкий, S

<!-- roadmap:end -->

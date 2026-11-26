//! Клановый сайт (pw-eternals.ru): отдельное окно браузера со своим профилем.
//!
//! Зачем отдельный модуль, а не `open_sync_window`: окно персонажа имеет метку `sync-win-<id>`,
//! и открыть в нём чужой сайт значит подменить окно pwonline.ru и сломать синхронизацию.
//!
//! Сводка профиля (события, пати и опрос) забирается командой `guild_sync`. Если окна клана нет,
//! она открывает СКРЫТОЕ окно с тем же профилем: вход сохраняется в профиле, поэтому после
//! первого входа обновление работает без открытия сайта. Если сессия истекла, команда
//! возвращает ошибку `login`.
//!
//! Отметка на ивенте уходит тем же запросом, что и форма сайта (`handlers/event_response.php`),
//! ответ возвращается в hash (`#TFETA1_`). Голос в опросе отправляется в `handlers/vote.php`
//! только после проверки актуальных вариантов, результат возвращается в `#TFETV1_`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::webview::NewWindowResponse;
use tauri::{command, AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const GUILD_LABEL: &str = "guild-win";
/// Метка видимого окна клана, которое открывает кнопка «Открыть сайт».
/// Отдельно от скрытого окна (`GUILD_LABEL`): кнопка должна запускать новое видимое
/// окно, а не поднимать скрытое, которое вспыхило для фонового обмена данными.
const GUILD_VIEW_LABEL: &str = "guild-view";
/// Адрес кланового сайта. Это настоящий домен, а не название раздела: при переименовании
/// модуля `eternals` → `guild` его уже однажды задели, и окно открывало несуществующий сайт.
const GUILD_URL: &str = "https://pw-eternals.ru/index.php";
/// Скрипт окна: панель навигации, разбор профиля и отметка на ивенте. Во всех страницах окна.
const GUILD_SCRIPT: &str = include_str!("scripts/guild.js");
/// Начало hash со сводкой профиля (или признаком «нужен вход»).
const REPORT_HASH: &str = "#TFETE1_";
/// Начало hash с результатом отметки на ивенте.
const ACTION_HASH: &str = "#TFETA1_";
/// Отдельный hash с результатом голосования в опросе.
const VOTE_HASH: &str = "#TFETV1_";
/// Отдельный hash с признаком готовности окна клана к голосованию.
/// Опубликовывается самим окном (eval), а не сводкой профиля: готовность проверяют
/// без требования успешной сводки, чтобы ложный «login» от index.php не блокировал голос.
const READY_HASH: &str = "#TFETW1_";
/// Сколько ждём страницу профиля при обновлении, секунд.
const SYNC_TIMEOUT_SECS: u64 = 25;
/// Сколько ждём ответ сайта на отметку, секунд.
const RESPOND_TIMEOUT_SECS: u64 = 20;
/// Сколько раз повторяем чтение профиля на свежем окне, если попали на страницу входа.
/// На свежем окне первая загрузка index.php может прийти раньше, чем браузер подтянет
/// сохранённые cookie входа — тогда парсер видит страницу входа, хотя сессия жива.
const LOGIN_RETRY_ATTEMPTS: u32 = 3;
/// Пауза между повторами «login», чтобы колодки успели устроиться.
const LOGIN_RETRY_DELAY_SECS: u64 = 2;

/// Идёт ли обновление: два запуска одновременно (кнопка и суточная проверка) не нужны.
static SYNC_BUSY: AtomicBool = AtomicBool::new(false);

/// Каталог профилей клана — отдельный от профилей персонажей (`pw-sync-profiles`).
///
/// Имя каталога менять нельзя: это путь на диске, и смена имени бросила бы сохранённый
/// профиль браузера вместе с входом на сайт. Переименование модуля его уже однажды задело.
fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pw-eternals-profiles")
        .join("clan");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;
    Ok(dir)
}

fn clan_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(GUILD_LABEL)
}

/// Создаёт окно клана. `visible = false` — скрытое окно для фонового обновления.
///
/// Создаётся только из `async` команд: на Windows создание окна из синхронной команды приводит
/// к взаимной блокировке, и `invoke` тогда не возвращается.
fn create_clan_window(
    app: &AppHandle,
    label: &str,
    visible: bool,
) -> Result<WebviewWindow, String> {
    let url = Url::parse(GUILD_URL).map_err(|e| e.to_string())?;
    let origin =
        serde_json::to_string(&url.origin().ascii_serialization()).map_err(|e| e.to_string())?;
    let script = format!("window.__tfGuildOrigin = {};\n{}", origin, GUILD_SCRIPT);
    // label попадает в 'static-closure on_new_window — берём собственную копию.
    let label = label.to_string();
    let handle = app.clone();
    WebviewWindowBuilder::new(app, label.clone(), WebviewUrl::External(url))
        .title("Клан")
        .inner_size(1100.0, 800.0)
        .resizable(true)
        .visible(visible)
        .data_directory(profile_dir(app)?)
        .initialization_script(script)
        .on_new_window(move |url, _features| {
            // Ссылки, которые сайт открывает в новом окне, показываем в этом же окне
            if matches!(url.scheme(), "http" | "https") {
                if let Some(win) = handle.get_webview_window(&label) {
                    tauri::async_runtime::spawn(async move {
                        let _ = win.navigate(url);
                    });
                }
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())
}

/// Открывает видимое окно клана (кнопка «Открыть сайт»): запускает новое видимое окно,
/// а не поднимает скрытое, которое могло вспыхнуть для фонового обмена данными.
#[command]
pub async fn open_guild_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(GUILD_VIEW_LABEL) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        crate::parsers::tf_log(&app, "guild", "info", "Открыто видимое окно клана");
        return Ok(());
    }
    create_clan_window(&app, GUILD_VIEW_LABEL, true)?;
    crate::parsers::tf_log(&app, "guild", "info", "Открыто видимое окно клана");
    Ok(())
}

/// Закрывает видимое окно клана.
#[command]
pub async fn close_guild_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(GUILD_VIEW_LABEL) {
        win.close().map_err(|e| e.to_string())?;
        crate::parsers::tf_log(&app, "guild", "info", "Закрыто видимое окно клана");
    }
    Ok(())
}

/// Открыто ли окно клана (видимое или скрытое).
#[command]
pub fn guild_window_exists(app: AppHandle) -> bool {
    clan_window(&app).is_some() || app.get_webview_window(GUILD_VIEW_LABEL).is_some()
}

/// Обновляет сводку клана: события и пати.
///
/// Работает и без открытого окна: если его нет, открывает скрытое окно с сохранённым профилем
/// и закрывает его после ответа. Возвращает `{ events, parties }` или ошибку:
/// - `login` — сессия на сайте истекла, нужно войти через «Открыть сайт клана»;
/// - `timeout` — страница профиля не открылась за отведённое время;
/// - `busy` — обновление уже идёт.
#[command]
pub async fn guild_sync(app: AppHandle) -> Result<serde_json::Value, String> {
    if SYNC_BUSY.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    crate::parsers::tf_log(
        &app,
        "guild",
        "step",
        "Синхронизация клана: чтение сводки профиля",
    );
    let result = run_sync(&app).await;
    match &result {
        Ok(value) => {
            let events = value
                .get("events")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let parties = value
                .get("parties")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            crate::parsers::tf_log(
                &app,
                "guild",
                "ok",
                format!("Синхронизация клана: событий {events}, пати {parties}"),
            );
        }
        Err(err) => {
            let hint = match err.as_str() {
                "login" => "нужен вход на сайт клана (Открыть сайт клана)",
                "timeout" => "страница не открылась за отведённое время",
                "busy" => "уже идёт синхронизация",
                other => other,
            };
            crate::parsers::tf_log(
                &app,
                "guild",
                "warn",
                format!("Синхронизация клана: {hint}"),
            );
        }
    }
    SYNC_BUSY.store(false, Ordering::SeqCst);
    result
}

async fn run_sync(app: &AppHandle) -> Result<serde_json::Value, String> {
    // Скрытое окно открывается только на время обмена: если видимого окна нет —
    // вспыхиваем скрытое, берём сводку и закрываем. Не держим его постоянно.
    match clan_window(app) {
        Some(win) => wait_for_report(&win).await,
        None => {
            let win = create_clan_window(app, GUILD_LABEL, false)?;
            let result = wait_for_report_with_login_retry(
                &win,
                LOGIN_RETRY_ATTEMPTS,
                Duration::from_secs(LOGIN_RETRY_DELAY_SECS),
            )
            .await;
            let _ = win.destroy();
            result
        }
    }
}

/// Ждёт payload в hash окна. `read_hash_payload` отдаёт `(ошибка, данные)`: ошибка `login`
/// значит, что страница входа, ждать дальше бессмысленно.
async fn wait_for_hash(
    win: &WebviewWindow,
    prefix: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let Ok(url) = win.url() else { continue };
        match crate::parsers::read_hash_payload(url.as_str(), prefix) {
            Some((Some(error), _)) => return Err(error),
            Some((None, data)) => return Ok(data),
            None => {}
        }
    }
    Err("timeout".into())
}

/// Сбрасывает старый hash и просит скрипт разобрать страницу заново, затем ждёт сводку профиля.
/// Иначе прочитали бы прошлую сводку.
async fn wait_for_report(win: &WebviewWindow) -> Result<serde_json::Value, String> {
    let _ = win.eval(
        "history.replaceState(null, '', location.pathname + location.search);\
         if (window.__tfGuildRefresh) window.__tfGuildRefresh();",
    );
    wait_for_hash(win, REPORT_HASH, Duration::from_secs(SYNC_TIMEOUT_SECS)).await
}

/// Ждёт, чтобы страница в окне клана отгрузилась, а скрипт с функциями был готов.
/// Не требует успешной сводки профиля: проверка входа через fetch index.php могла бы
/// ложно сработать, хотя сеанс жив. Голос сам проверит опрос и отправит запрос;
/// если сеанс действительно неактуален — придёт понятная ошибка от сайта, не «login».
async fn wait_for_window_ready(win: &WebviewWindow) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(SYNC_TIMEOUT_SECS);
    // eval выполняет JS и возвращает только статус выполнения: результат выражения
    // публикует сам скрипт в URL-hash (как сводку и голос), а Rust читает его через URL.
    let ready_script = "(function(){var ready = document.readyState === 'complete' && typeof window.__tfGuildVote === 'function';\
        history.replaceState(null, '', location.pathname + location.search + '#TFETW1_' + encodeURIComponent(JSON.stringify({data: ready, error: null})));})();";
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if win.eval(ready_script).is_err() {
            continue;
        }
        let Ok(url) = win.url() else { continue };
        // Hash с готовностью может остаться от прошлого цикла: читаем его только
        // после того, как скрипт заново опубликовал актуальное значение.
        if let Some((None, serde_json::Value::Bool(true))) =
            crate::parsers::read_hash_payload(url.as_str(), READY_HASH)
        {
            return Ok(());
        }
    }
    Err("timeout".into())
}

/// Ждёт сводку профиля, но сначала даёт странице отгрузиться, а колодкам — устроиться.
///
/// На свежем скрытом окне первая загрузка `index.php` может прийти раньше, чем браузер
/// подтянет сохранённые cookie входа: парсер тогда видит страницу входа (`login`), хотя
/// сессия в профиле живая. Поэтому «login» пробуем повторить с паузами — повтор обычно
/// даёт настоящую сводку. Любую другую ошибку (`timeout`, `page`) сразу возвращаем.
async fn wait_for_report_with_login_retry(
    win: &WebviewWindow,
    attempts: u32,
    delay: Duration,
) -> Result<serde_json::Value, String> {
    wait_for_window_ready(win).await?;
    let mut last: Result<serde_json::Value, String> = Err("timeout".into());
    for attempt in 0..attempts {
        match wait_for_report(win).await {
            Ok(report) => return Ok(report),
            Err(error) => {
                let is_login = error == "login";
                last = Err(error);
                if !is_login || attempt + 1 >= attempts {
                    break;
                }
                crate::parsers::tf_log(
                    win.app_handle(),
                    "guild",
                    "warn",
                    format!(
                        "Свежее окно клана попало на страницу входа, повтор чтения профиля ({}/{})",
                        attempt + 1,
                        attempts
                    ),
                );
                tokio::time::sleep(delay).await;
            }
        }
    }
    Err(last.unwrap_err())
}

/// Отмечает ивент на сайте (`yes` — «Пойду», `no` — «Не пойду»).
///
/// Работает и без открытого окна: если его нет, поднимается скрытое окно с сохранённым
/// профилем и закрывается после ответа. Значения проверяются здесь: в окно уходит только
/// число и одно из двух слов.
///
/// Возвращает `{ ok, eventId, response, message }` — ответ сайта. Ошибки приходят строкой:
/// `login`, `timeout`, `busy`.
#[command]
pub async fn guild_set_response(
    app: AppHandle,
    event_id: String,
    response: String,
) -> Result<serde_json::Value, String> {
    if event_id.is_empty() || event_id.len() > 12 || !event_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Некорректный номер события".into());
    }
    if response != "yes" && response != "no" {
        return Err("Некорректный ответ".into());
    }
    if SYNC_BUSY.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    crate::parsers::tf_log(
        &app,
        "guild",
        "step",
        format!(
            "Отметка ивента {event_id}: {}",
            if response == "yes" {
                "Пойду"
            } else {
                "Не пойду"
            }
        ),
    );
    let result = run_respond(&app, &event_id, &response).await;
    SYNC_BUSY.store(false, Ordering::SeqCst);
    result
}

async fn run_respond(
    app: &AppHandle,
    event_id: &str,
    response: &str,
) -> Result<serde_json::Value, String> {
    match clan_window(app) {
        Some(win) => send_response(&win, event_id, response, false).await,
        None => {
            let win = create_clan_window(app, GUILD_LABEL, false)?;
            let result = send_response(&win, event_id, response, true).await;
            let _ = win.destroy();
            result
        }
    }
}

async fn send_response(
    win: &WebviewWindow,
    event_id: &str,
    response: &str,
    fresh_window: bool,
) -> Result<serde_json::Value, String> {
    if fresh_window {
        // Окно только что создано: скрипт ещё не успел встать. Ждём разбор страницы —
        // заодно убеждаемся, что вход на сайте живой (на странице входа придёт `login`).
        // На свежем окне колодки входа могут устроиться не сразу, поэтому «login»
        // пробуем повторить (см. wait_for_report_with_login_retry).
        wait_for_report_with_login_retry(
            win,
            LOGIN_RETRY_ATTEMPTS,
            Duration::from_secs(LOGIN_RETRY_DELAY_SECS),
        )
        .await?;
    }
    // Старый ответ мог остаться в hash от прошлой отметки — иначе прочитаем его.
    let _ = win.eval(
        "if (location.hash.indexOf('#TFETA1_') === 0) history.replaceState(null, '', location.pathname + location.search);",
    );
    win.eval(format!(
        "if (window.__tfGuildRespond) window.__tfGuildRespond({}, {});",
        event_id,
        serde_json::Value::String(response.to_string())
    ))
    .map_err(|e| e.to_string())?;
    let label = if response == "yes" {
        "Пойду"
    } else {
        "Не пойду"
    };
    match wait_for_hash(win, ACTION_HASH, Duration::from_secs(RESPOND_TIMEOUT_SECS)).await {
        Ok(v) => {
            let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
            let message = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
            if ok {
                crate::parsers::tf_log(
                    win.app_handle(),
                    "guild",
                    "ok",
                    format!("Ивент {event_id}: {label} — отметка принята"),
                );
            } else {
                crate::parsers::tf_log(
                    win.app_handle(),
                    "guild",
                    "warn",
                    format!("Ивент {event_id}: {label} — не принято: {message}"),
                );
            }
            Ok(v)
        }
        Err(error) => {
            crate::parsers::tf_log(
                win.app_handle(),
                "guild",
                "warn",
                format!("Ивент {event_id}: {label} — ошибка: {error}"),
            );
            Err(error)
        }
    }
}

/// Одна запись пакета отметок: номер события и выбранный ответ.
#[derive(serde::Deserialize)]
pub struct GuildEventChoice {
    #[serde(rename = "eventId")]
    event_id: String,
    response: String,
}

/// Перенос пакета ответов в одно скрытое окно: открываем окно один раз, отмечаем в нём
/// все события и возвращаем результат по каждому. Окно закрывается после пакета — не
/// держим его постоянно. Пакет избегает создания по одному окну на каждый POST и даёт
/// единую авторизованную сессию для всех отметок.
#[command]
pub async fn guild_set_responses(
    app: AppHandle,
    events: Vec<GuildEventChoice>,
) -> Result<serde_json::Value, String> {
    for choice in &events {
        if choice.event_id.is_empty()
            || choice.event_id.len() > 12
            || !choice.event_id.chars().all(|c| c.is_ascii_digit())
        {
            return Err("Некорректный номер события".into());
        }
        if choice.response != "yes" && choice.response != "no" {
            return Err("Некорректный ответ".into());
        }
    }
    if events.is_empty() {
        return Ok(serde_json::json!({ "ok": true, "results": [] }));
    }
    if SYNC_BUSY.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    crate::parsers::tf_log(
        &app,
        "guild",
        "step",
        format!("Пакет отметок клана: {} ивентов", events.len()),
    );
    let result = run_respond_batch(&app, &events).await;
    SYNC_BUSY.store(false, Ordering::SeqCst);
    result
}

async fn run_respond_batch(
    app: &AppHandle,
    events: &[GuildEventChoice],
) -> Result<serde_json::Value, String> {
    let (win, created) = match clan_window(app) {
        Some(win) => (win, false),
        None => {
            let win = create_clan_window(app, GUILD_LABEL, false)?;
            (win, true)
        }
    };
    let result = send_responses(&win, events, created).await;
    if created {
        let _ = win.destroy();
    }
    result
}

async fn send_responses(
    win: &WebviewWindow,
    events: &[GuildEventChoice],
    fresh_window: bool,
) -> Result<serde_json::Value, String> {
    if fresh_window {
        wait_for_report_with_login_retry(
            win,
            LOGIN_RETRY_ATTEMPTS,
            Duration::from_secs(LOGIN_RETRY_DELAY_SECS),
        )
        .await?;
    }
    let mut results = Vec::with_capacity(events.len());
    for choice in events {
        let event_id = &choice.event_id;
        let response = &choice.response;
        // Старый ответ мог остаться в hash от предыдущей отметки — сбрасываем перед новой.
        let _ = win.eval(
            "if (location.hash.indexOf('#TFETA1_') === 0) history.replaceState(null, '', location.pathname + location.search);",
        );
        win.eval(format!(
            "if (window.__tfGuildRespond) window.__tfGuildRespond({}, {});",
            serde_json::Value::String(event_id.clone()),
            serde_json::Value::String(response.clone()),
        ))
        .map_err(|e| e.to_string())?;
        match wait_for_hash(win, ACTION_HASH, Duration::from_secs(RESPOND_TIMEOUT_SECS)).await {
            Ok(v) => {
                let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
                let message = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
                results.push(serde_json::json!({
                    "eventId": event_id,
                    "response": response,
                    "ok": ok,
                    "message": message,
                }));
                let label = if response == "yes" {
                    "Пойду"
                } else {
                    "Не пойду"
                };
                if ok {
                    crate::parsers::tf_log(
                        win.app_handle(),
                        "guild",
                        "ok",
                        format!("Ивент {event_id}: {label} — отметка принята"),
                    );
                } else {
                    crate::parsers::tf_log(
                        win.app_handle(),
                        "guild",
                        "warn",
                        format!("Ивент {event_id}: {label} — не принято: {message}"),
                    );
                }
            }
            Err(error) => {
                results.push(serde_json::json!({
                    "eventId": event_id,
                    "response": response,
                    "ok": false,
                    "message": error,
                }));
                let label = if response == "yes" {
                    "Пойду"
                } else {
                    "Не пойду"
                };
                crate::parsers::tf_log(
                    win.app_handle(),
                    "guild",
                    "warn",
                    format!("Ивент {event_id}: {label} — ошибка: {error}"),
                );
            }
        }
    }
    Ok(serde_json::json!({ "ok": true, "results": results }))
}

/// Проверяем ввод до передачи в веб-окно. Даже из повреждённого кэша нельзя подставить
/// JavaScript, повторить один вариант или отправить пустой / чрезмерно длинный список.
fn valid_vote(poll_id: &str, option_ids: &[String]) -> bool {
    fn numeric_id(value: &str) -> bool {
        !value.is_empty() && value.len() <= 12 && value.chars().all(|c| c.is_ascii_digit())
    }
    if !numeric_id(poll_id) || option_ids.is_empty() || option_ids.len() > 200 {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    option_ids
        .iter()
        .all(|id| numeric_id(id) && seen.insert(id.as_str()))
}

/// Голосует в актуальном опросе профиля клана; пустой выбор не отправляется.
#[command]
pub async fn guild_vote_poll(
    app: AppHandle,
    poll_id: String,
    option_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    if !valid_vote(&poll_id, &option_ids) {
        return Err("Некорректные варианты опроса".into());
    }
    if SYNC_BUSY.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    crate::parsers::tf_log(
        &app,
        "guild",
        "step",
        format!(
            "Голосование в опросе {poll_id}: варианты [{}]",
            option_ids.join(", ")
        ),
    );
    let result = run_vote(&app, &poll_id, &option_ids).await;
    SYNC_BUSY.store(false, Ordering::SeqCst);
    result
}

async fn run_vote(
    app: &AppHandle,
    poll_id: &str,
    option_ids: &[String],
) -> Result<serde_json::Value, String> {
    match clan_window(app) {
        Some(win) => send_vote(&win, poll_id, option_ids, false).await,
        None => {
            let win = create_clan_window(app, GUILD_LABEL, false)?;
            let result = send_vote(&win, poll_id, option_ids, true).await;
            let _ = win.destroy();
            result
        }
    }
}

/// Видимое окно могло перейти по ссылке на другой сайт. Не отправляем данные или
/// команды туда и не меняем страницу пользователя; в скрытом окне сперва ждём загрузку.
fn ensure_guild_origin(win: &WebviewWindow) -> Result<(), String> {
    let current = win.url().map_err(|e| e.to_string())?;
    let expected = Url::parse(GUILD_URL).map_err(|e| e.to_string())?;
    if current.origin() != expected.origin() {
        return Err("wrong_site".into());
    }
    Ok(())
}

async fn send_vote(
    win: &WebviewWindow,
    poll_id: &str,
    option_ids: &[String],
    fresh_window: bool,
) -> Result<serde_json::Value, String> {
    if !fresh_window {
        ensure_guild_origin(win)?;
    }
    // Ждём готовности страницы и скрипта, но не требуем профильной сводки:
    // проверка входа через fetch index.php могла бы ложно сработать, хотя сеанс жив.
    wait_for_window_ready(win).await?;
    ensure_guild_origin(win)?;
    let origin = Url::parse(GUILD_URL)
        .map_err(|e| e.to_string())?
        .origin()
        .ascii_serialization();
    let origin = serde_json::to_string(&origin).map_err(|e| e.to_string())?;
    let poll = serde_json::to_string(poll_id).map_err(|e| e.to_string())?;
    let options = serde_json::to_string(option_ids).map_err(|e| e.to_string())?;
    win.eval(format!(
        "if (location.origin === {origin}) {{\
         history.replaceState(null, '', location.pathname + location.search);\
         if (window.__tfGuildVote) window.__tfGuildVote({poll}, {options});\
         }}"
    ))
    .map_err(|e| e.to_string())?;
    let opts = option_ids.join(", ");
    match wait_for_hash(win, VOTE_HASH, Duration::from_secs(RESPOND_TIMEOUT_SECS)).await {
        Ok(v) => {
            let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
            let message = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
            if ok {
                crate::parsers::tf_log(
                    win.app_handle(),
                    "guild",
                    "ok",
                    format!("Опрос {poll_id}: варианты [{opts}] — голос отправлен"),
                );
            } else {
                crate::parsers::tf_log(
                    win.app_handle(),
                    "guild",
                    "warn",
                    format!("Опрос {poll_id}: варианты [{opts}] — не принято: {message}"),
                );
            }
            Ok(v)
        }
        Err(error) => {
            crate::parsers::tf_log(
                win.app_handle(),
                "guild",
                "warn",
                format!("Опрос {poll_id}: варианты [{opts}] — ошибка: {error}"),
            );
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn hash_prefixes_do_not_clash_with_collection_or_sync_hashes() {
        // Разные префиксы: окно клана не должно принять чужой hash за свой и наоборот
        assert_ne!(super::REPORT_HASH, super::ACTION_HASH);
        assert_ne!(super::REPORT_HASH, super::VOTE_HASH);
        assert_ne!(super::REPORT_HASH, super::READY_HASH);
        assert_ne!(super::ACTION_HASH, super::VOTE_HASH);
        assert_ne!(super::ACTION_HASH, super::READY_HASH);
        assert_ne!(super::VOTE_HASH, super::READY_HASH);
        assert!(!super::REPORT_HASH.starts_with("#TF_"));
        assert!(!super::ACTION_HASH.starts_with("#TF_"));
        assert!(!super::REPORT_HASH.starts_with("#TFCOL"));
    }

    #[test]
    fn poll_vote_requires_unique_numeric_ids() {
        assert!(super::valid_vote("901", &["501".into(), "502".into()]));
        assert!(!super::valid_vote("", &["501".into()]));
        assert!(!super::valid_vote("1;alert(1)", &["501".into()]));
        assert!(!super::valid_vote("901", &[]));
        assert!(!super::valid_vote("901", &["501".into(), "501".into()]));
        assert!(!super::valid_vote("901", &["-1".into()]));
        assert!(!super::valid_vote("901", &["1234567890123".into()]));
        let too_many: Vec<_> = (1..=201).map(|id| id.to_string()).collect();
        assert!(!super::valid_vote("901", &too_many));
    }
}

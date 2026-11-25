//! Локальный HTTP-сервер внешнего API.
//!
//! Зачем сервер в Rust, а не в JS: `WebView` не умеет слушать порт, а сторонняя
//! программа не может «вызвать функцию» приложения. Поэтому Rust принимает
//! HTTP-запрос, проверяет Host, токен, права и лимиты, а данные читает и меняет
//! существующий JS: запрос уходит событием `external-api-request` в главное окно,
//! ответ возвращается командой `external_api_reply`. Так нормализация, история
//! статов, очередь сохранений и запуск окон остаются в одном месте — в JS, где
//! они уже написаны и покрыты тестами.
//!
//! Главное окно при закрытии сворачивается в трей, а не уничтожается, поэтому
//! JS-контекст жив, пока живёт приложение. Если приложение вышло, сервер
//! останавливается и внешняя программа получает `connection refused` — это и есть
//! проверка «Твиноферма не запущена».
//!
//! Токен здесь только в памяти: он приходит из JS, который хранит его
//! в хранилище ОС (`vault`), а не в `state.json`. Сравнение — постоянного времени.

pub mod audit;
pub mod auth;
pub mod http;

use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use audit::{Audit, AuditEntry};
use auth::{Access, RateLimiter, Scopes};

/// Порт по умолчанию. Документация: `docs/EXTERNAL-API.md`.
pub const DEFAULT_PORT: u16 = 47831;
/// Порт по умолчанию в тестовых сборках (`acceptance`, `acceptance-shared`).
///
/// Тестовая и стабильная сборки — разные процессы, и обе могут быть запущены
/// одновременно. Разные порты по умолчанию не дают им делить один адрес: иначе
/// вторая сборка молча не стартует с «порт занят», а клиент попадает не в то
/// приложение. Порт остаётся настраиваемым — это защита от случайности, а не
/// жёсткое ограничение.
pub const ACCEPTANCE_DEFAULT_PORT: u16 = 47832;
/// Сколько ждём ответ из JS. Запуск окон отвечает сразу (`202 jobId`),
/// поэтому 15 секунд хватает и на самый медленный запрос.
const REPLY_TIMEOUT: Duration = Duration::from_secs(15);
/// Период проверки «не пора ли остановиться» в цикле `accept`.
const ACCEPT_TICK: Duration = Duration::from_millis(50);
/// Сколько соединений обслуживаем одновременно. Больше не нужно: клиент —
/// локальная программа, а не браузер с сотней параллельных загрузок.
const MAX_CONNECTIONS: usize = 16;
/// Имя события моста в главное окно.
const EVENT_NAME: &str = "external-api-request";
/// Страница управления и её файлы собраны в приложение на этапе компиляции.
const PAGE_HTML: &str = include_str!("web/index.html");
const PAGE_CSS: &str = include_str!("web/app.css");
const PAGE_JS: &str = include_str!("web/app.js");
/// Справочник методов для страницы (данные, без логики — см. web/docs.js).
const PAGE_DOCS_JS: &str = include_str!("web/docs.js");
/// Каталог кодов ошибок для страницы (генерируется из js/modules/externalApi/errors.js).
const PAGE_ERRORS_JS: &str = include_str!("web/errors.js");
/// Модель действий страницы: что можно нажать и какой запрос уйдёт (web/actions.js).
const PAGE_ACTIONS_JS: &str = include_str!("web/actions.js");
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

/// Ответ из JS на запрос из реестра.
///
/// Обычно тело — JSON (`body`). Для выгрузок (CSV) JS присылает готовый текст
/// и тип содержимого: превращать таблицу в JSON, чтобы Rust снова разобрал её
/// в строку, незачем — а `Content-Type` и `Content-Disposition` задаёт клиент.
struct Reply {
    status: u16,
    body: Value,
    raw: Option<RawReply>,
}

/// Готовый текст ответа: используется, когда `body` — не JSON.
struct RawReply {
    content_type: String,
    body: String,
    /// Значение заголовка `Content-Disposition` (обычно `attachment; filename="…"`).
    disposition: Option<String>,
}

/// Запросы, ожидающие ответа из JS: `requestId → отправитель`.
type PendingMap = HashMap<String, SyncSender<Reply>>;

/// Запущенный сервер. Поток живёт, пока не поднят `stop`.
struct Server {
    port: u16,
    token: String,
    scopes: Scopes,
    started_at_ms: u64,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
    ready: Arc<AtomicBool>,
}

impl Server {
    /// Останавливает приём и ждёт поток. Ожидающим запросам отвечаем `503`,
    /// иначе они «висели» бы до таймаута.
    fn shutdown(self, pending: &Mutex<PendingMap>) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle {
            let _ = handle.join();
        }
        if let Ok(mut map) = pending.lock() {
            for (_, sender) in map.drain() {
                let _ = sender.send(Reply {
                    status: 503,
                    body: not_ready_body(),
                    raw: None,
                });
            }
        }
    }
}

/// Общее состояние сервера для команд Tauri.
#[derive(Default)]
pub struct ExternalApiState {
    inner: Mutex<Inner>,
    audit: Arc<Mutex<Audit>>,
    pending: Arc<Mutex<PendingMap>>,
}

#[derive(Default)]
struct Inner {
    server: Option<Server>,
    last_error: Option<String>,
}

/// Статус для вкладки настроек.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub scopes: Option<Scopes>,
    pub started_at_ms: Option<u64>,
    pub error: Option<String>,
    /// Запрос из JS уже подписан на событие моста.
    pub client_ready: bool,
    /// Сколько вызовов в журнале (не больше 100).
    pub logged: usize,
    /// Профиль сборки: `stable`, `acceptance`, `acceptance-shared`. Панель
    /// настроек показывает его, чтобы тестовый API был виден сразу.
    pub profile: String,
}

/// Параметры запуска, которые проверяются до создания потока.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    /// Если поле не передано, берётся порт по умолчанию из контракта.
    #[serde(default = "default_port")]
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub scopes: Scopes,
}

/// Порт, который подставляется, если клиент его не передал.
fn default_port() -> u16 {
    if crate::profile::app_build_profile() == "stable" {
        DEFAULT_PORT
    } else {
        ACCEPTANCE_DEFAULT_PORT
    }
}

/// Подставить порт по профилю, если клиент прислал умолчание стабильной сборки.
///
/// JS присылает сохранённый в настройках порт (по умолчанию `47831`). В тестовой
/// сборке такое «умолчание» означает, что пользователь порт не выбирал — тогда
/// подставляем порт профиля. Явно выбранный другой порт не трогаем.
fn port_for_profile(port: u16) -> u16 {
    if crate::profile::app_build_profile() != "stable" && port == DEFAULT_PORT {
        ACCEPTANCE_DEFAULT_PORT
    } else {
        port
    }
}

/// Проверка токена: 64 шестнадцатеричных символа, как его генерирует JS
/// (`crypto.getRandomValues` → 32 байта → hex).
pub fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Сравнение без раннего выхода: время не зависит от того, на каком байте
/// строки нашлось различие. Длина уже проверена выше.
fn constant_time_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in a.bytes().zip(b.bytes()) {
        difference |= left ^ right;
    }
    difference == 0
}

/// Ограничитель «один запуск одновременно»: две кнопки «Сохранить» подряд не
/// должны создать два сервера на одном порту.
static STARTING: AtomicBool = AtomicBool::new(false);

struct StartGuard;

impl Drop for StartGuard {
    fn drop(&mut self) {
        STARTING.store(false, Ordering::SeqCst);
    }
}

fn status_of(inner: &Inner, audit: &Audit) -> ApiStatus {
    match &inner.server {
        Some(server) => ApiStatus {
            running: true,
            port: Some(server.port),
            scopes: Some(server.scopes),
            started_at_ms: Some(server.started_at_ms),
            error: inner.last_error.clone(),
            client_ready: server.ready.load(Ordering::SeqCst),
            logged: audit.count(),
            profile: crate::profile::app_build_profile().to_string(),
        },
        None => ApiStatus {
            running: false,
            port: None,
            scopes: None,
            started_at_ms: None,
            error: inner.last_error.clone(),
            client_ready: false,
            logged: audit.count(),
            profile: crate::profile::app_build_profile().to_string(),
        },
    }
}

fn not_ready_body() -> Value {
    serde_json::json!({
        "error": {
            "code": "app_not_ready",
            "message": "Главное окно ещё не подключилось к внешнему API. Откройте Твиноферму."
        }
    })
}

/// Что нужно потоку сервера, кроме `AppHandle`.
struct ServeContext {
    port: u16,
    token: String,
    scopes: Scopes,
    pending: Arc<Mutex<PendingMap>>,
    ready: Arc<AtomicBool>,
    counter: AtomicU64,
    connections: AtomicUsize,
    rate: Mutex<RateLimiter>,
    audit: Arc<Mutex<Audit>>,
}

/// Запустить сервер. Повторный вызов с теми же параметрами ничего не делает,
/// с другими — перезапускает (порт и токен могли поменяться в настройках).
///
/// # Errors
/// Порт вне диапазона, токен не того формата, порт занят другой программой.
///
/// Тестовые сборки (`acceptance`, `acceptance-shared`) тоже запускают API: он
/// нужен, чтобы проверить контракт на живой сборке. Изоляция обеспечивается
/// другими средствами: порт по умолчанию свой (`ACCEPTANCE_DEFAULT_PORT`), токен
/// лежит в хранилище ОС под своим именем (`profile::VAULT_SERVICE`), а ответ
/// `GET /health` показывает профиль сборки полем `app.build`.
#[tauri::command]
pub fn external_api_start(
    app: AppHandle,
    state: State<'_, ExternalApiState>,
    mut options: StartOptions,
) -> Result<ApiStatus, String> {
    options.port = port_for_profile(options.port);
    if !(1024..=65535).contains(&options.port) {
        return Err("Порт должен быть в диапазоне 1024–65535".into());
    }
    if !valid_token(&options.token) {
        return Err("Токен имеет неверный формат".into());
    }
    let _guard = match STARTING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => StartGuard,
        Err(_) => return Err("Сервер внешнего API уже запускается".into()),
    };

    {
        let inner = state.inner.lock().map_err(|_| "Состояние API повреждено")?;
        if let Some(server) = &inner.server {
            if server.port == options.port
                && server.token == options.token
                && server.scopes == options.scopes
            {
                let audit = state.audit.lock().map_err(|_| "Журнал API повреждён")?;
                return Ok(status_of(&inner, &audit));
            }
        }
    }

    // Старый сервер останавливаем вне блокировки: остановка ждёт поток, и держать
    // на это время состояние нельзя.
    let old = state
        .inner
        .lock()
        .map_err(|_| "Состояние API повреждено")?
        .server
        .take();
    if let Some(server) = old {
        server.shutdown(&state.pending);
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, options.port)).map_err(|_| {
        let message = format!(
            "Не удалось занять порт {}: возможно, его уже использует другая программа",
            options.port
        );
        if let Ok(mut inner) = state.inner.lock() {
            inner.last_error = Some(message.clone());
        }
        message
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Не удалось перевести сервер в неблокирующий режим")?;

    let stop = Arc::new(AtomicBool::new(false));
    let ready = Arc::new(AtomicBool::new(false));
    let started_at_ms = audit::now_ms();
    let context = Arc::new(ServeContext {
        port: options.port,
        token: options.token.clone(),
        scopes: options.scopes,
        pending: state.pending.clone(),
        ready: ready.clone(),
        counter: AtomicU64::new(0),
        connections: AtomicUsize::new(0),
        rate: Mutex::new(RateLimiter::default()),
        audit: state.audit.clone(),
    });
    let thread_app = app.clone();
    let thread_stop = stop.clone();
    let handle = thread::spawn(move || {
        run_listener(&thread_app, listener, context, thread_stop);
    });

    let mut inner = state.inner.lock().map_err(|_| "Состояние API повреждено")?;
    inner.last_error = None;
    inner.server = Some(Server {
        port: options.port,
        token: options.token,
        scopes: options.scopes,
        started_at_ms,
        stop,
        handle: Some(handle),
        ready,
    });
    let audit = state.audit.lock().map_err(|_| "Журнал API повреждён")?;
    Ok(status_of(&inner, &audit))
}

/// Остановить сервер. Вызывается при выключении в настройках и при выходе.
#[tauri::command]
pub fn external_api_stop(state: State<'_, ExternalApiState>) -> Result<ApiStatus, String> {
    let server = state
        .inner
        .lock()
        .map_err(|_| "Состояние API повреждено")?
        .server
        .take();
    if let Some(server) = server {
        server.shutdown(&state.pending);
    }
    let inner = state.inner.lock().map_err(|_| "Состояние API повреждено")?;
    let audit = state.audit.lock().map_err(|_| "Журнал API повреждён")?;
    Ok(status_of(&inner, &audit))
}

/// Текущий статус: работает ли, на каком порту, с какими правами.
#[tauri::command]
pub fn external_api_status(state: State<'_, ExternalApiState>) -> Result<ApiStatus, String> {
    let inner = state.inner.lock().map_err(|_| "Состояние API повреждено")?;
    let audit = state.audit.lock().map_err(|_| "Журнал API повреждён")?;
    Ok(status_of(&inner, &audit))
}

/// JS сообщает, что подписался на событие моста: только после этого запросы
/// имеют шанс получить ответ, а до него внешняя программа видит `503`.
#[tauri::command]
pub fn external_api_client_ready(state: State<'_, ExternalApiState>) -> Result<bool, String> {
    let inner = state.inner.lock().map_err(|_| "Состояние API повреждено")?;
    match &inner.server {
        Some(server) => {
            server.ready.store(true, Ordering::SeqCst);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Сырой ответ из JS: `{ contentType, body, disposition? }`. Отдельная команда
/// не нужна — передаётся необязательным полем `raw` у обычного ответа.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawReplyInput {
    content_type: String,
    body: String,
    disposition: Option<String>,
}

/// Ответ JS на запрос из очереди. Чужое окно и неизвестный `requestId`
/// игнорируются: запрос мог уже истечь по времени.
///
/// `raw` — для выгрузок (CSV): готовый текст и его `Content-Type`. Остальные
/// ответы — JSON в `body`.
#[tauri::command]
pub fn external_api_reply(
    window: tauri::WebviewWindow,
    state: State<'_, ExternalApiState>,
    request_id: String,
    status: u16,
    body: Value,
    raw: Option<RawReplyInput>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Ответ принимается только из главного окна".into());
    }
    let raw = raw.map(|input| RawReply {
        content_type: input.content_type,
        body: input.body,
        disposition: input.disposition,
    });
    let sender = state
        .pending
        .lock()
        .map_err(|_| "Очередь запросов повреждена")?
        .remove(&request_id);
    if let Some(sender) = sender {
        let _ = sender.send(Reply { status, body, raw });
    }
    Ok(())
}

/// Последние вызовы: время, метод, путь, код, длительность. Без тел и токенов.
#[tauri::command]
pub fn external_api_audit(state: State<'_, ExternalApiState>) -> Result<Vec<AuditEntry>, String> {
    let audit = state.audit.lock().map_err(|_| "Журнал API повреждён")?;
    Ok(audit.snapshot())
}

/// Очистить журнал вызовов.
#[tauri::command]
pub fn external_api_clear_audit(state: State<'_, ExternalApiState>) -> Result<(), String> {
    state
        .audit
        .lock()
        .map_err(|_| "Журнал API повреждён")?
        .clear();
    Ok(())
}

/// Остановить сервер при выходе приложения: порт должен освободиться сразу,
/// а не когда завершится процесс.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<ExternalApiState>() {
        let server = match state.inner.lock() {
            Ok(mut inner) => inner.server.take(),
            Err(_) => None,
        };
        if let Some(server) = server {
            server.shutdown(&state.pending);
        }
    }
}

/// Цикл приёма. Слушающий сокет неблокирующий: поток просыпается раз в 50 мс
/// и проверяет флаг остановки, поэтому `stop` не нужно «будить» соединением.
fn run_listener(
    app: &AppHandle,
    listener: TcpListener,
    context: Arc<ServeContext>,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let active = context.connections.fetch_add(1, Ordering::SeqCst);
                if active >= MAX_CONNECTIONS {
                    context.connections.fetch_sub(1, Ordering::SeqCst);
                    reject_busy(stream);
                    continue;
                }
                let app = app.clone();
                let context = context.clone();
                thread::spawn(move || {
                    serve_connection(&app, &context, stream);
                    context.connections.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_TICK)
            }
            Err(_) => break,
        }
    }
}

/// Отказ, когда одновременно обслуживается слишком много соединений.
fn reject_busy(mut stream: TcpStream) {
    let _ = http::write_response(
        &mut stream,
        503,
        &http::json_headers(),
        &http::error_body(
            "too_many_connections",
            "Слишком много одновременных запросов",
        ),
    );
}

/// Один запрос: прочитать, ответить, записать в журнал.
fn serve_connection(app: &AppHandle, context: &ServeContext, mut stream: TcpStream) {
    let started = Instant::now();
    let request = match http::read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let (status, code, message) = match error {
                http::ReadError::TooLarge => (
                    413,
                    "payload_too_large",
                    "Запрос больше допустимого: заголовки 16 КиБ, тело 64 КиБ",
                ),
                http::ReadError::Timeout => {
                    (408, "timeout", "Запрос не был получен целиком вовремя")
                }
                _ => (400, "bad_request", "Запрос не разбирается как HTTP"),
            };
            let _ = http::write_response(
                &mut stream,
                status,
                &http::json_headers(),
                &http::error_body(code, message),
            );
            record(context, started, "-", "-", status);
            return;
        }
    };
    let response = handle(app, context, request);
    let _ = http::write_response(
        &mut stream,
        response.status,
        &response.headers,
        &response.body,
    );
    record(
        context,
        started,
        &response.method,
        &response.path,
        response.status,
    );
}

fn record(context: &ServeContext, started: Instant, method: &str, path: &str, status: u16) {
    if let Ok(mut audit) = context.audit.lock() {
        audit.push(AuditEntry {
            at_ms: audit::now_ms(),
            method: method.to_string(),
            path: path.to_string(),
            status,
            ms: started.elapsed().as_millis() as u64,
        });
    }
}

/// Готовый ответ: статус, заголовки, тело и что попадёт в журнал.
struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    method: String,
    path: String,
}

impl Response {
    fn json(status: u16, body: Value, ledger: &(String, String)) -> Self {
        let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| {
            http::error_body("internal_error", "Не удалось собрать ответ JSON")
        });
        Self {
            status,
            headers: http::json_headers(),
            body: bytes,
            method: ledger.0.clone(),
            path: ledger.1.clone(),
        }
    }

    /// Ответ готовым текстом: CSV и прочие выгрузки. `raw` уже содержит
    /// `Content-Type` и, если нужно, `Content-Disposition`.
    fn text(status: u16, raw: RawReply, ledger: &(String, String)) -> Self {
        let mut headers = vec![
            ("Content-Type".to_string(), raw.content_type.clone()),
            ("Cache-Control".to_string(), "no-store".to_string()),
            ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
        ];
        if let Some(disposition) = raw.disposition {
            headers.push(("Content-Disposition".to_string(), disposition));
        }
        Self {
            status,
            headers,
            body: raw.body.into_bytes(),
            method: ledger.0.clone(),
            path: ledger.1.clone(),
        }
    }

    fn error(status: u16, code: &str, message: &str, ledger: &(String, String)) -> Self {
        Self {
            status,
            headers: http::json_headers(),
            body: http::error_body(code, message),
            method: ledger.0.clone(),
            path: ledger.1.clone(),
        }
    }

    fn static_file(
        status: u16,
        content_type: &str,
        body: &'static str,
        ledger: &(String, String),
    ) -> Self {
        Self {
            status,
            headers: vec![
                ("Content-Type".to_string(), content_type.to_string()),
                ("Cache-Control".to_string(), "no-store".to_string()),
                ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
                ("Content-Security-Policy".to_string(), CSP.to_string()),
                ("X-Frame-Options".to_string(), "DENY".to_string()),
                ("Referrer-Policy".to_string(), "no-referrer".to_string()),
            ],
            body: body.as_bytes().to_vec(),
            method: ledger.0.clone(),
            path: ledger.1.clone(),
        }
    }

    /// Пустой ответ: без заголовков вообще (так работает `/favicon.ico`), но с
    /// `nosniff`, чтобы браузер не пытался угадать тип по пустому телу.
    fn empty(status: u16, ledger: &(String, String)) -> Self {
        Self {
            status,
            headers: vec![("X-Content-Type-Options".to_string(), "nosniff".to_string())],
            body: Vec::new(),
            method: ledger.0.clone(),
            path: ledger.1.clone(),
        }
    }
}

/// Проверки и маршрутизация одного запроса.
fn handle(app: &AppHandle, context: &ServeContext, request: http::Request) -> Response {
    let ledger = (request.method.clone(), request.path.clone());
    let method = request.method.as_str();
    let path = request.path.as_str();

    // Лимит частоты — до всего остального: перебор токенов тоже упирается в него.
    let allowed = match context.rate.lock() {
        Ok(mut rate) => {
            let now = Instant::now();
            let allowed = rate.allow(now);
            (allowed, rate.retry_after_secs(now))
        }
        Err(_) => (false, 60),
    };
    if !allowed.0 {
        let mut response = Response::error(
            429,
            "too_many_requests",
            "Слишком много запросов: не больше 60 в минуту",
            &ledger,
        );
        response
            .headers
            .push(("Retry-After".to_string(), allowed.1.to_string()));
        return response;
    }

    // Никакого CORS: заголовки `Access-Control-Allow-*` не отдаются, а
    // предварительный запрос из чужой вкладки получает отказ.
    if method == "OPTIONS" {
        return Response::error(
            403,
            "forbidden",
            "Запросы из браузера со сторонних страниц не поддерживаются",
            &ledger,
        );
    }

    if !auth::host_allowed(http::header(&request.headers, "host"), context.port) {
        return Response::error(
            403,
            "forbidden_host",
            "Заголовок Host должен указывать на 127.0.0.1 или localhost с портом API",
            &ledger,
        );
    }

    if method == "GET" {
        match path {
            "/" | "/index.html" => {
                return Response::static_file(200, "text/html; charset=utf-8", PAGE_HTML, &ledger);
            }
            "/app.css" => {
                return Response::static_file(200, "text/css; charset=utf-8", PAGE_CSS, &ledger);
            }
            "/app.js" => {
                return Response::static_file(
                    200,
                    "text/javascript; charset=utf-8",
                    PAGE_JS,
                    &ledger,
                );
            }
            "/docs.js" => {
                return Response::static_file(
                    200,
                    "text/javascript; charset=utf-8",
                    PAGE_DOCS_JS,
                    &ledger,
                );
            }
            "/errors.js" => {
                return Response::static_file(
                    200,
                    "text/javascript; charset=utf-8",
                    PAGE_ERRORS_JS,
                    &ledger,
                );
            }
            "/actions.js" => {
                return Response::static_file(
                    200,
                    "text/javascript; charset=utf-8",
                    PAGE_ACTIONS_JS,
                    &ledger,
                );
            }
            _ => {}
        }
    }
    if path == "/favicon.ico" {
        return Response::empty(204, &ledger);
    }
    if !path.starts_with("/api/v1") {
        return Response::error(404, "not_found", "Неизвестный путь", &ledger);
    }

    let token = auth::bearer_token(http::header(&request.headers, "authorization"));
    let authorized = match token {
        Some(token) => constant_time_equal(token, &context.token),
        None => false,
    };
    if !authorized {
        return Response::error(
            401,
            "unauthorized",
            "Нужен заголовок Authorization: Bearer <токен>",
            &ledger,
        );
    }

    if method == "GET" && path == "/api/v1/audit" {
        let entries = context
            .audit
            .lock()
            .map(|audit| audit.snapshot())
            .unwrap_or_default();
        let body = serde_json::json!({ "audit": entries });
        return Response::json(200, body, &ledger);
    }

    let access = match auth::access_for(method, path) {
        Ok(access) => access,
        Err("method_not_allowed") => {
            return Response::error(
                405,
                "method_not_allowed",
                "Этот метод не поддерживается",
                &ledger,
            )
        }
        Err(code) => return Response::error(404, code, "Неизвестный путь API", &ledger),
    };
    if !context.scopes.allows(access) {
        let message = match access {
            Access::Read => "Право «Чтение» выключено в настройках",
            Access::Modify => "Право «Изменение статов и проходок» выключено в настройках",
            Access::LaunchClose => "Право «Запуск и закрытие окон» выключено в настройках",
        };
        return Response::error(403, "forbidden_scope", message, &ledger);
    }

    // Показ главного окна — действие Rust: оно нужно как раз тогда, когда окно
    // свёрнуто в трей, и не должно зависеть от очереди ответов JS.
    if method == "POST" && path == "/api/v1/app/show" {
        crate::tray::show_main(app);
        let body = serde_json::json!({ "shown": true });
        return Response::json(200, body, &ledger);
    }

    let mut body = Value::Null;
    if auth::body_expected(method) {
        if !auth::json_content_type(http::header(&request.headers, "content-type")) {
            return Response::error(
                415,
                "unsupported_media_type",
                "Тело запроса должно быть в формате application/json",
                &ledger,
            );
        }
        if request.body.is_empty() {
            return Response::error(400, "invalid_json", "Пустое тело запроса", &ledger);
        }
        match serde_json::from_slice::<Value>(&request.body) {
            Ok(value) => body = value,
            Err(_) => {
                return Response::error(
                    400,
                    "invalid_json",
                    "Тело запроса не разобрано как JSON",
                    &ledger,
                )
            }
        }
    }

    if !context.ready.load(Ordering::SeqCst) {
        return Response::error(
            503,
            "app_not_ready",
            "Главное окно ещё не подключилось к API. Откройте Твиноферму.",
            &ledger,
        );
    }

    // Реестр: сначала кладём отправителя, потом отпускаем блокировку и только
    // затем шлём событие. Иначе быстрый ответ из JS мог бы прийти раньше, чем
    // запрос вообще зарегистрирован, и потеряться.
    let request_id = format!("rq_{}", context.counter.fetch_add(1, Ordering::SeqCst));
    let (sender, receiver) = sync_channel::<Reply>(1);
    match context.pending.lock() {
        Ok(mut pending) => {
            pending.insert(request_id.clone(), sender);
        }
        Err(_) => {
            return Response::error(
                500,
                "internal_error",
                "Очередь запросов недоступна",
                &ledger,
            )
        }
    }
    let payload = serde_json::json!({
        "requestId": request_id,
        "method": method,
        "path": request.path.clone(),
        "query": request.query.clone(),
        "body": body,
    });
    if app.emit_to("main", EVENT_NAME, payload).is_err() {
        if let Ok(mut pending) = context.pending.lock() {
            pending.remove(&request_id);
        }
        return Response::error(503, "app_not_ready", "Главное окно недоступно", &ledger);
    }
    match receiver.recv_timeout(REPLY_TIMEOUT) {
        Ok(reply) => {
            if let Ok(mut pending) = context.pending.lock() {
                pending.remove(&request_id);
            }
            match reply.raw {
                Some(raw) => Response::text(reply.status, raw, &ledger),
                None => Response::json(reply.status, reply.body, &ledger),
            }
        }
        Err(_) => {
            if let Ok(mut pending) = context.pending.lock() {
                pending.remove(&request_id);
            }
            Response::error(504, "timeout", "Твиноферма не ответила вовремя", &ledger)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        constant_time_equal, port_for_profile, valid_token, ACCEPTANCE_DEFAULT_PORT, DEFAULT_PORT,
    };

    #[test]
    fn acceptance_builds_get_their_own_default_port() {
        // Тестовая и стабильная сборки могут работать одновременно: умолчание
        // `47831` в тестовой сборке переезжает на порт профиля, а явно
        // выбранный пользователем порт остаётся как есть.
        assert_ne!(ACCEPTANCE_DEFAULT_PORT, DEFAULT_PORT);
        // Профиль в тестовом прогоне — `stable`, поэтому функция возвращает
        // вход без изменений; проверяем саму форму правила.
        assert_eq!(port_for_profile(DEFAULT_PORT), DEFAULT_PORT);
        assert_eq!(port_for_profile(50000), 50000);
        assert_eq!(port_for_profile(1024), 1024);
        assert_eq!(port_for_profile(65535), 65535);
    }

    #[test]
    fn token_format_is_64_hex_characters() {
        assert!(valid_token(&"a".repeat(64)));
        assert!(valid_token(&"0123456789abcdef".repeat(4)));
        assert!(!valid_token(&"a".repeat(63)));
        assert!(!valid_token(&"a".repeat(65)));
        assert!(!valid_token(&"z".repeat(64)));
    }

    #[test]
    fn comparison_is_exact() {
        let token = "0123456789abcdef".repeat(4);
        assert!(constant_time_equal(&token, &token));
        // Последний символ токена — «f», поэтому «0» гарантированно отличается.
        let other = format!("{}0", &token[..63]);
        assert!(!constant_time_equal(&token, &other));
        assert!(!constant_time_equal(&token, &token[..32]));
    }

    #[test]
    fn default_port_matches_the_contract() {
        assert_eq!(DEFAULT_PORT, 47831);
    }
}

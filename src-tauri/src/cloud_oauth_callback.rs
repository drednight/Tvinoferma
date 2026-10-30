//! Короткоживущий loopback-приёмник кода OAuth для будущего входа в личный диск.
//!
//! Этот модуль сам не открывает браузер, не обменивает код на токен и не хранит
//! учётные данные. Он привязывается ТОЛЬКО к 127.0.0.1, ожидает случайный state,
//! возвращает код владельцу отдельного случайного handle не более одного раза и
//! перестаёт удерживать его при отмене или истечении времени. Rust и JavaScript не
//! гарантируют стирания всех копий байтов. Случайность state и handle должна
//! обеспечиваться доверенным вызывающим кодом через CSPRNG.
//! Локальный вредоносный процесс может мешать работе порта; этот модуль не защищает
//! от процесса, способного читать память приложения или управлять браузером.

use std::collections::HashSet;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const CALLBACK_PATH: &str = "/oauth/cloud/callback";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_QUERY_BYTES: usize = 8 * 1024;
const MAX_CODE_BYTES: usize = 2048;
const MAX_PARAMETERS: usize = 32;
const POLL_DELAY: Duration = Duration::from_millis(20);
const READ_TICK: Duration = Duration::from_millis(100);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
// CSP разрешает только этот неизменяемый скрипт. Он убирает query из текущей
// адресной строки, но не гарантирует удаления уже сохранённых браузером копий.
const CLEAN_QUERY_SCRIPT: &str =
    "try{history.replaceState(null,'','/oauth/cloud/complete')}catch{}";
const CLEAN_QUERY_SCRIPT_HASH: &str = "sha256-uLjbzFaaRTCAu+D40i9MEp3QBMqFkaNgmJaSxH0xm6g=";
const BAD_REQUEST: &str = "Некорректные параметры авторизации облачного диска";
const BUSY: &str = "Уже выполняется другая авторизация облачного диска";
const UNAVAILABLE: &str = "Не удалось открыть локальный адрес для авторизации";
const NOT_FOUND: &str = "Сеанс авторизации не найден или уже заменён";
const INTERNAL: &str = "Не удалось проверить состояние авторизации";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Provider {
    Google,
    Yandex,
}

impl Provider {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "google" => Ok(Self::Google),
            "yandex" => Ok(Self::Yandex),
            _ => Err(BAD_REQUEST.into()),
        }
    }
}

// Не реализуем Debug: ни handle, ни state, ни код нельзя случайно вывести в лог.
struct Attempt {
    handle: String,
    expected_state: String,
    provider: Provider,
    deadline: Instant,
    data: Mutex<AttemptData>,
    wake: Condvar,
}

struct AttemptData {
    phase: Phase,
    worker_finished: bool,
}

enum Phase {
    Waiting,
    Ready(Outcome),
    Failed,
    Expired,
    Cancelled,
    Consumed,
}

enum Outcome {
    Code(String),
    Denied,
    Error,
}

/// Код присутствует только в единственном ответе Code; остальные состояния не
/// содержат входной URL, state, деталей сервиса, токенов или пользовательских данных.
pub enum CallbackStatus {
    Pending,
    Code(String),
    Denied,
    Error,
    Expired,
    Cancelled,
    Consumed,
}

/// Один процесс приложения допускает только одну незавершённую авторизацию.
#[derive(Default)]
pub struct CallbackRegistry {
    active: Mutex<Option<Arc<Attempt>>>,
}

fn fixed_error(message: &str) -> String {
    message.into()
}

// Длина соответствует base64url без padding для 32 случайных байт. Сам по себе
// формат не доказывает случайность: вызывающая сторона должна сгенерировать её.
fn valid_nonce(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

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

fn expire(data: &mut AttemptData, attempt: &Attempt) {
    if Instant::now() >= attempt.deadline && matches!(data.phase, Phase::Waiting | Phase::Ready(_))
    {
        // При замене Ready строка с кодом больше не удерживается этой структурой.
        data.phase = Phase::Expired;
        attempt.wake.notify_all();
    }
}

impl CallbackRegistry {
    /// Google desktop использует порт, выбранный ОС; для Яндекса требуется именно
    /// заранее зарегистрированный порт, так как его redirect URI проверяет и порт.
    pub fn begin(
        &self,
        provider: &str,
        requested_port: u16,
        expected_state: String,
        handle: String,
    ) -> Result<u16, String> {
        self.begin_with_timeout(
            provider,
            requested_port,
            expected_state,
            handle,
            ATTEMPT_TIMEOUT,
        )
    }

    fn begin_with_timeout(
        &self,
        provider: &str,
        requested_port: u16,
        expected_state: String,
        handle: String,
        timeout: Duration,
    ) -> Result<u16, String> {
        let provider = Provider::parse(provider)?;
        if !valid_nonce(&expected_state)
            || !valid_nonce(&handle)
            || constant_time_equal(&expected_state, &handle)
            || (provider == Provider::Google && requested_port != 0)
            || (provider == Provider::Yandex && requested_port < 1024)
            || timeout.is_zero()
        {
            return Err(fixed_error(BAD_REQUEST));
        }
        let mut active = self.active.lock().map_err(|_| fixed_error(INTERNAL))?;
        if let Some(previous) = active.as_ref() {
            let mut data = previous.data.lock().map_err(|_| fixed_error(INTERNAL))?;
            expire(&mut data, previous);
            if !data.worker_finished || matches!(data.phase, Phase::Waiting | Phase::Ready(_)) {
                return Err(fixed_error(BUSY));
            }
            // Не позволяем старому владельцу сразу получить доступ к новому сеансу,
            // даже если его вызывающая сторона ошибочно повторила handle или state.
            if constant_time_equal(&previous.handle, &handle)
                || constant_time_equal(&previous.expected_state, &expected_state)
            {
                return Err(fixed_error(BAD_REQUEST));
            }
        }

        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, requested_port);
        let listener = TcpListener::bind(address).map_err(|_| fixed_error(UNAVAILABLE))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| fixed_error(UNAVAILABLE))?;
        let actual = listener
            .local_addr()
            .map_err(|_| fixed_error(UNAVAILABLE))?;
        let port = match actual {
            SocketAddr::V4(address)
                if *address.ip() == Ipv4Addr::LOCALHOST && address.port() > 0 =>
            {
                address.port()
            }
            _ => return Err(fixed_error(UNAVAILABLE)),
        };
        if provider == Provider::Yandex && port != requested_port {
            return Err(fixed_error(UNAVAILABLE));
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| fixed_error(BAD_REQUEST))?;
        let attempt = Arc::new(Attempt {
            handle,
            expected_state,
            provider,
            deadline,
            data: Mutex::new(AttemptData {
                phase: Phase::Waiting,
                worker_finished: false,
            }),
            wake: Condvar::new(),
        });
        let worker_attempt = Arc::clone(&attempt);
        thread::Builder::new()
            .name("tf-cloud-oauth".into())
            .spawn(move || run_listener(listener, port, worker_attempt))
            .map_err(|_| fixed_error(UNAVAILABLE))?;
        *active = Some(attempt);
        Ok(port)
    }

    pub fn poll(&self, handle: &str) -> Result<CallbackStatus, String> {
        let active = self.active.lock().map_err(|_| fixed_error(INTERNAL))?;
        let attempt = active
            .as_ref()
            .filter(|attempt| constant_time_equal(&attempt.handle, handle))
            .ok_or_else(|| fixed_error(NOT_FOUND))?;
        let mut data = attempt.data.lock().map_err(|_| fixed_error(INTERNAL))?;
        expire(&mut data, attempt);
        match &data.phase {
            Phase::Waiting => Ok(CallbackStatus::Pending),
            Phase::Failed => Ok(CallbackStatus::Error),
            Phase::Expired => Ok(CallbackStatus::Expired),
            Phase::Cancelled => Ok(CallbackStatus::Cancelled),
            Phase::Consumed => Ok(CallbackStatus::Consumed),
            Phase::Ready(_) => {
                let old = std::mem::replace(&mut data.phase, Phase::Consumed);
                attempt.wake.notify_all();
                match old {
                    Phase::Ready(Outcome::Code(code)) => Ok(CallbackStatus::Code(code)),
                    Phase::Ready(Outcome::Denied) => Ok(CallbackStatus::Denied),
                    Phase::Ready(Outcome::Error) => Ok(CallbackStatus::Error),
                    _ => Err(fixed_error(INTERNAL)),
                }
            }
        }
    }

    pub fn cancel(&self, handle: &str) -> Result<(), String> {
        let active = self.active.lock().map_err(|_| fixed_error(INTERNAL))?;
        let attempt = active
            .as_ref()
            .filter(|attempt| constant_time_equal(&attempt.handle, handle))
            .ok_or_else(|| fixed_error(NOT_FOUND))?;
        let mut data = attempt.data.lock().map_err(|_| fixed_error(INTERNAL))?;
        expire(&mut data, attempt);
        if matches!(data.phase, Phase::Waiting | Phase::Ready(_)) {
            data.phase = Phase::Cancelled;
            attempt.wake.notify_all();
        }
        Ok(())
    }
}

fn still_waiting(attempt: &Attempt) -> bool {
    match attempt.data.lock() {
        Ok(mut data) => {
            expire(&mut data, attempt);
            matches!(data.phase, Phase::Waiting)
        }
        Err(_) => false,
    }
}

fn set_failed(attempt: &Attempt) {
    if let Ok(mut data) = attempt.data.lock() {
        expire(&mut data, attempt);
        if matches!(data.phase, Phase::Waiting) {
            data.phase = Phase::Failed;
            attempt.wake.notify_all();
        }
    }
}

fn run_listener(listener: TcpListener, port: u16, attempt: Arc<Attempt>) {
    while still_waiting(&attempt) {
        match listener.accept() {
            Ok((mut stream, remote)) => {
                if !remote.ip().is_loopback() {
                    continue;
                }
                let parsed = read_request(&mut stream, &attempt).and_then(|mut request| {
                    let result =
                        parse_request(&request, port, &attempt.expected_state, attempt.provider);
                    request.fill(0);
                    result
                });
                if let Some(outcome) = parsed {
                    let accepted = match attempt.data.lock() {
                        Ok(mut data) => {
                            expire(&mut data, &attempt);
                            if matches!(data.phase, Phase::Waiting) {
                                data.phase = Phase::Ready(outcome);
                                attempt.wake.notify_all();
                                true
                            } else {
                                false
                            }
                        }
                        Err(_) => false,
                    };
                    respond(&mut stream, accepted);
                    if accepted {
                        break;
                    }
                } else {
                    respond(&mut stream, false);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(POLL_DELAY),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                set_failed(&attempt);
                break;
            }
        }
    }
    drop(listener);

    // Даже если вызывающий код больше не опрашивает результат, код не остаётся в
    // памяти бесконечно: ожидаем получения/отмены или истечения общего срока.
    if let Ok(mut data) = attempt.data.lock() {
        loop {
            expire(&mut data, &attempt);
            if !matches!(data.phase, Phase::Ready(_)) {
                break;
            }
            let remaining = attempt.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                expire(&mut data, &attempt);
                break;
            }
            match attempt.wake.wait_timeout(data, remaining) {
                Ok((guard, _)) => data = guard,
                Err(_) => return,
            }
        }
        data.worker_finished = true;
        attempt.wake.notify_all();
    }
}

fn read_request(stream: &mut TcpStream, attempt: &Attempt) -> Option<Vec<u8>> {
    stream.set_read_timeout(Some(READ_TICK)).ok()?;
    let deadline = Instant::now()
        .checked_add(REQUEST_TIMEOUT)?
        .min(attempt.deadline);
    let mut request = Vec::new();
    let mut chunk = [0u8; 1024];
    while Instant::now() < deadline && still_waiting(attempt) {
        match stream.read(&mut chunk) {
            Ok(0) => return None,
            Ok(count) => {
                if request.len() + count > MAX_HEADER_BYTES {
                    return None;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    return Some(request);
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
    None
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

// application/x-www-form-urlencoded; только валидный UTF-8 без скрытого NUL.
fn decode_form(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                if index + 2 >= bytes.len() {
                    return None;
                }
                decoded.push(hex_digit(bytes[index + 1])? * 16 + hex_digit(bytes[index + 2])?);
                index += 3;
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    if decoded.contains(&0) {
        return None;
    }
    String::from_utf8(decoded).ok()
}

fn visible_ascii(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn parse_request(
    request: &[u8],
    port: u16,
    expected_state: &str,
    provider: Provider,
) -> Option<Outcome> {
    if request.len() > MAX_HEADER_BYTES
        || !request.ends_with(b"\r\n\r\n")
        || request.windows(4).position(|window| window == b"\r\n\r\n") != Some(request.len() - 4)
    {
        return None;
    }
    let text = std::str::from_utf8(request).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    if parts.next()? != "HTTP/1.1" || parts.next().is_some() || target.contains('#') {
        return None;
    }
    let query = target.strip_prefix(CALLBACK_PATH)?.strip_prefix('?')?;
    if query.is_empty() || query.len() > MAX_QUERY_BYTES {
        return None;
    }

    let expected_host = format!("127.0.0.1:{port}");
    let mut host = None;
    let mut length_seen = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if !line
            .bytes()
            .all(|b| b == b'\t' || (0x20..=0x7e).contains(&b))
        {
            return None;
        }
        let (name, raw_value) = line.split_once(':')?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return None;
        }
        let value = raw_value.trim_matches([' ', '\t']);
        if name.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return None;
            }
            host = Some(value);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            return None;
        } else if name.eq_ignore_ascii_case("content-length") {
            if length_seen || value != "0" {
                return None;
            }
            length_seen = true;
        }
    }
    if host != Some(expected_host.as_str()) {
        return None;
    }

    let mut keys = HashSet::new();
    let mut state = None;
    let mut code = None;
    let mut error = None;
    let mut issuer = None;
    for (index, item) in query.split('&').enumerate() {
        if index >= MAX_PARAMETERS {
            return None;
        }
        let (raw_key, raw_value) = item.split_once('=')?;
        let key = decode_form(raw_key)?;
        if key.is_empty()
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !keys.insert(key.clone())
        {
            return None;
        }
        match key.as_str() {
            "state" => state = Some(decode_form(raw_value)?),
            "code" => code = Some(decode_form(raw_value)?),
            "error" => error = Some(decode_form(raw_value)?),
            "iss" => issuer = Some(decode_form(raw_value)?),
            // Дополнительные параметры не используются и не возвращаются наружу.
            _ => {}
        }
    }
    if !constant_time_equal(state.as_deref()?, expected_state) {
        return None;
    }
    if let Some(value) = issuer {
        if provider != Provider::Google || value != "https://accounts.google.com" {
            return None;
        }
    }
    match (code, error) {
        (Some(code), None) if visible_ascii(&code, MAX_CODE_BYTES) => Some(Outcome::Code(code)),
        (None, Some(error)) if visible_ascii(&error, 128) => {
            if error == "access_denied" {
                Some(Outcome::Denied)
            } else {
                Some(Outcome::Error)
            }
        }
        _ => None,
    }
}

fn respond(stream: &mut TcpStream, accepted: bool) {
    let (status, message) = if accepted {
        (
            "200 OK",
            "Ответ получен. Вернитесь в Твиноферму и закройте эту вкладку.",
        )
    } else {
        (
            "400 Bad Request",
            "Запрос не принят. Вернитесь в Твиноферму.",
        )
    };
    // Только постоянные строки: код, state и текст ошибки никогда не отражаются в HTML.
    let body = format!("<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><script>{CLEAN_QUERY_SCRIPT}</script><title>Твиноферма</title><p>{message}</p></html>");
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nPragma: no-cache\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src '{CLEAN_QUERY_SCRIPT_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n",
        body.len()
    );
    if stream.set_write_timeout(Some(READ_TICK)).is_err() {
        return;
    }
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn nonce(c: char) -> String {
        std::iter::repeat_n(c, 43).collect()
    }

    fn start(registry: &CallbackRegistry, state: char, handle: char, timeout: Duration) -> u16 {
        registry
            .begin_with_timeout("google", 0, nonce(state), nonce(handle), timeout)
            .unwrap()
    }

    fn request(port: u16, query: &str) -> String {
        format!(
            "GET {CALLBACK_PATH}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: test\r\n\r\n"
        )
    }

    fn exchange(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn poll_terminal(registry: &CallbackRegistry, handle: &str) -> CallbackStatus {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match registry.poll(handle).unwrap() {
                CallbackStatus::Pending if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10))
                }
                CallbackStatus::Pending => panic!("callback did not complete"),
                status => return status,
            }
        }
    }

    fn wait_finished(registry: &CallbackRegistry) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            {
                let active = registry.active.lock().unwrap();
                if active
                    .as_ref()
                    .unwrap()
                    .data
                    .lock()
                    .unwrap()
                    .worker_finished
                {
                    return;
                }
            }
            assert!(Instant::now() < deadline, "worker did not stop");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn accepts_loopback_code_once_and_never_reflects_it() {
        let registry = CallbackRegistry::default();
        let port = start(&registry, 'A', 'B', Duration::from_secs(4));
        assert!(port > 0);
        let query = format!(
            "code=private%2Fcode%2Bvalue&state={}&scope=drive.file&iss=https%3A%2F%2Faccounts.google.com",
            nonce('A')
        );
        let response = exchange(port, &request(port, &query));
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(response.contains("Referrer-Policy: no-referrer"));
        assert!(response.contains("Content-Security-Policy: default-src 'none'"));
        assert!(response.contains(&format!("script-src '{CLEAN_QUERY_SCRIPT_HASH}'")));
        assert!(response.contains(&format!("<script>{CLEAN_QUERY_SCRIPT}</script>")));
        assert!(!response.contains("private"));
        assert!(!response.contains(&nonce('A')));
        match poll_terminal(&registry, &nonce('B')) {
            CallbackStatus::Code(code) => assert_eq!(code, "private/code+value"),
            _ => panic!("expected code"),
        }
        assert!(matches!(
            registry.poll(&nonce('B')).unwrap(),
            CallbackStatus::Consumed
        ));
        wait_finished(&registry);
    }

    #[test]
    fn bad_state_and_unrelated_requests_do_not_consume_the_real_attempt() {
        let registry = CallbackRegistry::default();
        let port = start(&registry, 'A', 'B', Duration::from_secs(4));
        for query in [
            format!("code=private&state={}", nonce('C')),
            "code=private".to_string(),
            format!("state={}&error=access_denied&code=private", nonce('A')),
        ] {
            let response = exchange(port, &request(port, &query));
            assert!(response.starts_with("HTTP/1.1 400 Bad Request\r\n"));
            assert!(!response.contains("private"));
            assert!(matches!(
                registry.poll(&nonce('B')).unwrap(),
                CallbackStatus::Pending
            ));
        }
        let response = exchange(
            port,
            &request(port, &format!("state={}&code=valid", nonce('A'))),
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(matches!(
            poll_terminal(&registry, &nonce('B')),
            CallbackStatus::Code(_)
        ));
        wait_finished(&registry);
    }

    #[test]
    fn rejects_ambiguous_http_queries_bodies_and_issuer() {
        let port = 24680;
        let state = nonce('A');
        let good = format!("state={state}&code=valid");
        assert!(matches!(
            parse_request(
                request(port, &good).as_bytes(),
                port,
                &state,
                Provider::Google
            ),
            Some(Outcome::Code(_))
        ));
        let bad = [
            request(port, &format!("state={state}&sta%74e={state}&code=valid")),
            request(port, &format!("state={state}&code=one&co%64e=two")),
            request(port, &format!("state={state}&code=%GG")),
            request(port, &format!("state={state}&code=has+space")),
            request(port, &format!("state={state}&code=a%00b")),
            request(
                port,
                &format!("state={state}&code=valid&error=access_denied"),
            ),
            request(
                port,
                &format!("state={state}&code=valid&iss=https%3A%2F%2Fevil.example"),
            ),
            request(port, &format!("state={state}&code=valid&extra&x=y")),
            request(port, &good).replace("127.0.0.1:24680", "localhost:24680"),
            request(port, &good).replace("User-Agent: test", "Host: 127.0.0.1:24680"),
            request(port, &good).replace("User-Agent: test", "Content-Length: 1"),
            request(port, &good).replace("User-Agent: test", "Transfer-Encoding: chunked"),
            request(port, &good).replace("HTTP/1.1", "HTTP/1.0"),
            request(port, &good).replace("GET /", "POST /"),
            request(port, &good).replace("GET /", "GET http://evil.example/"),
            request(port, &good).replace(CALLBACK_PATH, "/elsewhere"),
            format!("{}X: body\r\n\r\n", request(port, &good)),
        ];
        for value in bad {
            assert!(parse_request(value.as_bytes(), port, &state, Provider::Google).is_none());
        }
        let google_issuer = request(
            port,
            &format!("state={state}&code=valid&iss=https%3A%2F%2Faccounts.google.com"),
        );
        assert!(parse_request(google_issuer.as_bytes(), port, &state, Provider::Yandex).is_none());
        let too_many = format!(
            "{good}&{}",
            (0..33)
                .map(|n| format!("x{n}=1"))
                .collect::<Vec<_>>()
                .join("&")
        );
        assert!(parse_request(
            request(port, &too_many).as_bytes(),
            port,
            &state,
            Provider::Google
        )
        .is_none());
    }

    #[test]
    fn provider_error_is_sanitised_and_denial_is_distinct() {
        for (error, denied) in [("access_denied", true), ("unauthorized_client", false)] {
            let registry = CallbackRegistry::default();
            let port = start(&registry, 'A', 'B', Duration::from_secs(4));
            let query = format!(
                "state={}&error={error}&error_description=PRIVATE-DETAIL",
                nonce('A')
            );
            let response = exchange(port, &request(port, &query));
            assert!(response.starts_with("HTTP/1.1 200 OK"));
            assert!(!response.contains("PRIVATE-DETAIL"));
            let result = poll_terminal(&registry, &nonce('B'));
            assert!(matches!(result, CallbackStatus::Denied) == denied);
            assert!(matches!(result, CallbackStatus::Error) != denied);
            assert!(matches!(
                registry.poll(&nonce('B')).unwrap(),
                CallbackStatus::Consumed
            ));
            wait_finished(&registry);
        }
    }

    #[test]
    fn restricts_ports_nonces_and_active_attempts() {
        let registry = CallbackRegistry::default();
        assert!(registry
            .begin("unknown", 0, nonce('A'), nonce('B'))
            .is_err());
        assert!(registry
            .begin("google", 4444, nonce('A'), nonce('B'))
            .is_err());
        assert!(registry.begin("yandex", 0, nonce('A'), nonce('B')).is_err());
        assert!(registry
            .begin("yandex", 443, nonce('A'), nonce('B'))
            .is_err());
        assert!(registry
            .begin("google", 0, "short".into(), nonce('B'))
            .is_err());
        assert!(registry.begin("google", 0, nonce('A'), nonce('A')).is_err());
        let port = start(&registry, 'A', 'B', Duration::from_secs(4));
        assert!(registry.begin("google", 0, nonce('C'), nonce('D')).is_err());
        let wrong = registry.cancel(&nonce('X')).err().unwrap();
        assert!(!wrong.contains(&nonce('X')));
        assert!(matches!(
            registry.poll(&nonce('B')).unwrap(),
            CallbackStatus::Pending
        ));
        registry.cancel(&nonce('B')).unwrap();
        assert!(matches!(
            registry.poll(&nonce('B')).unwrap(),
            CallbackStatus::Cancelled
        ));
        wait_finished(&registry);
        assert!(registry.begin("google", 0, nonce('A'), nonce('D')).is_err());
        assert!(registry.begin("google", 0, nonce('C'), nonce('B')).is_err());
        let next = registry.begin("google", 0, nonce('C'), nonce('D')).unwrap();
        assert!(next > 0);
        registry.cancel(&nonce('D')).unwrap();
        wait_finished(&registry);
        // Не утверждаем, что ОС немедленно повторно выдаст тот же порт.
        assert!(port > 0);
    }

    #[test]
    fn yandex_uses_the_exact_configured_port_and_refuses_a_busy_one() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        let registry = CallbackRegistry::default();
        assert!(registry
            .begin("yandex", port, nonce('A'), nonce('B'))
            .is_err());
        drop(occupied);
        let actual = registry
            .begin("yandex", port, nonce('A'), nonce('B'))
            .unwrap();
        assert_eq!(actual, port);
        let response = exchange(
            port,
            &request(port, &format!("code=example&state={}", nonce('A'))),
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(matches!(
            poll_terminal(&registry, &nonce('B')),
            CallbackStatus::Code(_)
        ));
        wait_finished(&registry);
    }

    #[test]
    fn cancellation_releases_even_a_slow_client_without_accepting_its_late_code() {
        let registry = CallbackRegistry::default();
        let port = start(&registry, 'A', 'B', Duration::from_secs(4));
        let mut slow = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        slow.write_all(b"GET /oauth/cloud/callback?").unwrap();
        thread::sleep(Duration::from_millis(40));
        registry.cancel(&nonce('B')).unwrap();
        assert!(matches!(
            registry.poll(&nonce('B')).unwrap(),
            CallbackStatus::Cancelled
        ));
        let _ =
            slow.write_all(format!("code=late&state={} HTTP/1.1\r\n\r\n", nonce('A')).as_bytes());
        wait_finished(&registry);
        assert!(matches!(
            registry.poll(&nonce('B')).unwrap(),
            CallbackStatus::Cancelled
        ));
        let next = registry.begin("google", 0, nonce('C'), nonce('D')).unwrap();
        assert!(next > 0);
        registry.cancel(&nonce('D')).unwrap();
        wait_finished(&registry);
    }

    #[test]
    fn expires_waiting_and_unclaimed_code_without_reusing_it() {
        let waiting = CallbackRegistry::default();
        let _port = start(&waiting, 'A', 'B', Duration::from_millis(180));
        thread::sleep(Duration::from_millis(260));
        assert!(matches!(
            waiting.poll(&nonce('B')).unwrap(),
            CallbackStatus::Expired
        ));
        wait_finished(&waiting);

        let ready = CallbackRegistry::default();
        let port = start(&ready, 'C', 'D', Duration::from_millis(250));
        let response = exchange(
            port,
            &request(port, &format!("code=private&state={}", nonce('C'))),
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        thread::sleep(Duration::from_millis(330));
        assert!(matches!(
            ready.poll(&nonce('D')).unwrap(),
            CallbackStatus::Expired
        ));
        wait_finished(&ready);
    }

    #[test]
    fn cancel_after_callback_drops_the_unclaimed_code() {
        let registry = CallbackRegistry::default();
        let port = start(&registry, 'A', 'B', Duration::from_secs(4));
        let response = exchange(
            port,
            &request(port, &format!("code=private&state={}", nonce('A'))),
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        registry.cancel(&nonce('B')).unwrap();
        assert!(matches!(
            registry.poll(&nonce('B')).unwrap(),
            CallbackStatus::Cancelled
        ));
        wait_finished(&registry);
    }

    #[test]
    fn simultaneous_pollers_get_one_code_in_total() {
        let registry = Arc::new(CallbackRegistry::default());
        let port = start(&registry, 'A', 'B', Duration::from_secs(4));
        let response = exchange(
            port,
            &request(port, &format!("code=private&state={}", nonce('A'))),
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    registry.poll(&nonce('B')).unwrap()
                })
            })
            .collect();
        let mut codes = 0;
        let mut consumed = 0;
        for worker in threads {
            match worker.join().unwrap() {
                CallbackStatus::Code(_) => codes += 1,
                CallbackStatus::Consumed => consumed += 1,
                _ => panic!("unexpected callback status"),
            }
        }
        assert_eq!((codes, consumed), (1, 7));
        wait_finished(&registry);
    }
}

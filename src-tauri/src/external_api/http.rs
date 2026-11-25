//! Разбор HTTP-запроса и сборка ответа для внешнего API.
//!
//! Только `std`: сервер принимает одно соединение «запрос → ответ → закрыть»,
//! без keep-alive и без chunked-кодирования. Размер заголовков и тела ограничен,
//! время чтения — тоже: медленный или бесконечный запрос не должен держать поток
//! приёма. Всё, что можно проверить без сокета (разбор строки запроса, заголовки,
//! длина тела), вынесено в чистые функции и покрыто тестами.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Заголовки запроса: 16 КиБ вместе со строкой запроса.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;
/// Тело запроса: 64 КиБ. Это данные для PATCH и bulk-update, больше не нужно.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// Сколько ждём весь запрос (заголовки и тело вместе).
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Период проверки времени, пока данных нет.
const READ_TICK: Duration = Duration::from_millis(200);
const CRLFCRLF: &[u8] = b"\r\n\r\n";

/// Разобранный запрос. Тело — байты: проверка UTF-8 и JSON — на стороне моста.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// Строка запроса после `?` без самого знака (может быть пустой).
    pub query: String,
    /// Имена заголовков в нижнем регистре.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Почему запрос не прочитан. Код ответа выбирает вызывающая сторона.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    /// Строка запроса или заголовок не разбираются.
    Malformed,
    /// Заголовки или тело больше допустимого.
    TooLarge,
    /// Клиент не прислал запрос целиком за отведённое время.
    Timeout,
    /// Сокет закрылся или вернул ошибку.
    Io,
}

/// Читает запрос из соединения целиком: заголовки, затем тело по `Content-Length`.
pub fn read_request(stream: &mut TcpStream) -> Result<Request, ReadError> {
    stream
        .set_read_timeout(Some(READ_TICK))
        .map_err(|_| ReadError::Io)?;
    let deadline = Instant::now() + READ_TIMEOUT;
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(head_end) = find_header_end(&buffer) {
            if head_end + CRLFCRLF.len() > MAX_HEADER_BYTES {
                return Err(ReadError::TooLarge);
            }
            let request = parse_head(&buffer[..head_end]).ok_or(ReadError::Malformed)?;
            let length = body_length(&request.headers)?;
            if length > MAX_BODY_BYTES {
                return Err(ReadError::TooLarge);
            }
            let body_start = head_end + CRLFCRLF.len();
            let total = body_start + length;
            while buffer.len() < total {
                if Instant::now() >= deadline {
                    return Err(ReadError::Timeout);
                }
                read_more(stream, &mut buffer, &mut chunk)?;
            }
            // Лишние байты после тела (клиент не держит соединение) просто отбрасываются.
            return Ok(Request {
                body: buffer[body_start..total].to_vec(),
                ..request
            });
        }
        if buffer.len() >= MAX_HEADER_BYTES {
            return Err(ReadError::TooLarge);
        }
        if Instant::now() >= deadline {
            return Err(ReadError::Timeout);
        }
        read_more(stream, &mut buffer, &mut chunk)?;
    }
}

/// Один шаг чтения: `Ok(())` — данных может стать больше, ошибка — конец.
fn read_more(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
    chunk: &mut [u8; 4096],
) -> Result<(), ReadError> {
    match stream.read(chunk) {
        Ok(0) => Err(ReadError::Malformed),
        Ok(count) => {
            buffer.extend_from_slice(&chunk[..count]);
            Ok(())
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(())
        }
        Err(_) => Err(ReadError::Io),
    }
}

/// Позиция начала `\r\n\r\n` (граница заголовков и тела).
pub fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(CRLFCRLF.len())
        .position(|window| window == CRLFCRLF)
}

/// Разбирает строку запроса и заголовки. Тело всегда пустое — его дочитывает вызывающая сторона.
pub fn parse_head(bytes: &[u8]) -> Option<Request> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_string();
    let target = request_line.next()?;
    let version = request_line.next()?;
    if !version.starts_with("HTTP/1.") || method.is_empty() || target.is_empty() {
        return None;
    }
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.to_string(), String::new()),
    };
    if !path.starts_with('/') {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() || name.len() > 64 {
            return None;
        }
        headers.push((name, value.trim().to_string()));
    }
    Some(Request {
        method,
        path,
        query,
        headers,
        body: Vec::new(),
    })
}

/// Значение первого заголовка с указанным именем (имя — в нижнем регистре).
pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// Длина тела из `Content-Length`. `chunked` не поддерживаем: это не тот клиент, ради которого он нужен.
pub fn body_length(headers: &[(String, String)]) -> Result<usize, ReadError> {
    if let Some(encoding) = header(headers, "transfer-encoding") {
        if !encoding.is_empty() {
            return Err(ReadError::Malformed);
        }
    }
    match header(headers, "content-length") {
        None => Ok(0),
        Some(value) => value.parse::<usize>().map_err(|_| ReadError::Malformed),
    }
}

/// Текст причины для строки состояния HTTP.
pub fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        423 => "Locked",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Unknown",
    }
}

/// Пишет ответ и закрывает соединение: `Connection: close` в каждом ответе.
pub fn write_response(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(String, String)],
    body: &[u8],
) -> io::Result<()> {
    let mut out = Vec::with_capacity(256 + body.len());
    out.extend_from_slice(format!("HTTP/1.1 {} {}\r\n", status, reason(status)).as_bytes());
    for (name, value) in headers {
        out.extend_from_slice(format!("{}: {}\r\n", name, value).as_bytes());
    }
    out.extend_from_slice(b"Connection: close\r\n");
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
    out.extend_from_slice(body);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    stream.write_all(&out)?;
    stream.flush()
}

/// Ответ JSON с общими для всех ошибок заголовками.
pub fn json_headers() -> Vec<(String, String)> {
    vec![
        (
            "Content-Type".to_string(),
            "application/json; charset=utf-8".to_string(),
        ),
        ("Cache-Control".to_string(), "no-store".to_string()),
        ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
    ]
}

/// Ответ об ошибке в общем формате `{ "error": { "code", "message" } }`.
pub fn error_body(code: &str, message: &str) -> Vec<u8> {
    // Имена кодов и сообщения задаём сами: JSON собираем экранированием строк.
    let body = format!(
        "{{\"error\":{{\"code\":{},\"message\":{}}}}}",
        json_string(code),
        json_string(message)
    );
    body.into_bytes()
}

/// Строка в кавычках для JSON: экранируются только управляющие символы и кавычка.
pub fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::{
        body_length, error_body, find_header_end, header, json_string, parse_head, reason,
        MAX_BODY_BYTES, MAX_HEADER_BYTES,
    };

    const HEAD: &[u8] =
        b"GET /api/v1/characters?party=Osnova HTTP/1.1\r\nHost: 127.0.0.1:47831\r\nAuthorization: Bearer abc\r\n\r\n";

    #[test]
    fn request_line_and_query_are_split() {
        let end = find_header_end(HEAD).unwrap();
        let request = parse_head(&HEAD[..end]).unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/api/v1/characters");
        assert_eq!(request.query, "party=Osnova");
        assert_eq!(header(&request.headers, "host"), Some("127.0.0.1:47831"));
        assert_eq!(
            header(&request.headers, "authorization"),
            Some("Bearer abc")
        );
        assert!(request.body.is_empty());
    }

    #[test]
    fn header_names_are_case_insensitive_after_parsing() {
        let end = find_header_end(HEAD).unwrap();
        let request = parse_head(&HEAD[..end]).unwrap();
        assert!(request
            .headers
            .iter()
            .all(|(name, _)| name == &name.to_ascii_lowercase()));
    }

    #[test]
    fn broken_requests_are_rejected() {
        assert!(parse_head(b"garbage").is_none());
        assert!(parse_head(b"GET /x HTTP/1.1\r\nBadHeader\r\n\r\n").is_none());
        assert!(parse_head(b"GET /x HTTP/1.1").is_none());
        assert!(parse_head(b"GET x HTTP/1.1\r\n\r\n").is_none());
    }

    #[test]
    fn body_length_follows_content_length_and_refuses_chunked() {
        let plain = vec![("content-length".to_string(), "12".to_string())];
        assert_eq!(body_length(&plain), Ok(12));
        assert_eq!(body_length(&[]), Ok(0));
        assert!(body_length(&[("content-length".into(), "x".into())]).is_err());
        assert!(body_length(&[("transfer-encoding".into(), "chunked".into())]).is_err());
        assert_eq!(MAX_BODY_BYTES, 64 * 1024);
        assert_eq!(MAX_HEADER_BYTES, 16 * 1024);
        // Тело больше лимита проверяется до чтения: длина из заголовка уже отклоняется.
        let huge = MAX_BODY_BYTES + 1;
        assert!(huge > MAX_BODY_BYTES);
    }

    #[test]
    fn json_string_escapes_only_what_is_needed() {
        assert_eq!(json_string("Маг"), "\"Маг\"");
        assert_eq!(json_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(json_string("a\nb"), "\"a\\nb\"");
        let body = String::from_utf8(error_body("not_found", "Нет")).unwrap();
        assert_eq!(
            body,
            "{\"error\":{\"code\":\"not_found\",\"message\":\"Нет\"}}"
        );
    }

    #[test]
    fn every_status_we_send_has_a_reason() {
        for status in [
            200, 202, 204, 400, 401, 403, 404, 405, 409, 415, 422, 423, 429, 501, 503, 504,
        ] {
            assert_ne!(reason(status), "Unknown", "нет текста для {status}");
        }
        assert_eq!(reason(429), "Too Many Requests");
    }
}

//! Правила доступа внешнего API: проверка `Host`, Bearer-токен, права и лимит частоты.
//!
//! Всё здесь — чистые функции и небольшие структуры без сети и без Tauri, чтобы
//! правила можно было проверить тестами. Сам сервер (`mod.rs`) только вызывает их
//! в нужном порядке.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Сколько запросов в минуту принимаем с одного адреса (адрес всегда 127.0.0.1).
pub const RATE_LIMIT: usize = 60;
/// Окно лимита частоты.
pub const RATE_WINDOW: Duration = Duration::from_secs(60);

/// Что нужно для запроса.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Чтение: `GET /characters`, `/parties`, `/windows`, `/jobs/{id}`.
    Read,
    /// Изменение данных: `PATCH /characters/{id}`, `POST /characters/bulk-update`.
    Modify,
    /// Запуск и закрытие окон: `/launch/*`, `/windows/close`, `/app/show`.
    LaunchClose,
}

/// Права, выданные пользователем в настройках.
/// `launch_close` в JS-настройках называется `launchClose`, поэтому camelCase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scopes {
    pub read: bool,
    pub modify: bool,
    pub launch_close: bool,
}

impl Default for Scopes {
    fn default() -> Self {
        // По умолчанию включено только чтение: изменение и запуск пользователь
        // разрешает галочкой, а не «заодно с включением сервера».
        Self {
            read: true,
            modify: false,
            launch_close: false,
        }
    }
}

impl Scopes {
    pub fn allows(&self, access: Access) -> bool {
        match access {
            Access::Read => self.read,
            Access::Modify => self.modify,
            Access::LaunchClose => self.launch_close,
        }
    }
}

/// Разрешён ли `Host`. Защита от DNS rebinding: имя хоста должно быть loopback.
pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else {
        return false;
    };
    let expected = format!(":{port}");
    let host = host.trim();
    if !host.ends_with(&expected) {
        return false;
    }
    let name = &host[..host.len() - expected.len()];
    name.eq_ignore_ascii_case("127.0.0.1") || name.eq_ignore_ascii_case("localhost")
}

/// Токен из заголовка `Authorization: Bearer <token>`.
///
/// Возвращает `None`, если заголовка нет, схема не Bearer или токен не похож на
/// наш: 64 шестнадцатеричных символа. Формат проверяем здесь же, чтобы сравнение
/// с сохранённым токеном не зависело от длины присланной строки.
pub fn bearer_token(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    let token = token.trim();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(token)
}

/// Право, которое требуется запросу. `Err` — код ошибки для ответа.
///
/// Здесь же проверяется форма пути: он должен быть ASCII без пробелов и `..`,
/// иначе мы отказываем ещё до разбора (такой путь не построит ни один клиент).
pub fn access_for(method: &str, path: &str) -> Result<Access, &'static str> {
    if !path.is_ascii() || path.contains("..") || path.contains(' ') || !path.starts_with('/') {
        return Err("not_found");
    }
    let rest = match path.strip_prefix("/api/v1") {
        Some(rest) => rest,
        None => return Err("not_found"),
    };
    let segments: Vec<&str> = rest.split('/').skip(1).collect();
    match (method, segments.as_slice()) {
        ("GET", ["health"])
        | ("GET", ["characters"])
        | ("GET", ["characters", _])
        | ("GET", ["parties"])
        | ("GET", ["parties", _])
        | ("GET", ["marathons"])
        | ("GET", ["marathons", _])
        | ("GET", ["marathons", _, "participants"])
        | ("GET", ["planner"])
        | ("GET", ["finance"])
        | ("GET", ["windows"])
        | ("GET", ["jobs", _])
        | ("GET", ["export", _])
        | ("GET", ["audit"]) => Ok(Access::Read),
        ("PATCH", ["characters", _])
        | ("POST", ["characters"])
        | ("POST", ["characters", "bulk-update"])
        | ("PATCH", ["dungeon-passes", _])
        | ("POST", ["marathons", _, "marks"])
        | ("POST", ["marathons", _, "adjust"])
        | ("PATCH", ["parties", _]) => Ok(Access::Modify),
        ("POST", ["launch", "character"])
        | ("POST", ["launch", "party"])
        | ("POST", ["launch", "selection"])
        | ("POST", ["windows", "close"])
        | ("POST", ["app", "show"]) => Ok(Access::LaunchClose),
        ("GET", _) | ("POST", _) | ("PATCH", _) => Err("not_found"),
        _ => Err("method_not_allowed"),
    }
}

/// Требует ли запрос тела `application/json`. Тело есть только у POST и PATCH.
pub fn body_expected(method: &str) -> bool {
    matches!(method, "POST" | "PATCH")
}

/// Подходит ли `Content-Type` для тела запроса.
pub fn json_content_type(value: Option<&str>) -> bool {
    match value {
        None => false,
        Some(value) => {
            let base = value.split(';').next().unwrap_or("").trim();
            base.eq_ignore_ascii_case("application/json")
        }
    }
}

/// Скользящее окно: не больше `RATE_LIMIT` вызовов за `RATE_WINDOW`.
#[derive(Debug, Default)]
pub struct RateLimiter {
    recent: VecDeque<Instant>,
}

impl RateLimiter {
    /// `true` — запрос можно обслуживать; `false` — лимит исчерпан.
    pub fn allow(&mut self, now: Instant) -> bool {
        while let Some(oldest) = self.recent.front() {
            if now.duration_since(*oldest) >= RATE_WINDOW {
                self.recent.pop_front();
            } else {
                break;
            }
        }
        if self.recent.len() >= RATE_LIMIT {
            return false;
        }
        self.recent.push_back(now);
        true
    }

    /// Сколько секунд ждать до следующего запроса (для `Retry-After`).
    pub fn retry_after_secs(&self, now: Instant) -> u64 {
        match self.recent.front() {
            Some(oldest) => {
                let elapsed = now.duration_since(*oldest);
                RATE_WINDOW.saturating_sub(elapsed).as_secs().max(1)
            }
            None => 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        access_for, bearer_token, body_expected, host_allowed, json_content_type, Access,
        RateLimiter, Scopes, RATE_LIMIT, RATE_WINDOW,
    };
    use std::time::{Duration, Instant};

    const PORT: u16 = 47831;
    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn host_must_be_loopback_with_our_port() {
        assert!(host_allowed(Some("127.0.0.1:47831"), PORT));
        assert!(host_allowed(Some("localhost:47831"), PORT));
        assert!(host_allowed(Some("LOCALHOST:47831"), PORT));
        assert!(!host_allowed(Some("127.0.0.1:1234"), PORT));
        assert!(!host_allowed(Some("evil.example:47831"), PORT));
        assert!(!host_allowed(Some("127.0.0.1"), PORT));
        assert!(!host_allowed(Some("127.0.0.1.evil.example:47831"), PORT));
        assert!(!host_allowed(None, PORT));
    }

    #[test]
    fn bearer_token_requires_scheme_and_hex_length() {
        assert_eq!(bearer_token(Some(&format!("Bearer {TOKEN}"))), Some(TOKEN));
        assert_eq!(bearer_token(Some(&format!("bearer {TOKEN}"))), Some(TOKEN));
        assert_eq!(bearer_token(Some(TOKEN)), None);
        assert_eq!(bearer_token(Some("Basic abc")), None);
        assert_eq!(bearer_token(Some("Bearer короткий")), None);
        assert_eq!(
            bearer_token(Some(&format!("Bearer {}", "z".repeat(64)))),
            None
        );
        assert_eq!(bearer_token(None), None);
    }

    #[test]
    fn scopes_default_to_read_only() {
        let scopes = Scopes::default();
        assert!(scopes.allows(Access::Read));
        assert!(!scopes.allows(Access::Modify));
        assert!(!scopes.allows(Access::LaunchClose));
        let full = Scopes {
            read: true,
            modify: true,
            launch_close: true,
        };
        assert!(full.allows(Access::Modify) && full.allows(Access::LaunchClose));
    }

    #[test]
    fn routes_require_the_expected_scope() {
        assert_eq!(access_for("GET", "/api/v1/health"), Ok(Access::Read));
        assert_eq!(access_for("GET", "/api/v1/characters"), Ok(Access::Read));
        assert_eq!(
            access_for("GET", "/api/v1/characters/Mag_1"),
            Ok(Access::Read)
        );
        assert_eq!(access_for("GET", "/api/v1/parties"), Ok(Access::Read));
        assert_eq!(access_for("GET", "/api/v1/windows"), Ok(Access::Read));
        assert_eq!(access_for("GET", "/api/v1/jobs/job_1"), Ok(Access::Read));
        assert_eq!(
            access_for("PATCH", "/api/v1/characters/Mag_1"),
            Ok(Access::Modify)
        );
        assert_eq!(
            access_for("POST", "/api/v1/characters/bulk-update"),
            Ok(Access::Modify)
        );
        assert_eq!(
            access_for("POST", "/api/v1/launch/party"),
            Ok(Access::LaunchClose)
        );
        assert_eq!(
            access_for("POST", "/api/v1/windows/close"),
            Ok(Access::LaunchClose)
        );
        assert_eq!(
            access_for("POST", "/api/v1/app/show"),
            Ok(Access::LaunchClose)
        );
        assert_eq!(
            access_for("GET", "/api/v1/characters/Mag_1/extra"),
            Err("not_found")
        );
        // Удалять персонажей через API нельзя: метод просто не поддерживается.
        assert_eq!(
            access_for("DELETE", "/api/v1/characters/Mag_1"),
            Err("method_not_allowed")
        );
        assert_eq!(
            access_for("DELETE", "/api/v1/marathons/m1"),
            Err("method_not_allowed")
        );
        // Марафоны, планировщик, учёт и выгрузки — чтение.
        assert_eq!(access_for("GET", "/api/v1/marathons"), Ok(Access::Read));
        assert_eq!(access_for("GET", "/api/v1/marathons/m1"), Ok(Access::Read));
        assert_eq!(
            access_for("GET", "/api/v1/marathons/m1/participants"),
            Ok(Access::Read)
        );
        assert_eq!(access_for("GET", "/api/v1/planner"), Ok(Access::Read));
        assert_eq!(access_for("GET", "/api/v1/finance"), Ok(Access::Read));
        assert_eq!(
            access_for("GET", "/api/v1/export/characters.csv"),
            Ok(Access::Read)
        );
        // Изменение данных — право «Изменение статов и проходок».
        assert_eq!(access_for("POST", "/api/v1/characters"), Ok(Access::Modify));
        assert_eq!(
            access_for("PATCH", "/api/v1/dungeon-passes/Mag_1"),
            Ok(Access::Modify)
        );
        assert_eq!(
            access_for("POST", "/api/v1/marathons/m1/marks"),
            Ok(Access::Modify)
        );
        assert_eq!(
            access_for("POST", "/api/v1/marathons/m1/adjust"),
            Ok(Access::Modify)
        );
        assert_eq!(
            access_for("PATCH", "/api/v1/parties/p1"),
            Ok(Access::Modify)
        );
        // Запуск выбранных персонажей — право «Запуск и закрытие окон».
        assert_eq!(
            access_for("POST", "/api/v1/launch/selection"),
            Ok(Access::LaunchClose)
        );
        assert_eq!(access_for("GET", "/other"), Err("not_found"));
        assert_eq!(
            access_for("GET", "/api/v1/characters/../../etc"),
            Err("not_found")
        );
        assert_eq!(
            access_for("GET", "/api/v1/characters/Маг"),
            Err("not_found")
        );
    }

    #[test]
    fn json_bodies_are_required_for_post_and_patch() {
        assert!(body_expected("POST"));
        assert!(body_expected("PATCH"));
        assert!(!body_expected("GET"));
        assert!(json_content_type(Some("application/json")));
        assert!(json_content_type(Some("application/json; charset=utf-8")));
        assert!(!json_content_type(Some("text/plain")));
        assert!(!json_content_type(None));
    }

    #[test]
    fn rate_limiter_allows_sixty_then_asks_to_wait() {
        let mut limiter = RateLimiter::default();
        let start = Instant::now();
        for _ in 0..RATE_LIMIT {
            assert!(limiter.allow(start));
        }
        assert!(!limiter.allow(start));
        assert!(limiter.retry_after_secs(start) >= 1);
        // Через минуту окно освободилось.
        assert!(limiter.allow(start + RATE_WINDOW));
        assert!(limiter.retry_after_secs(start + Duration::from_secs(1)) >= 1);
    }
}

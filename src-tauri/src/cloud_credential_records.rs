//! Проверка канонических OAuth-записей на границе нативного хранилища.
//!
//! Никаких токенов или исходных ошибок в сообщения. Это НЕ проверка прав на
//! облачный диск и НЕ подтверждение аккаунта. Настоящее подтверждение должно
//! быть получено от человека и провайдера до установки записи.

use crate::cloud_credential_store::{valid_uuid, Provider, MAX_RECORD_BYTES};

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

// Никакого Debug: внутри есть приватный идентификатор аккаунта.
pub(crate) struct Binding {
    pub(crate) slot_id: String,
    client_id: String,
    account_key: String,
    revision: String,
    phase: Phase,
    attempt_id: Option<String>,
}

#[derive(PartialEq, Eq)]
enum Phase {
    Ready,
    Pending,
    Yandex,
}

struct Cursor<'a> {
    source: &'a [u8],
    index: usize,
}

impl<'a> Cursor<'a> {
    fn new(raw: &'a str) -> Option<Self> {
        if raw.is_empty() || raw.len() > MAX_RECORD_BYTES || !raw.is_ascii() {
            return None;
        }
        Some(Self {
            source: raw.as_bytes(),
            index: 0,
        })
    }

    fn literal(&mut self, value: &str) -> Option<()> {
        let remaining = self.source.get(self.index..)?;
        if !remaining.starts_with(value.as_bytes()) {
            return None;
        }
        self.index += value.len();
        Some(())
    }

    // JSON.stringify для допустимого печатного ASCII экранирует лишь `"` и `\`.
    // Нестандартные представления, дубликаты и изменённый порядок не принимаем.
    fn string(&mut self) -> Option<String> {
        self.literal("\"")?;
        let mut out = Vec::new();
        loop {
            let byte = *self.source.get(self.index)?;
            self.index += 1;
            match byte {
                b'"' => break,
                b'\\' => {
                    let escaped = *self.source.get(self.index)?;
                    self.index += 1;
                    if !matches!(escaped, b'"' | b'\\') {
                        return None;
                    }
                    out.push(escaped);
                }
                b' '..=b'~' => out.push(byte),
                _ => return None,
            }
        }
        String::from_utf8(out).ok()
    }

    fn optional_string(&mut self) -> Option<Option<String>> {
        if self
            .source
            .get(self.index..)
            .is_some_and(|rest| rest.starts_with(b"null"))
        {
            self.literal("null")?;
            Some(None)
        } else {
            Some(Some(self.string()?))
        }
    }

    fn number(&mut self) -> Option<u64> {
        let start = self.index;
        while self.source.get(self.index).is_some_and(u8::is_ascii_digit) {
            self.index += 1;
        }
        let digits = self.source.get(start..self.index)?;
        if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') || digits.len() > 16 {
            return None;
        }
        let number = std::str::from_utf8(digits).ok()?.parse::<u64>().ok()?;
        if number == 0 || number > JS_MAX_SAFE_INTEGER {
            return None;
        }
        Some(number)
    }

    fn optional_number(&mut self) -> Option<Option<u64>> {
        if self
            .source
            .get(self.index..)
            .is_some_and(|rest| rest.starts_with(b"null"))
        {
            self.literal("null")?;
            Some(None)
        } else {
            Some(Some(self.number()?))
        }
    }

    fn end(&self) -> Option<()> {
        (self.index == self.source.len()).then_some(())
    }
}

fn valid_client(provider: Provider, value: &str) -> bool {
    let id = match provider {
        Provider::Google => match value.strip_suffix(".apps.googleusercontent.com") {
            Some(prefix) if (3..=200).contains(&prefix.len()) => prefix,
            _ => return false,
        },
        Provider::Yandex if (16..=128).contains(&value.len()) => value,
        Provider::Yandex | Provider::KeyState => return false,
    };
    id.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_account(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
}

fn valid_yandex_token(value: &str) -> bool {
    if value.is_empty() || value.len() > 8192 {
        return false;
    }
    let core = value.trim_end_matches('=');
    !core.is_empty()
        && core.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'-')
        })
}

/// Принимает только собственный канонический формат, совместимый с JS-кодеком.
/// Временные копии токена находятся в памяти; гарантированного стирания строк нет.
pub(crate) fn parse(provider: Provider, raw: &str) -> Option<Binding> {
    let mut c = Cursor::new(raw)?;
    match provider {
        Provider::Google => c.literal(
            "{\"format\":\"tvinoferma-google-oauth-credential\",\"version\":1,\"slotId\":",
        )?,
        Provider::Yandex => {
            c.literal("{\"format\":\"tvinoferma-yandex-oauth-access\",\"version\":1,\"slotId\":")?
        }
        Provider::KeyState => return None,
    }
    let slot_id = c.string()?;
    c.literal(",\"clientId\":")?;
    let client_id = c.string()?;
    c.literal(",\"accountKey\":")?;
    let account_key = c.string()?;
    c.literal(",\"revision\":")?;
    let revision = c.string()?;
    if !valid_uuid(&slot_id)
        || !valid_uuid(&revision)
        || slot_id == revision
        || !valid_client(provider, &client_id)
        || !valid_account(&account_key)
    {
        return None;
    }
    let (phase, attempt_id) = match provider {
        Provider::Google => {
            c.literal(",\"phase\":")?;
            let phase = c.string()?;
            c.literal(",\"attemptId\":")?;
            let attempt = c.optional_string()?;
            c.literal(",\"refreshToken\":")?;
            let refresh = c.optional_string()?;
            c.literal(",\"refreshExpiresAt\":")?;
            let refresh_expires_at = c.optional_number()?;
            match phase.as_str() {
                "ready" => {
                    let token = refresh?;
                    if attempt.is_some()
                        || token.is_empty()
                        || token.len() > 8192
                        || !token.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
                    {
                        return None;
                    }
                    (Phase::Ready, None)
                }
                "pending" => {
                    let id = attempt?;
                    if !valid_uuid(&id)
                        || id == slot_id
                        || id == revision
                        || refresh.is_some()
                        || refresh_expires_at.is_some()
                    {
                        return None;
                    }
                    (Phase::Pending, Some(id))
                }
                _ => return None,
            }
        }
        Provider::Yandex => {
            c.literal(",\"accessToken\":")?;
            let access = c.string()?;
            c.literal(",\"expiresAt\":")?;
            let _ = c.number()?;
            if !valid_yandex_token(&access) {
                return None;
            }
            (Phase::Yandex, None)
        }
        Provider::KeyState => return None,
    };
    c.literal("}")?;
    c.end()?;
    Some(Binding {
        slot_id,
        client_id,
        account_key,
        revision,
        phase,
        attempt_id,
    })
}

/// Разрешена только первая ready-запись; token+account должны быть отдельно
/// подтверждены до этого вызова. Заблокированное хранилище не очищается само.
pub(crate) fn valid_initial(provider: Provider, slot_id: &str, raw: &str) -> bool {
    parse(provider, raw).is_some_and(|record| {
        record.slot_id == slot_id && matches!(record.phase, Phase::Ready | Phase::Yandex)
    })
}

/// Ротация разрешена только для Google, с той же привязкой аккаунта и slot.
/// Яндекс access token пока заменяется исключительно через явное забывание и
/// повторное подтверждение. Эта проверка не доказывает устойчивости записи ОС.
pub(crate) fn valid_transition(provider: Provider, slot_id: &str, old: &str, next: &str) -> bool {
    if provider != Provider::Google {
        return false;
    }
    let (Some(before), Some(after)) = (parse(provider, old), parse(provider, next)) else {
        return false;
    };
    if before.slot_id != slot_id
        || after.slot_id != slot_id
        || before.client_id != after.client_id
        || before.account_key != after.account_key
        || before.revision == after.revision
    {
        return false;
    }
    match (before.phase, after.phase) {
        (Phase::Ready, Phase::Pending) => {
            after.attempt_id.as_deref() != Some(before.revision.as_str())
        }
        (Phase::Pending, Phase::Ready) => {
            before.attempt_id.as_deref() != Some(after.revision.as_str())
        }
        _ => false,
    }
}

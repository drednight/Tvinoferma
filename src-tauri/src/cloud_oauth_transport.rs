//! Ограниченная политика для одноразовой проверки OAuth в настольном приложении.
//! Нельзя передать произвольный URL, заголовки, refresh token или команду работы
//! с файлами. Сетевой исполнитель находится в commands/cloud_oauth_transport.rs.
//! Формы и токены не включаются в ошибки или журналы.

const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";
const YANDEX_TOKEN: &str = "https://oauth.yandex.com/token";
const GOOGLE_IDENTITY: &str =
    "https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%2CemailAddress%29";
const YANDEX_IDENTITY: &str = "https://login.yandex.ru/info?format=json";
const MAX_FORM_BYTES: usize = 32 * 1024;
const MAX_TOKEN_BYTES: usize = 8192;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    Google,
    Yandex,
}

impl Provider {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "google" => Some(Self::Google),
            "yandex" => Some(Self::Yandex),
            _ => None,
        }
    }

    pub fn token_url(self) -> &'static str {
        match self {
            Self::Google => GOOGLE_TOKEN,
            Self::Yandex => YANDEX_TOKEN,
        }
    }

    pub fn identity_url(self) -> &'static str {
        match self {
            Self::Google => GOOGLE_IDENTITY,
            Self::Yandex => YANDEX_IDENTITY,
        }
    }

    pub fn authorization_prefix(self) -> &'static str {
        match self {
            Self::Google => "Bearer ",
            Self::Yandex => "OAuth ",
        }
    }
}

fn visible_ascii(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn base_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

fn valid_client_id(provider: Provider, value: &str) -> bool {
    match provider {
        Provider::Google => value
            .strip_suffix(".apps.googleusercontent.com")
            .is_some_and(|prefix| {
                (3..=200).contains(&prefix.len()) && prefix.bytes().all(base_char)
            }),
        Provider::Yandex => (16..=128).contains(&value.len()) && value.bytes().all(base_char),
    }
}

fn valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| base_char(byte) || matches!(byte, b'.' | b'~'))
}

fn valid_google_redirect(value: &str) -> bool {
    let Some(port) = value
        .strip_prefix("http://127.0.0.1:")
        .and_then(|suffix| suffix.strip_suffix("/oauth/cloud/callback"))
    else {
        return false;
    };
    !port.is_empty()
        && port.len() <= 5
        && !port.starts_with('0')
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|number| number >= 1024)
}

fn decode_form_part(value: &str) -> Option<String> {
    let raw = value.as_bytes();
    let mut decoded = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'%' => {
                let hex = |byte: u8| match byte {
                    b'0'..=b'9' => Some(byte - b'0'),
                    b'a'..=b'f' => Some(byte - b'a' + 10),
                    b'A'..=b'F' => Some(byte - b'A' + 10),
                    _ => None,
                };
                let high = hex(*raw.get(index + 1)?)?;
                let low = hex(*raw.get(index + 2)?)?;
                decoded.push(high * 16 + low);
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
    String::from_utf8(decoded).ok()
}

/// Только обмен кода PKCE. Переданный body остаётся неизменным и никогда не
/// журналируется. Все поля, включая повторённые или неизвестные, проверяются до сети.
pub fn valid_code_form(provider: Provider, body: &str) -> bool {
    if !visible_ascii(body, MAX_FORM_BYTES) {
        return false;
    }
    let mut grant = None;
    let mut client = None;
    let mut code = None;
    let mut verifier = None;
    let mut redirect = None;
    for part in body.split('&') {
        let Some((name, value)) = part.split_once('=') else {
            return false;
        };
        let Some(name) = decode_form_part(name) else {
            return false;
        };
        let Some(value) = decode_form_part(value) else {
            return false;
        };
        let field = match name.as_str() {
            "grant_type" => &mut grant,
            "client_id" => &mut client,
            "code" => &mut code,
            "code_verifier" => &mut verifier,
            "redirect_uri" if provider == Provider::Google => &mut redirect,
            _ => return false,
        };
        if field.replace(value).is_some() {
            return false;
        }
    }
    grant.as_deref() == Some("authorization_code")
        && client
            .as_deref()
            .is_some_and(|value| valid_client_id(provider, value))
        && code
            .as_deref()
            .is_some_and(|value| visible_ascii(value, 2048))
        && verifier.as_deref().is_some_and(valid_verifier)
        && match provider {
            Provider::Google => redirect.as_deref().is_some_and(valid_google_redirect),
            Provider::Yandex => redirect.is_none(),
        }
}

/// Токен допустим исключительно в Authorization header, без пробелов и CR/LF.
pub fn valid_access_token(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_TOKEN_BYTES {
        return false;
    }
    let mut padding = false;
    let mut content = false;
    for byte in value.bytes() {
        if byte == b'=' {
            padding = true;
        } else if !padding
            && (byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'-'))
        {
            content = true;
        } else {
            return false;
        }
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(provider: Provider) -> String {
        let (client, redirect) = match provider {
            Provider::Google => (
                "123-example.apps.googleusercontent.com",
                "&redirect_uri=http%3A%2F%2F127.0.0.1%3A37181%2Foauth%2Fcloud%2Fcallback",
            ),
            Provider::Yandex => ("0123456789abcdef0123456789abcdef", ""),
        };
        format!(
            "grant_type=authorization_code&client_id={client}&code=code%2Bvalue&code_verifier={}{}",
            "a".repeat(43),
            redirect
        )
    }

    #[test]
    fn only_known_providers_have_fixed_https_targets() {
        assert!(Provider::parse("google").is_some());
        assert!(Provider::parse("yandex").is_some());
        assert_eq!(Provider::parse("Google"), None);
        assert_eq!(Provider::parse("http://localhost"), None);
        for provider in [Provider::Google, Provider::Yandex] {
            assert!(provider.token_url().starts_with("https://"));
            assert!(provider.identity_url().starts_with("https://"));
        }
        assert_eq!(Provider::Google.authorization_prefix(), "Bearer ");
        assert_eq!(Provider::Yandex.authorization_prefix(), "OAuth ");
    }

    #[test]
    fn valid_code_requests_only() {
        for provider in [Provider::Google, Provider::Yandex] {
            assert!(valid_code_form(provider, &body(provider)));
            assert!(!valid_code_form(provider, ""));
            assert!(!valid_code_form(
                provider,
                &(body(provider) + "&client_secret=secret")
            ));
            assert!(!valid_code_form(
                provider,
                &(body(provider) + "&grant_type=authorization_code")
            ));
            assert!(!valid_code_form(
                provider,
                &(body(provider) + "&%67rant_type=authorization_code")
            ));
            assert!(!valid_code_form(
                provider,
                &body(provider).replace("authorization_code", "refresh_token")
            ));
            assert!(!valid_code_form(
                provider,
                &body(provider).replace("code%2Bvalue", "a%0d%0ab")
            ));
            assert!(!valid_code_form(
                provider,
                &body(provider).replace("code%2Bvalue", "a+b")
            ));
            assert!(!valid_code_form(
                provider,
                &body(provider).replace("code%2Bvalue", "%zz")
            ));
            assert!(!valid_code_form(
                provider,
                &body(provider).replace("code%2Bvalue", "%")
            ));
            assert!(!valid_code_form(
                provider,
                &body(provider).replace(&"a".repeat(43), &"a".repeat(42))
            ));
            assert!(!valid_code_form(
                provider,
                &body(provider).replace(&"a".repeat(43), &"a".repeat(129))
            ));
            assert!(!valid_code_form(
                provider,
                &body(provider).replace("code_verifier=", "code_verifier=x%20")
            ));
            assert!(!valid_code_form(provider, &(body(provider) + "&")));
        }
    }

    #[test]
    fn form_binds_correct_provider_and_redirect() {
        assert!(!valid_code_form(Provider::Google, &body(Provider::Yandex)));
        assert!(!valid_code_form(Provider::Yandex, &body(Provider::Google)));
        let good = body(Provider::Google);
        for bad in [
            "http%3A%2F%2Flocalhost%3A37181%2Foauth%2Fcloud%2Fcallback",
            "https%3A%2F%2F127.0.0.1%3A37181%2Foauth%2Fcloud%2Fcallback",
            "http%3A%2F%2F127.0.0.1%3A080%2Foauth%2Fcloud%2Fcallback",
            "http%3A%2F%2F127.0.0.1%3A80%2Foauth%2Fcloud%2Fcallback",
            "http%3A%2F%2F127.0.0.1%3A65536%2Foauth%2Fcloud%2Fcallback",
            "http%3A%2F%2F127.0.0.1%3A37181%2Fother",
            "http%3A%2F%2F127.0.0.1%3A37181%2Foauth%2Fcloud%2Fcallback%3Fx%3D1",
        ] {
            assert!(!valid_code_form(
                Provider::Google,
                &good.replace(
                    "http%3A%2F%2F127.0.0.1%3A37181%2Foauth%2Fcloud%2Fcallback",
                    bad
                )
            ));
        }
    }

    #[test]
    fn token_header_disallows_injection_and_invalid_padding() {
        for value in ["a", "abc-._~+/===", &"x".repeat(MAX_TOKEN_BYTES)] {
            assert!(valid_access_token(value));
        }
        for value in [
            "",
            "=",
            "a=b",
            "x y",
            "x\r\nHeader:y",
            "ю",
            &"x".repeat(MAX_TOKEN_BYTES + 1),
        ] {
            assert!(!valid_access_token(value));
        }
    }
}

//! Узкий сетевой канал для разовой диагностики и экспериментального refresh Google.
//! Команда не читает/записывает файлы диска и не сохраняет учётные данные.
//! Адреса зафиксированы в Rust; входные секреты и исходные ошибки не журналируются.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::cloud_oauth_transport::{
    valid_access_token, valid_code_form, valid_google_refresh_form, Provider,
};
use serde::Serialize;

const ERROR: &str = "Не удалось безопасно выполнить запрос авторизации";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOAuthNetworkReply {
    body: String,
    content_type: String,
}

/// Возвращает только JSON успешного ответа. Секреты внутри ответа предназначены
/// исключительно доверенному главному окну и не должны попадать в журналы.
#[tauri::command]
pub async fn cloud_oauth_network(
    window: tauri::WebviewWindow,
    provider: String,
    operation: String,
    form: Option<String>,
    access_token: Option<String>,
) -> Result<CloudOAuthNetworkReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    execute(provider, operation, form, access_token).await
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn execute(
    _provider: String,
    _operation: String,
    _form: Option<String>,
    _access_token: Option<String>,
) -> Result<CloudOAuthNetworkReply, String> {
    Err(ERROR.into())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn execute(
    provider: String,
    operation: String,
    form: Option<String>,
    access_token: Option<String>,
) -> Result<CloudOAuthNetworkReply, String> {
    use reqwest::header::{
        ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    const MAX_RESPONSE_BYTES: usize = 64 * 1024;
    static ACTIVE: AtomicBool = AtomicBool::new(false);

    struct ActiveGuard;
    impl Drop for ActiveGuard {
        fn drop(&mut self) {
            ACTIVE.store(false, Ordering::Release);
        }
    }

    let fail = || ERROR.to_owned();
    let provider = Provider::parse(&provider).ok_or_else(fail)?;
    let request = match operation.as_str() {
        "exchange" if access_token.is_none() => {
            let body = form
                .filter(|value| valid_code_form(provider, value))
                .ok_or_else(fail)?;
            (provider.token_url(), Some(body), None)
        }
        "refresh" if provider == Provider::Google && access_token.is_none() => {
            let body = form
                .filter(|value| valid_google_refresh_form(value))
                .ok_or_else(fail)?;
            (provider.token_url(), Some(body), None)
        }
        "identity" if form.is_none() => {
            let token = access_token
                .filter(|value| valid_access_token(value))
                .ok_or_else(fail)?;
            (provider.identity_url(), None, Some(token))
        }
        _ => return Err(fail()),
    };
    if ACTIVE
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return Err(fail());
    }
    let _active = ActiveGuard;

    // Та же реализация ring, что и в updater 2.13.3. Если другой компонент уже
    // установил провайдер, повторная установка не меняет глобальный выбор.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .tls_backend_rustls()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| fail())?;
    let mut builder = match (request.1, request.2) {
        (Some(body), None) => client
            .post(request.0)
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(body),
        (None, Some(token)) => client.get(request.0).header(
            AUTHORIZATION,
            format!("{}{token}", provider.authorization_prefix()),
        ),
        _ => return Err(fail()),
    };
    builder = builder
        .header(ACCEPT, "application/json")
        .header(ACCEPT_ENCODING, "identity")
        .header(CACHE_CONTROL, "no-store");
    let mut response = builder.send().await.map_err(|_| fail())?;
    if response.status().as_u16() != 200
        || response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(fail());
    }
    let encodings = response.headers().get_all(CONTENT_ENCODING);
    let mut encodings = encodings.iter();
    if let Some(encoding) = encodings.next() {
        if encoding
            .to_str()
            .map_or(true, |value| !value.eq_ignore_ascii_case("identity"))
            || encodings.next().is_some()
        {
            return Err(fail());
        }
    }
    let types = response.headers().get_all(CONTENT_TYPE);
    let mut types = types.iter();
    let content_type = types
        .next()
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(fail)?
        .to_owned();
    if types.next().is_some() {
        return Err(fail());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| fail())? {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(fail());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| fail())?;
    Ok(CloudOAuthNetworkReply { body, content_type })
}

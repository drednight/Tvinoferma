//! Сетевой канал дисков с фиксированными безопасными кодами отказа.
//! Только главное окно и подготовленные Rust-политикой операции. Реальные Tauri,
//! reqwest, провайдеры и Windows ещё не проверены. Ни URL, ни токены, ни исходные
//! ошибки/ответы провайдера при неуспехе не записываются в журналы.

use crate::cloud_disk_transport::CloudDiskArgs;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::cloud_disk_transport::{prepare, Method};
use serde::Serialize;

const ERROR: &str = "Не удалось безопасно выполнить запрос облачного диска";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDiskReply {
    status: u16,
    body: String,
    content_type: Option<String>,
}

/// Ошибка после отправки НЕ означает, что провайдер не записал файл. Отмена в JS
/// также не гарантирует остановку native-запроса. Повтор записи здесь не делается.
#[tauri::command]
pub async fn cloud_disk_network(
    window: tauri::WebviewWindow,
    args: CloudDiskArgs,
) -> Result<CloudDiskReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    execute(args).await
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn execute(_args: CloudDiskArgs) -> Result<CloudDiskReply, String> {
    Err(ERROR.into())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn execute(args: CloudDiskArgs) -> Result<CloudDiskReply, String> {
    use reqwest::header::{
        ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    // Один активный запрос на процесс: при зависшей нативной работе новый запрос
    // не стартует. Это не межпроцессная блокировка и не устойчивый журнал записи.
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    struct ActiveGuard;
    impl Drop for ActiveGuard {
        fn drop(&mut self) {
            ACTIVE.store(false, Ordering::Release);
        }
    }

    let fail = || ERROR.to_owned();
    let request = prepare(args).ok_or_else(|| "cloud_disk_policy".to_owned())?;
    if ACTIVE
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return Err("cloud_disk_busy".into());
    }
    let _active = ActiveGuard;
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
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "cloud_disk_client".to_owned())?;
    // No automatic retry. A failed/unknown preflight never starts a destructive request.
    let mut retirement_etag = None;
    if let Some(guard) = &request.retirement {
        let mut probe = client
            .get(&guard.metadata_url)
            .header(ACCEPT_ENCODING, "identity")
            .header(CACHE_CONTROL, "no-store");
        if let Some(auth) = &request.authorization {
            probe = probe.header(AUTHORIZATION, auth);
        }
        let mut reply = probe.send().await.map_err(network_error)?;
        if reply.status().as_u16() != 200 || reply.content_length().is_some_and(|n| n > 65536) {
            return Err(fail());
        }
        if reply
            .headers()
            .get(CONTENT_ENCODING)
            .is_some_and(|v| v.as_bytes() != b"identity")
        {
            return Err(fail());
        }
        if guard.google {
            let tag = reply
                .headers()
                .get(reqwest::header::ETAG)
                .ok_or_else(fail)?
                .to_str()
                .map_err(|_| fail())?;
            if tag.len() > 512
                || tag.len() < 2
                || !tag.starts_with('"')
                || !tag.ends_with('"')
                || !tag.bytes().all(|b| (0x20..=0x7e).contains(&b))
            {
                return Err(fail());
            }
            retirement_etag = Some(tag.to_owned());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = reply.chunk().await.map_err(network_error)? {
            if chunk.len() > 65536usize.saturating_sub(bytes.len()) {
                return Err(fail());
            }
            bytes.extend_from_slice(&chunk);
        }
        let raw = String::from_utf8(bytes).map_err(|_| fail())?;
        if !guard.accepts(&raw) {
            return Err(fail());
        }
    }
    let mut builder = match request.method {
        Method::Get => client.get(&request.url),
        Method::Post => client.post(&request.url),
        Method::Put => client.put(&request.url),
        Method::Patch => client.patch(&request.url),
        Method::Delete => client.delete(&request.url),
    }
    .header(ACCEPT_ENCODING, "identity")
    .header(CACHE_CONTROL, "no-store");
    if let Some(tag) = retirement_etag {
        builder = builder.header(reqwest::header::IF_MATCH, tag);
    }
    if request.accept_json {
        builder = builder.header(ACCEPT, "application/json");
    }
    if let Some(authorization) = request.authorization {
        builder = builder.header(AUTHORIZATION, authorization);
    }
    if let Some(content_type) = request.content_type {
        builder = builder.header(CONTENT_TYPE, content_type);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let mut response = builder.send().await.map_err(network_error)?;
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        return Err("cloud_disk_redirect".into());
    }
    if !(200..=599).contains(&status) {
        return Err("cloud_disk_body".into());
    }
    // Тело ошибки может содержать токен, подпись или другой личный текст. Не читаем
    // его. Ответ PUT также не нужен для подтверждения: 201/202 — ещё не сверка.
    if status >= 400 || !request.read_body || matches!(status, 204 | 205) {
        return Ok(CloudDiskReply {
            status,
            body: String::new(),
            content_type: None,
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > request.max_response as u64)
    {
        return Err("cloud_disk_size".into());
    }
    let encodings = response.headers().get_all(CONTENT_ENCODING);
    let mut encodings = encodings.iter();
    if let Some(encoding) = encodings.next() {
        if encoding
            .to_str()
            .map_or(true, |value| !value.eq_ignore_ascii_case("identity"))
            || encodings.next().is_some()
        {
            return Err("cloud_disk_encoding".into());
        }
    }
    let types = response.headers().get_all(CONTENT_TYPE);
    let mut types = types.iter();
    let content_type = match types.next() {
        Some(value) => {
            let value = value.to_str().map_err(|_| "cloud_disk_body".to_owned())?;
            if value.is_empty()
                || value.len() > 256
                || !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
                || types.next().is_some()
            {
                return Err("cloud_disk_body".into());
            }
            Some(value.to_owned())
        }
        None => None,
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > request.max_response.saturating_sub(bytes.len()) {
            return Err("cloud_disk_size".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "cloud_disk_body".to_owned())?;
    Ok(CloudDiskReply {
        status,
        body,
        content_type,
    })
}

// Do not format reqwest::Error: it can contain signed URLs and credentials.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "cloud_disk_timeout"
    } else if error.is_connect() {
        "cloud_disk_connect"
    } else {
        "cloud_disk_transport"
    }
    .to_owned()
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    #[test]
    fn network_failure_does_not_expose_original_error() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("test client");
        // Invalid URL: no socket opened, no provider or real credential involved.
        let error = client
            .get("PRIVATE_FAKE_INVALID_URL")
            .build()
            .expect_err("invalid URL");
        assert_eq!(super::network_error(error), "cloud_disk_transport");
    }
}

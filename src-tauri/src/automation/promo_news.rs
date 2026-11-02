//! Public news only: no character cookies, login, PIN activation, redirects or arbitrary URLs.
use crate::parsers::{eval_and_wait, navigate_scoped, QUIET_SCOPE};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

fn news_url(page: Option<u8>, article: Option<&str>) -> Result<String, String> {
    match (page, article) {
        (Some(1), None) => Ok("https://pwonline.ru/news.php".into()),
        (Some(n @ 2), None) => Ok(format!(
            "https://pwonline.ru/news.php?archive=news&type=last&page={n}"
        )),
        (None, Some(id))
            if !id.is_empty() && id.len() <= 12 && id.bytes().all(|b| b.is_ascii_digit()) =>
        {
            Ok(format!("https://pwonline.ru/news.php?article={id}"))
        }
        _ => Err("news_request_invalid".into()),
    }
}
fn decode_html(bytes: &[u8], content_type: &str) -> String {
    if !content_type.to_ascii_lowercase().contains("windows-1251") {
        if let Ok(text) = std::str::from_utf8(bytes) {
            return text.to_string();
        }
    }
    // The old public news site can use Windows-1251. Never execute this HTML.
    const LOW: &str = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—�™љ›њќћџ\u{a0}ЎўЈ¤Ґ¦§Ё©Є«¬\u{ad}®Ї°±Ііґµ¶·ё№є»јЅѕї";
    bytes
        .iter()
        .map(|b| match *b {
            0..=127 => *b as char,
            128..=191 => LOW.chars().nth((*b - 128) as usize).unwrap_or('�'),
            _ => char::from_u32(0x410 + (*b as u32 - 192)).unwrap_or('�'),
        })
        .collect()
}

#[tauri::command]
pub async fn fetch_promo_news_page(
    app: AppHandle,
    page: Option<u8>,
    article: Option<String>,
    browser: Option<bool>,
) -> Result<Value, String> {
    let url = news_url(page, article.as_deref())?;
    if browser.unwrap_or(false) {
        return browser_page(app, &url, article.is_some()).await;
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "Tvinoferma/",
            env!("CARGO_PKG_VERSION"),
            " (public news reader)"
        ))
        .tls_backend_rustls()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "news_client")?;
    let mut response = client
        .get(url)
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "news_timeout"
            } else {
                "news_network"
            }
        })?;
    let status = response.status().as_u16();
    if status != 200 {
        return Ok(json!({"status":status,"html":null}));
    }
    const MAX: usize = 2 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > MAX as u64) {
        return Err("news_size".into());
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !content_type.is_empty() && !content_type.to_ascii_lowercase().contains("text/html") {
        return Err("news_content_type".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "news_body")? {
        if body.len() + chunk.len() > MAX {
            return Err("news_size".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(json!({"status":200,"html":decode_html(&body,&content_type)}))
}

// A normal WebView2 reader when the website denies a non-browser HTTP client.
// Separate incognito profile: NEVER reuse a character window or cookie bank.
fn public_news_navigation(url: &Url) -> bool {
    if url.scheme() == "about" {
        return url.path() == "blank" && url.query().is_none();
    }
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("pwonline.ru" | "www.pwonline.ru"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/news.php"
    {
        return false;
    }
    let fields: Vec<_> = url.query_pairs().collect();
    if fields.len() == 1 && fields[0].0 == "article" {
        return news_url(None, Some(&fields[0].1)).is_ok();
    }
    fields.is_empty()
        || fields.len() == 3
            && fields
                .iter()
                .filter(|(k, v)| k == "archive" && v == "news")
                .count()
                == 1
            && fields
                .iter()
                .filter(|(k, v)| k == "type" && v == "last")
                .count()
                == 1
            && fields
                .iter()
                .filter(|(k, v)| k == "page" && matches!(v.as_ref(), "1" | "2"))
                .count()
                == 1
}
async fn browser_page(app: AppHandle, url: &str, article: bool) -> Result<Value, String> {
    static READER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _lease = tokio::time::timeout(Duration::from_secs(14), READER.lock())
        .await
        .map_err(|_| "news_timeout")?;
    const LABEL: &str = "public-promo-news-readonly";
    let window = if let Some(window) = app.get_webview_window(LABEL) {
        window
    } else {
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|_| "news_client")?
            .join("anonymous-public-news");
        std::fs::create_dir_all(&dir).map_err(|_| "news_client")?;
        WebviewWindowBuilder::new(
            &app,
            LABEL,
            WebviewUrl::External(Url::parse("about:blank").map_err(|_| "news_client")?),
        )
        .title("Public news reader")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .incognito(true)
        .data_directory(dir)
        .on_navigation(public_news_navigation)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .build()
        .map_err(|_| "news_client")?
    };
    let result = async {
        navigate_scoped(&window, url, QUIET_SCOPE)
            .await
            .map_err(|_| "news_network".to_string())?;
        let script = format!(
            "window.__TF_PUBLIC_PROMO_NEWS={};\n{}",
            json!({"article":article,"url":url}),
            include_str!("../scripts/promo_news_public.js")
        );
        match eval_and_wait(&window, &script, "#TF_PUBLIC_NEWS_V1_", 10, QUIET_SCOPE).await {
            Some((None, data)) if data["html"].is_string() => {
                Ok(json!({"status":200,"html":data["html"],"reader":"webview"}))
            }
            Some((Some(error), _)) => Err(match error.as_str() {
                "news_challenge" => "news_challenge",
                "news_http_403" => "news_http_403",
                "news_size" => "news_size",
                _ => "news_markup",
            }
            .into()),
            _ => Err("news_timeout".into()),
        }
    }
    .await;
    // Unload article timers/resources; keep only the isolated reader infrastructure.
    let _ = window.navigate(Url::parse("about:blank").map_err(|_| "news_client")?);
    result
}

fn article_navigation(url: &Url, article: &str) -> bool {
    public_news_navigation(url)
        && (url.as_str() == "about:blank"
            || url.query_pairs().count() == 1
                && url
                    .query_pairs()
                    .any(|(key, value)| key == "article" && value == article))
}

/// User-requested article viewer. A separate anonymous owned WebView, never a character profile.
#[tauri::command]
pub async fn open_promo_news_article(
    app: AppHandle,
    window: tauri::WebviewWindow,
    article: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("news_request_invalid".into());
    }
    let url = Url::parse(&news_url(None, Some(&article))?).map_err(|_| "news_request_invalid")?;
    const LABEL: &str = "public-promo-news-viewer";
    if let Some(viewer) = app.get_webview_window(LABEL) {
        let _ = viewer.set_focus();
        return if viewer
            .url()
            .map(|current| current.query() == url.query())
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err("news_viewer_busy".into())
        };
    }
    let main = window.clone();
    let article_id = article;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "news_client")?
        .join("public-promo-news-viewer-v1");
    std::fs::create_dir_all(&cache).map_err(|_| "news_client")?;
    let viewer = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .title("Новость — источник промокода")
        .inner_size(1040., 760.)
        .resizable(true)
        .visible(false)
        .incognito(true)
        .data_directory(cache)
        .on_navigation(move |url| article_navigation(url, &article_id))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .parent(&window)
        .map_err(|_| "news_client")?
        .build()
        .map_err(|_| "news_client")?;
    viewer.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = main.set_enabled(true);
            let _ = main.set_focus();
        }
    });
    if window.set_enabled(false).is_err() {
        let _ = viewer.close();
        return Err("news_client".into());
    }
    if viewer.show().is_err() {
        let _ = window.set_enabled(true);
        let _ = viewer.close();
        return Err("news_client".into());
    }
    let _ = viewer.set_focus();
    Ok(())
}

/// Restore access to Stop if a background script starts while an article is open.
#[tauri::command]
pub fn close_promo_news_article(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("news_request_invalid".into());
    }
    if let Some(viewer) = app.get_webview_window("public-promo-news-viewer") {
        viewer.destroy().map_err(|_| "news_client")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn viewer_is_pinned_to_the_requested_article() {
        for value in [
            "https://pwonline.ru/news.php?article=9142",
            "https://www.pwonline.ru/news.php?article=9142#rewards",
            "about:blank",
        ] {
            assert!(article_navigation(&Url::parse(value).unwrap(), "9142"));
        }
        for value in [
            "https://pwonline.ru/news.php?article=9126",
            "https://pwonline.ru/news.php",
            "https://pwonline.ru/pin/PWTEST2026",
            "https://pwonline.ru/news.php?article=9142&article=9142",
            "https://pwonline.ru/news.php?article=9142&do=activate",
            "https://other.test/news.php?article=9142",
        ] {
            assert!(!article_navigation(&Url::parse(value).unwrap(), "9142"));
        }
    }
    #[test]
    fn only_two_indexes_and_numeric_articles() {
        assert_eq!(
            news_url(Some(1), None).unwrap(),
            "https://pwonline.ru/news.php"
        );
        assert!(news_url(Some(2), None).is_ok());
        assert!(news_url(None, Some("12345")).is_ok());
        assert!(news_url(Some(3), None).is_err());
        assert!(news_url(Some(1), Some("1")).is_err());
        for bad in [
            "",
            "../pin/CODE",
            "https://evil.test",
            "1&foo=2",
            "１２",
            "1234567890123",
        ] {
            assert!(news_url(None, Some(bad)).is_err());
        }
    }
    #[test]
    fn reader_cannot_navigate_to_login_pin_or_foreign_hosts() {
        for value in [
            "https://pwonline.ru/news.php",
            "https://pwonline.ru/news.php?article=123",
            "https://www.pwonline.ru/news.php?archive=news&type=last&page=2",
            "about:blank",
        ] {
            assert!(public_news_navigation(&Url::parse(value).unwrap()));
        }
        for value in [
            "https://pwonline.ru/pin/CODE1234",
            "https://pwonline.ru/login.php",
            "https://other.test/news.php?article=1",
            "http://pwonline.ru/news.php?article=1",
            "https://pwonline.ru/news.php?article=1&do=login",
            "https://pwonline.ru/news.php?archive=news&type=last&page=3",
            "https://pwonline.ru/news.php?archive=news&archive=news&type=last",
        ] {
            assert!(!public_news_navigation(&Url::parse(value).unwrap()));
        }
    }
    #[test]
    fn decodes_both_site_encodings() {
        assert_eq!(
            decode_html("Промокод".as_bytes(), "text/html; charset=utf-8"),
            "Промокод"
        );
        assert_eq!(
            decode_html(
                &[0xcf, 0xf0, 0xee, 0xec, 0xee, 0xea, 0xee, 0xe4],
                "windows-1251"
            ),
            "Промокод"
        );
    }
}

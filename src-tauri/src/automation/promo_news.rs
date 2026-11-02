//! Public news only: no character cookies, login, PIN activation, redirects or arbitrary URLs.
use serde_json::{json, Value};
use std::time::Duration;

fn news_url(page: Option<u8>, article: Option<&str>) -> Result<String, String> {
    match (page, article) {
        (Some(n @ 1..=2), None) => Ok(format!(
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
    page: Option<u8>,
    article: Option<String>,
) -> Result<Value, String> {
    let url = news_url(page, article.as_deref())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_two_indexes_and_numeric_articles() {
        assert!(news_url(Some(1), None).is_ok());
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

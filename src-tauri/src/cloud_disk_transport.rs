//! Экспериментальная политика операций с облачными версиями. UI к ней не подключён.
//! Адреса и заголовки собираются здесь, а не принимаются как произвольный HTTP-запрос.
//! Формат конверта проверяется, но сам по себе не доказывает шифрование или доверие
//! к вызывающему коду. Токены, временные ссылки и содержимое нельзя журналировать.

use crate::cloud_oauth_transport::{valid_access_token, Provider};

const GOOGLE_FILES: &str = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id%2Cname%2CappProperties";
const GOOGLE_FOLDER_QUERY: &str = "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='tfFolder' and value='1' }";
const GOOGLE_IDENTITY: &str =
    "https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%29";
const YANDEX_IDENTITY: &str = "https://login.yandex.ru/info?format=json";
const YANDEX_RESOURCES: &str = "https://cloud-api.yandex.net/v1/disk/resources";
const MAX_URL_BYTES: usize = 24_576;
const MAX_LINK_BYTES: usize = 8_192;
const MAX_METADATA_BYTES: usize = 2 * 1024 * 1024;
const MAX_VERSION_BYTES: usize = 45 * 1024 * 1024;
const MAX_SMALL_REPLY_BYTES: usize = 64 * 1024;
const MAX_IDENTITY_BYTES: usize = 8_192;
const MAX_GOOGLE_MULTIPART_BYTES: usize = 5_000_000;
const MAX_CIPHER_BYTES: usize = 32 * 1024 * 1024 + 16;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Параметры одной известной операции. Неизвестные поля от Tauri запрещены.
/// Поля разных операций не взаимозаменяемы; все неиспользованные отклоняются.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudDiskArgs {
    pub provider: String,
    pub operation: String,
    pub access_token: Option<String>,
    pub folder_id: Option<String>,
    pub dataset_id: Option<String>,
    pub version_id: Option<String>,
    pub file_id: Option<String>,
    pub page_token: Option<String>,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
    pub link: Option<String>,
    pub body: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Method {
    Get,
    Post,
    Put,
}

pub struct PreparedRequest {
    pub method: Method,
    pub url: String,
    pub authorization: Option<String>,
    pub content_type: Option<String>,
    pub body: Option<String>,
    pub accept_json: bool,
    pub max_response: usize,
    pub read_body: bool,
}

fn sync_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn google_id(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

fn canonical_base64url(value: &str, minimum: usize, maximum: usize) -> bool {
    let length = value.len();
    if length % 4 == 1 || length > maximum.saturating_add(2) / 3 * 4 {
        return false;
    }
    let decoded = length / 4 * 3
        + match length % 4 {
            2 => 1,
            3 => 2,
            _ => 0,
        };
    if !(minimum..=maximum).contains(&decoded)
        || !value.bytes().all(|byte| base64_value(byte).is_some())
    {
        return false;
    }
    match length % 4 {
        2 => value
            .bytes()
            .last()
            .and_then(base64_value)
            .is_some_and(|n| n & 15 == 0),
        3 => value
            .bytes()
            .last()
            .and_then(base64_value)
            .is_some_and(|n| n & 3 == 0),
        _ => true,
    }
}

/// Принимаем только канонический JSON, который строит copyCloudEnvelope в JS.
/// Так невозможны дополнительные поля, повторные ключи, переносы MIME и открытые
/// строки вне поля ciphertext. Проверка не доказывает реальное AES-GCM шифрование.
fn canonical_envelope(body: &str, dataset: &str, version: &str) -> bool {
    if body.len() > MAX_VERSION_BYTES || !sync_id(dataset) || !sync_id(version) {
        return false;
    }
    let prefix = format!(
        "{{\"format\":\"tvinoferma-cloud-sync\",\"version\":1,\"algorithm\":\"AES-256-GCM\",\"datasetId\":\"{dataset}\",\"versionId\":\"{version}\",\"iv\":\""
    );
    let Some(rest) = body.strip_prefix(&prefix) else {
        return false;
    };
    let Some((iv, tail)) = rest.split_once("\",\"ciphertext\":\"") else {
        return false;
    };
    let Some(ciphertext) = tail.strip_suffix("\"}") else {
        return false;
    };
    canonical_base64url(iv, 12, 12) && canonical_base64url(ciphertext, 16, MAX_CIPHER_BYTES)
}

/// WHATWG URLSearchParams использует application/x-www-form-urlencoded.
fn form_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'*' | b'-' | b'.' | b'_') {
            output.push(char::from(byte));
        } else if byte == b' ' {
            output.push('+');
        } else {
            output.push('%');
            output.push(char::from(HEX[(byte >> 4) as usize]));
            output.push(char::from(HEX[(byte & 15) as usize]));
        }
    }
    output
}

fn valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if !bytes.get(index + 1).is_some_and(u8::is_ascii_hexdigit)
                || !bytes.get(index + 2).is_some_and(u8::is_ascii_hexdigit)
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

/// Подписанная ссылка — секрет. Разрешены лишь документированные хосты и пути,
/// без логина, порта, fragment, backslash, относительных сегментов и неоднозначных
/// escape в пути. OAuth отправляется только на downloader, не на uploader.
fn signed_link(value: &str, upload: bool) -> bool {
    if value.is_empty()
        || value.len() > MAX_LINK_BYTES
        || !value
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte) && !matches!(byte, b'#' | b'\\'))
        || !valid_percent_encoding(value)
    {
        return false;
    }
    let Some(rest) = value.strip_prefix("https://") else {
        return false;
    };
    let Some((host, path_and_query)) = rest.split_once('/') else {
        return false;
    };
    let allowed_host = if upload {
        host.strip_prefix("uploader")
            .and_then(|suffix| suffix.strip_suffix(".dst.yandex.net"))
            .is_some_and(|middle| {
                middle
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            })
    } else {
        host == "downloader.dst.yandex.ru"
    };
    let path = path_and_query.split('?').next().unwrap_or_default();
    let prefix = if upload { "upload-target/" } else { "disk/" };
    let lower = path.to_ascii_lowercase();
    allowed_host
        && path.starts_with(prefix)
        && !path.split('/').any(|segment| matches!(segment, "." | ".."))
        && !lower.contains("%2f")
        && !lower.contains("%5c")
        && !lower.contains("%2e")
}

fn version_path(dataset: &str, version: &str) -> String {
    format!("app:/tf-v1-{dataset}-{version}.tfsc")
}

fn take_id(value: &mut Option<String>, validator: fn(&str) -> bool) -> Option<String> {
    value.take().filter(|value| validator(value))
}

fn no_extra(args: &CloudDiskArgs) -> bool {
    args.access_token.is_none()
        && args.folder_id.is_none()
        && args.dataset_id.is_none()
        && args.version_id.is_none()
        && args.file_id.is_none()
        && args.page_token.is_none()
        && args.offset.is_none()
        && args.limit.is_none()
        && args.link.is_none()
        && args.body.is_none()
}

/// Не выполняет сеть. Некорректные комбинации параметров отклоняются до запроса.
pub fn prepare(mut args: CloudDiskArgs) -> Option<PreparedRequest> {
    let provider = Provider::parse(&args.provider)?;
    let operation = std::mem::take(&mut args.operation);
    let is_unsigned_upload = provider == Provider::Yandex && operation == "upload_content";
    let authorization = if is_unsigned_upload {
        if args.access_token.is_some() {
            return None;
        }
        None
    } else {
        let token = args
            .access_token
            .take()
            .filter(|value| valid_access_token(value))?;
        Some(format!("{}{token}", provider.authorization_prefix()))
    };
    let mut request = PreparedRequest {
        method: Method::Get,
        url: String::new(),
        authorization,
        content_type: None,
        body: None,
        accept_json: false,
        max_response: MAX_SMALL_REPLY_BYTES,
        read_body: true,
    };
    match (provider, operation.as_str()) {
        (Provider::Google, "identity") => {
            request.url = GOOGLE_IDENTITY.into();
            request.accept_json = true;
            request.max_response = MAX_IDENTITY_BYTES;
        }
        (Provider::Yandex, "identity") => {
            request.url = YANDEX_IDENTITY.into();
            request.accept_json = true;
            request.max_response = MAX_IDENTITY_BYTES;
        }
        (Provider::Google, "generate_id") => {
            request.url = format!("{GOOGLE_FILES}/generateIds?count=1&space=drive&type=files");
        }
        (Provider::Google, "folder_list") => {
            request.url = format!(
                "{GOOGLE_FILES}?q={}&fields={}&pageSize=100",
                form_encode(GOOGLE_FOLDER_QUERY),
                form_encode("nextPageToken,incompleteSearch,files(id,name,mimeType,appProperties)")
            );
            if let Some(page) = args.page_token.take() {
                if page.is_empty() || page.len() > 16_384 {
                    return None;
                }
                request.url.push_str("&pageToken=");
                request.url.push_str(&form_encode(&page));
            }
            request.max_response = MAX_METADATA_BYTES;
        }
        (Provider::Google, "folder_create") => {
            let file = take_id(&mut args.file_id, google_id)?;
            request.method = Method::Post;
            request.url = format!("{GOOGLE_FILES}?fields=id%2Cname%2CmimeType%2CappProperties");
            request.accept_json = true;
            request.content_type = Some("application/json".into());
            request.body = Some(format!(
                "{{\"id\":\"{file}\",\"name\":\"Твиноферма\",\"mimeType\":\"application/vnd.google-apps.folder\",\"appProperties\":{{\"tfFolder\":\"1\"}}}}"
            ));
        }
        (Provider::Google, "list") => {
            let folder = take_id(&mut args.folder_id, google_id)?;
            let dataset = take_id(&mut args.dataset_id, sync_id)?;
            let version = match args.version_id.take() {
                Some(value) if sync_id(&value) => Some(value),
                Some(_) => return None,
                None => None,
            };
            let mut query = format!(
                "'{folder}' in parents and trashed = false and appProperties has {{ key='tfFormat' and value='1' }} and appProperties has {{ key='tfDataset' and value='{dataset}' }}"
            );
            if let Some(version) = version {
                query.push_str(&format!(
                    " and appProperties has {{ key='tfVersion' and value='{version}' }}"
                ));
            }
            request.url = format!(
                "{GOOGLE_FILES}?q={}&fields={}&pageSize=100",
                form_encode(&query),
                form_encode("nextPageToken,incompleteSearch,files(id,name,mimeType,appProperties,modifiedTime)")
            );
            if let Some(page) = args.page_token.take() {
                if page.is_empty() || page.len() > 16_384 {
                    return None;
                }
                request.url.push_str("&pageToken=");
                request.url.push_str(&form_encode(&page));
            }
            request.max_response = MAX_METADATA_BYTES;
        }
        (Provider::Google, "download") => {
            let file = take_id(&mut args.file_id, google_id)?;
            request.url = format!("{GOOGLE_FILES}/{file}?alt=media");
            request.max_response = MAX_VERSION_BYTES;
        }
        (Provider::Google, "create") => {
            let folder = take_id(&mut args.folder_id, google_id)?;
            let dataset = take_id(&mut args.dataset_id, sync_id)?;
            let version = take_id(&mut args.version_id, sync_id)?;
            let file = take_id(&mut args.file_id, google_id)?;
            let envelope = args.body.take()?;
            if !canonical_envelope(&envelope, &dataset, &version) {
                return None;
            }
            let metadata = format!(
                "{{\"id\":\"{file}\",\"name\":\"tf-v1-{dataset}-{version}.tfsc\",\"mimeType\":\"application/octet-stream\",\"parents\":[\"{folder}\"],\"appProperties\":{{\"tfFormat\":\"1\",\"tfDataset\":\"{dataset}\",\"tfVersion\":\"{version}\"}}}}"
            );
            // Конверт и метаданные однострочны и не содержат CR/LF; граница не
            // может встретиться как MIME-разделитель внутри одной из частей.
            let boundary = format!("tf_{version}");
            let head = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n");
            let tail = format!("\r\n--{boundary}--\r\n");
            if head.len() + envelope.len() + tail.len() > MAX_GOOGLE_MULTIPART_BYTES {
                return None;
            }
            request.method = Method::Post;
            request.url = GOOGLE_UPLOAD.into();
            request.content_type = Some(format!("multipart/related; boundary={boundary}"));
            request.body = Some(format!("{head}{envelope}{tail}"));
        }
        (Provider::Yandex, "list") => {
            let offset = args
                .offset
                .take()
                .filter(|value| *value <= MAX_SAFE_INTEGER)?;
            let limit = args
                .limit
                .take()
                .filter(|value| (1..=1000).contains(value))?;
            request.url = format!(
                "{YANDEX_RESOURCES}?path=app%3A%2F&offset={offset}&limit={limit}&sort=name"
            );
            request.accept_json = true;
            request.max_response = MAX_METADATA_BYTES;
        }
        (Provider::Yandex, "metadata" | "download_link" | "upload_link") => {
            let dataset = take_id(&mut args.dataset_id, sync_id)?;
            let version = take_id(&mut args.version_id, sync_id)?;
            let suffix = match operation.as_str() {
                "download_link" => "/download",
                "upload_link" => "/upload",
                _ => "",
            };
            request.url = format!(
                "{YANDEX_RESOURCES}{suffix}?path={}",
                form_encode(&version_path(&dataset, &version))
            );
            if operation == "upload_link" {
                request.url.push_str("&overwrite=false");
            }
            request.accept_json = true;
        }
        (Provider::Yandex, "download_content") => {
            let link = args.link.take().filter(|value| signed_link(value, false))?;
            request.url = link;
            request.max_response = MAX_VERSION_BYTES;
        }
        (Provider::Yandex, "upload_content") => {
            let link = args.link.take().filter(|value| signed_link(value, true))?;
            let dataset = take_id(&mut args.dataset_id, sync_id)?;
            let version = take_id(&mut args.version_id, sync_id)?;
            let envelope = args.body.take()?;
            if !canonical_envelope(&envelope, &dataset, &version) {
                return None;
            }
            request.method = Method::Put;
            request.url = link;
            request.content_type = Some("application/octet-stream".into());
            request.body = Some(envelope);
            request.read_body = false;
        }
        _ => return None,
    }
    if !no_extra(&args) || request.url.len() > MAX_URL_BYTES {
        return None;
    }
    Some(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATASET: &str = "01234567-89ab-4cde-8f01-23456789abcd";
    const VERSION: &str = "11234567-89ab-4cde-8f01-23456789abcd";

    fn args(provider: &str, operation: &str) -> CloudDiskArgs {
        CloudDiskArgs {
            provider: provider.into(),
            operation: operation.into(),
            access_token: Some("FAKE_TOKEN".into()),
            ..Default::default()
        }
    }

    fn envelope() -> String {
        format!("{{\"format\":\"tvinoferma-cloud-sync\",\"version\":1,\"algorithm\":\"AES-256-GCM\",\"datasetId\":\"{DATASET}\",\"versionId\":\"{VERSION}\",\"iv\":\"AAAAAAAAAAAAAAAA\",\"ciphertext\":\"AAAAAAAAAAAAAAAAAAAAAA\"}}")
    }

    #[test]
    fn canonical_envelope_rejects_plaintext_duplicate_and_noncanonical_base64() {
        let body = envelope();
        assert!(canonical_envelope(&body, DATASET, VERSION));
        for changed in [
            body.replace("AES-256-GCM", "none"),
            body.replace("AAAAAA\"}", "AAAAAB\"}"),
            body.replace("AAAAAA\"}", "AAAAAA=\"}"),
            body.replace("\"iv\":", "\"secret\":\"plaintext\",\"iv\":"),
            body.replace("\"iv\":", "\"iv\":\"other\",\"iv\":"),
            body.replace("\"ciphertext\":\"", "\"ciphertext\":\"abc\\n"),
            format!("{body}\n"),
        ] {
            assert!(!canonical_envelope(&changed, DATASET, VERSION));
        }
        assert!(!canonical_envelope(&body, VERSION, DATASET));
        assert!(!canonical_envelope(&body, DATASET, "bad"));
    }

    #[test]
    fn signed_links_restrict_authority_path_and_escapes() {
        assert!(signed_link(
            "https://uploader3.dst.yandex.net/upload-target/?x=1%2F2",
            true
        ));
        assert!(signed_link(
            "https://downloader.dst.yandex.ru/disk/get?x=1%2F2",
            false
        ));
        for link in [
            "http://uploader3.dst.yandex.net/upload-target/x",
            "https://uploader3.dst.yandex.net.evil.test/upload-target/x",
            "https://uploader3.dst.yandex.net@evil.test/upload-target/x",
            "https://uploader3.dst.yandex.net:443/upload-target/x",
            "https://UPLOADER3.dst.yandex.net/upload-target/x",
            "https://uploader3.dst.yandex.net/upload-target/../secret",
            "https://uploader3.dst.yandex.net/upload-target/%2e%2e/secret",
            "https://uploader3.dst.yandex.net/upload-target/%2Fx",
            "https://uploader3.dst.yandex.net/upload-target/%5cx",
            "https://uploader3.dst.yandex.net/upload-target/x#secret",
            "https://uploader3.dst.yandex.net/upload-target/x%xx",
            "https://uploader3.dst.yandex.net/upload-target/\\evil",
            "https://uploader3.dst.yandex.net/other/x",
            "https://downloader.dst.yandex.ru/disk/x",
        ] {
            assert!(!signed_link(link, true), "accepted {link}");
        }
        assert!(!signed_link(
            "https://downloader.dst.yandex.ru.evil/disk/x",
            false
        ));
        assert!(!signed_link(
            "https://downloader.dst.yandex.ru/disk/%2ex",
            false
        ));
    }

    #[test]
    fn google_operations_build_fixed_urls_and_require_exact_fields() {
        let identity = prepare(args("google", "identity")).unwrap();
        assert_eq!(identity.url, GOOGLE_IDENTITY);
        assert_eq!(identity.authorization.as_deref(), Some("Bearer FAKE_TOKEN"));
        let generate = prepare(args("google", "generate_id")).unwrap();
        assert_eq!(
            generate.url,
            format!("{GOOGLE_FILES}/generateIds?count=1&space=drive&type=files")
        );
        let mut folder_list = args("google", "folder_list");
        folder_list.page_token = Some("страница +".into());
        let folder_list = prepare(folder_list).unwrap();
        assert!(folder_list
            .url
            .contains("mimeType+%3D+%27application%2Fvnd.google-apps.folder%27"));
        assert!(folder_list
            .url
            .ends_with("pageToken=%D1%81%D1%82%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D0%B0+%2B"));
        let mut create_folder = args("google", "folder_create");
        create_folder.file_id = Some("folder_id".into());
        let create_folder = prepare(create_folder).unwrap();
        assert_eq!(create_folder.method, Method::Post);
        assert_eq!(
            create_folder.url,
            format!("{GOOGLE_FILES}?fields=id%2Cname%2CmimeType%2CappProperties")
        );
        assert_eq!(
            create_folder.content_type.as_deref(),
            Some("application/json")
        );
        assert_eq!(create_folder.body.as_deref(), Some("{\"id\":\"folder_id\",\"name\":\"Твиноферма\",\"mimeType\":\"application/vnd.google-apps.folder\",\"appProperties\":{\"tfFolder\":\"1\"}}"));
        let mut list = args("google", "list");
        list.folder_id = Some("folder_ID".into());
        list.dataset_id = Some(DATASET.into());
        list.version_id = Some(VERSION.into());
        list.page_token = Some("page ~ +&=русский".into());
        let url = prepare(list).unwrap().url;
        assert!(url
            .starts_with("https://www.googleapis.com/drive/v3/files?q=%27folder_ID%27+in+parents"));
        assert!(
            url.ends_with("pageToken=page+%7E+%2B%26%3D%D1%80%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9")
        );
        let mut download = args("google", "download");
        download.file_id = Some("abc-123".into());
        assert_eq!(
            prepare(download).unwrap().url,
            format!("{GOOGLE_FILES}/abc-123?alt=media")
        );
        let mut extra = args("google", "identity");
        extra.link = Some("https://example.test".into());
        assert!(prepare(extra).is_none());
        let mut bad = args("google", "download");
        bad.file_id = Some("../../secret".into());
        assert!(prepare(bad).is_none());
        assert!(prepare(args("google", "delete")).is_none());
        assert!(prepare(args("other", "identity")).is_none());
    }

    #[test]
    fn create_and_upload_send_only_checked_envelopes_and_no_oauth_to_uploader() {
        let mut google = args("google", "create");
        google.folder_id = Some("folder".into());
        google.dataset_id = Some(DATASET.into());
        google.version_id = Some(VERSION.into());
        google.file_id = Some("file".into());
        google.body = Some(envelope());
        let request = prepare(google).unwrap();
        assert_eq!(request.method, Method::Post);
        assert_eq!(request.url, GOOGLE_UPLOAD);
        assert!(request.body.unwrap().contains(&envelope()));
        let mut upload = args("yandex", "upload_content");
        upload.access_token = None;
        upload.dataset_id = Some(DATASET.into());
        upload.version_id = Some(VERSION.into());
        upload.link = Some("https://uploader.dst.yandex.net/upload-target/file?secret=1".into());
        upload.body = Some(envelope());
        let request = prepare(upload).unwrap();
        assert_eq!(request.method, Method::Put);
        assert!(request.authorization.is_none());
        assert!(!request.read_body);
        assert_eq!(request.body.as_deref(), Some(envelope().as_str()));
        let mut unsafe_upload = args("yandex", "upload_content");
        unsafe_upload.dataset_id = Some(DATASET.into());
        unsafe_upload.version_id = Some(VERSION.into());
        unsafe_upload.link = Some("https://uploader.dst.yandex.net/upload-target/file".into());
        unsafe_upload.body = Some(envelope());
        assert!(prepare(unsafe_upload).is_none());
    }

    #[test]
    fn yandex_versions_have_no_overwrite_and_validated_download() {
        for (operation, suffix) in [
            ("metadata", ""),
            ("download_link", "/download"),
            ("upload_link", "/upload"),
        ] {
            let mut input = args("yandex", operation);
            input.dataset_id = Some(DATASET.into());
            input.version_id = Some(VERSION.into());
            let url = prepare(input).unwrap().url;
            let expected =
                format!("{YANDEX_RESOURCES}{suffix}?path=app%3A%2Ftf-v1-{DATASET}-{VERSION}.tfsc");
            assert_eq!(
                url,
                if operation == "upload_link" {
                    format!("{expected}&overwrite=false")
                } else {
                    expected
                }
            );
        }
        let mut list = args("yandex", "list");
        list.offset = Some(0);
        list.limit = Some(100);
        assert_eq!(
            prepare(list).unwrap().url,
            format!("{YANDEX_RESOURCES}?path=app%3A%2F&offset=0&limit=100&sort=name")
        );
        let mut download = args("yandex", "download_content");
        download.link = Some("https://downloader.dst.yandex.ru/disk/file?s=1".into());
        let request = prepare(download).unwrap();
        assert_eq!(request.authorization.as_deref(), Some("OAuth FAKE_TOKEN"));
        let mut invalid = args("yandex", "list");
        invalid.offset = Some(0);
        invalid.limit = Some(1001);
        assert!(prepare(invalid).is_none());
    }
}

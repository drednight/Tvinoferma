//! Куки-банк: сессии персонажей на pwonline.ru, сохранённые отдельно от профилей браузера.
//!
//! - Хранилище: `<AppData>/com.tvinoferma.desktop/cookie-bank/<char_id>.bin`.
//! - Шифрование: AES-256-GCM. Ключ (32 байта) лежит в хранилище учётных данных ОС
//!   (Windows Credential Manager), рядом с паролями персонажей. Файлы без ключа бесполезны,
//!   на другой ПК они не переносятся (в «Экспорт всех данных» не входят).
//! - Что сохраняется: только куки доменов из `BANK_DOMAINS`. Куки VK / Mail.ru в банк не попадают:
//!   они дают доступ к самому аккаунту VK, а для работы с pwonline.ru не нужны.
//! - Когда сохраняется: после успешной проверки входа (`auth::check_login_status_http`, статус online).
//!   Так банк заодно обновляет куки, которые сайт переиздаёт.
//!
//! Команды для проверки из консоли главного окна (npm run tauri dev, F12):
//!   await __TAURI_INTERNALS__.invoke('bank_status')
//!   await __TAURI_INTERNALS__.invoke('bank_verify', { charId: 'ID' })
//!   await __TAURI_INTERNALS__.invoke('bank_forget', { charId: 'ID' })
//!
//! ВАЖНО (Windows): чтение кук зависает в синхронных командах и обработчиках событий,
//! поэтому всё здесь async, а обращения к кукам идут через `spawn_blocking`.

use crate::parsers::{eval_and_wait, navigate_clean};
use crate::windows::{dispose, get_or_create_hidden_window, window_label};
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::webview::cookie::Cookie;
use tauri::{command, AppHandle, Manager, WebviewWindow};

/// Домены, чьи куки попадают в банк (сам домен и его поддомены).
/// Если проверка `bank_verify` покажет, что для входа нужны ещё куки, домены добавляются сюда.
const BANK_DOMAINS: &[&str] = &["pwonline.ru"];

const USERCP_URL: &str = "https://pwonline.ru/usercp.php";
const AUTH_SCRIPT: &str = include_str!("scripts/check_auth.js");
/// Временный чистый профиль для `bank_verify` (папка `pw-sync-profiles/_bank_probe`).
const PROBE_KEY: &str = "_bank_probe";

const KEYRING_SERVICE: &str = "com.tvinoferma.desktop";
const KEYRING_USER: &str = "cookie-bank-key";

/// Один поток работает с файлами банка и ключом одновременно.
static BANK_IO: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
struct Record {
    v: u8,
    /// unix-время сохранения, секунды
    saved_at: u64,
    /// куки в виде строк `name=value; Domain=...; Path=...; Expires=...; Secure; HttpOnly`
    cookies: Vec<String>,
}

// ---------- вспомогательное ----------

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', ':']) {
        return Err(format!("Недопустимый id персонажа: {}", id));
    }
    Ok(())
}

fn bank_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cookie-bank");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку банка: {}", e))?;
    Ok(dir)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Входит ли кука в банк: домен совпадает с одним из `BANK_DOMAINS` или является его поддоменом.
fn in_scope(c: &Cookie<'_>) -> bool {
    let domain = c.domain().unwrap_or("").trim_start_matches('.').to_ascii_lowercase();
    BANK_DOMAINS
        .iter()
        .any(|d| domain == *d || domain.ends_with(&format!(".{}", d)))
}

// ---------- шифрование ----------

/// Ключ банка из хранилища ОС; при первом запуске создаётся новый.
fn get_or_create_key() -> Result<Vec<u8>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(hex) => from_hex(&hex)
            .filter(|k| k.len() == 32)
            .ok_or_else(|| "Ключ банка кук в хранилище ОС повреждён".to_string()),
        Err(keyring::Error::NoEntry) => {
            let key = Aes256Gcm::generate_key(OsRng);
            entry.set_password(&to_hex(&key)).map_err(|e| e.to_string())?;
            Ok(key.to_vec())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Формат файла: nonce (12 байт) + шифртекст.
fn encrypt(key: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher.encrypt(&nonce, plain).map_err(|e| e.to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

fn decrypt(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 12 + 16 {
        return Err("Файл банка кук повреждён (слишком короткий)".into());
    }
    let (nonce, ct) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "Не удалось расшифровать банк кук (изменился ключ или файл повреждён). Войдите заново — сессия сохранится сама".to_string())
}

// ---------- файлы ----------

fn write_record(dir: &Path, char_id: &str, rec: &Record) -> Result<(), String> {
    let _guard = BANK_IO.lock().unwrap_or_else(|p| p.into_inner());
    let key = get_or_create_key()?;
    let json = serde_json::to_vec(rec).map_err(|e| e.to_string())?;
    let data = encrypt(&key, &json)?;
    let path = dir.join(format!("{}.bin", char_id));
    let tmp = dir.join(format!("{}.bin.tmp", char_id));
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn read_record(dir: &Path, char_id: &str) -> Result<Option<Record>, String> {
    let _guard = BANK_IO.lock().unwrap_or_else(|p| p.into_inner());
    let path = dir.join(format!("{}.bin", char_id));
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let key = get_or_create_key()?;
    let json = decrypt(&key, &data)?;
    serde_json::from_slice(&json).map(Some).map_err(|e| e.to_string())
}

/// Переносит запись банка при смене id персонажа (вызывается из `windows::rename_char_profiles`).
pub fn rename(app: &AppHandle, old_id: &str, new_id: &str) {
    if check_id(old_id).is_err() || check_id(new_id).is_err() {
        return;
    }
    let Ok(dir) = bank_dir(app) else { return };
    let _guard = BANK_IO.lock().unwrap_or_else(|p| p.into_inner());
    let from = dir.join(format!("{}.bin", old_id));
    let to = dir.join(format!("{}.bin", new_id));
    // Смена только регистра (bob -> Bob): на Windows `to.exists()` уже true
    let case_only = old_id.eq_ignore_ascii_case(new_id);
    if from.exists() && (!to.exists() || case_only) {
        let _ = std::fs::rename(&from, &to);
    }
}

// ---------- куки окна ----------

async fn read_cookies(win: &WebviewWindow) -> Result<Vec<Cookie<'static>>, String> {
    let w = win.clone();
    tauri::async_runtime::spawn_blocking(move || w.cookies().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Сохраняет в банк куки окна персонажа. Вызывать, когда вход подтверждён (online).
/// Возвращает число сохранённых кук.
pub async fn save_from_window(app: &AppHandle, char_id: &str, win: &WebviewWindow) -> Result<usize, String> {
    check_id(char_id)?;
    let all = read_cookies(win).await?;
    let kept: Vec<String> = all.iter().filter(|c| in_scope(c)).map(|c| c.to_string()).collect();
    if kept.is_empty() {
        return Err("в профиле нет кук pwonline.ru".into());
    }
    let count = kept.len();
    let rec = Record { v: 1, saved_at: now_secs(), cookies: kept };
    let dir = bank_dir(app)?;
    let id = char_id.to_string();
    blocking(move || write_record(&dir, &id, &rec)).await?;
    Ok(count)
}

/// Записывает куки из банка в окно: сначала удаляет там куки банковских доменов, затем ставит свои.
/// Куки других доменов (VK и т.п.) в окне не трогает. Возвращает (записано, ошибок).
async fn restore_into_window(win: &WebviewWindow, rec: &Record) -> (usize, usize) {
    let cookies: Vec<Cookie<'static>> = rec
        .cookies
        .iter()
        .filter_map(|s| Cookie::parse(s.clone()).ok())
        .filter(|c| in_scope(c))
        .collect();
    let w = win.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Ok(existing) = w.cookies() {
            for c in existing.into_iter().filter(|c| in_scope(c)) {
                let _ = w.delete_cookie(c);
            }
        }
        let (mut ok, mut errors) = (0usize, 0usize);
        for c in cookies {
            if w.set_cookie(c).is_ok() {
                ok += 1;
            } else {
                errors += 1;
            }
        }
        (ok, errors)
    })
    .await
    .unwrap_or((0, 0));
    // set_cookie / delete_cookie отправляют сообщение и не ждут выполнения
    tokio::time::sleep(Duration::from_millis(800)).await;
    result
}

/// Та же проверка входа, что в `auth.rs`: ("online" | "offline", причина).
async fn probe_auth(win: &WebviewWindow, scope: &str) -> (String, Option<String>) {
    if navigate_clean(win, USERCP_URL).await.is_err() {
        return ("offline".into(), Some("navigate_failed".into()));
    }
    match eval_and_wait(win, AUTH_SCRIPT, "#TF_AUTH_V2_", 15, scope).await {
        Some((None, data)) if data.as_str() == Some("online") => ("online".into(), None),
        Some((err, _)) => ("offline".into(), Some(err.unwrap_or_else(|| "unknown".into()))),
        None => ("offline".into(), Some("timeout".into())),
    }
}

// ---------- для пула воркеров ----------

/// Есть ли в банке сессия персонажа (файл существует, без расшифровки).
pub fn has_session(app: &AppHandle, char_id: &str) -> bool {
    if check_id(char_id).is_err() {
        return false;
    }
    bank_dir(app)
        .map(|d| d.join(format!("{}.bin", char_id)).exists())
        .unwrap_or(false)
}

/// Подставляет куки персонажа из банка в окно воркера (куки банковских доменов окна заменяются).
pub async fn restore_into(app: &AppHandle, char_id: &str, win: &WebviewWindow) -> Result<usize, String> {
    check_id(char_id)?;
    let dir = bank_dir(app)?;
    let id = char_id.to_string();
    let rec = blocking(move || read_record(&dir, &id))
        .await?
        .ok_or("В банке нет сессии этого персонажа")?;
    let (ok, errors) = restore_into_window(win, &rec).await;
    if ok == 0 {
        return Err(format!("не удалось записать куки (ошибок: {})", errors));
    }
    Ok(ok)
}

/// Удаляет из окна куки банковских доменов (после задачи воркера).
pub async fn wipe_scope(win: &WebviewWindow) {
    let w = win.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Ok(existing) = w.cookies() {
            for c in existing.into_iter().filter(|c| in_scope(c)) {
                let _ = w.delete_cookie(c);
            }
        }
    })
    .await;
}

// ---------- команды ----------

/// Что лежит в банке: `[{ charId, savedAt (unix, сек), cookies } | { charId, error }]`. Значения кук не показываются.
#[command]
pub async fn bank_status(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = bank_dir(&app)?;
    blocking(move || {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|x| x.to_str()) != Some("bin") {
                continue;
            }
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            match read_record(&dir, &id) {
                Ok(Some(r)) => out.push(serde_json::json!({
                    "charId": id,
                    "savedAt": r.saved_at,
                    "ageMinutes": now_secs().saturating_sub(r.saved_at) / 60,
                    "cookies": r.cookies.len(),
                })),
                Ok(None) => {}
                Err(e) => out.push(serde_json::json!({ "charId": id, "error": e })),
            }
        }
        Ok(out)
    })
    .await
}

/// Удаляет сессию персонажа из банка.
#[command]
pub async fn bank_forget(app: AppHandle, char_id: String) -> Result<(), String> {
    check_id(&char_id)?;
    let dir = bank_dir(&app)?;
    blocking(move || {
        let _guard = BANK_IO.lock().unwrap_or_else(|p| p.into_inner());
        let path = dir.join(format!("{}.bin", char_id));
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

/// Проверка банка: чистый профиль -> входа нет -> куки из банка -> вход есть.
/// Сначала у персонажа должна пройти проверка входа (статус online): тогда сессия окажется в банке.
#[command]
pub async fn bank_verify(app: AppHandle, char_id: String) -> Result<serde_json::Value, String> {
    check_id(&char_id)?;
    let dir = bank_dir(&app)?;
    let id = char_id.clone();
    let rec = blocking(move || read_record(&dir, &id))
        .await?
        .ok_or("В банке нет сессии этого персонажа. Запустите проверку входа (персонаж должен быть online)")?;

    // Чистый профиль: закрываем старое окно пробы и удаляем папку
    let label = window_label(PROBE_KEY);
    if let Some(old) = app.get_webview_window(&label) {
        let _ = old.destroy();
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    let profile = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pw-sync-profiles")
        .join(PROBE_KEY);
    let _ = std::fs::remove_dir_all(&profile);

    let (win, created) = get_or_create_hidden_window(&app, PROBE_KEY, "about:blank").await?;
    let scope = format!("char:{}", PROBE_KEY);

    // Контроль: в чистом профиле входа быть не должно
    let (before, before_reason) = probe_auth(&win, &scope).await;
    let (restored, set_errors) = restore_into_window(&win, &rec).await;
    let (after, after_reason) = probe_auth(&win, &scope).await;
    dispose(&win, created, true);

    let verdict = match (before.as_str(), after.as_str()) {
        ("online", _) => "НЕЯСНО: чистый профиль уже авторизован. Папка _bank_probe не очистилась — удалите её вручную и повторите",
        ("offline", "online") => "ОК: сессия из банка работает",
        (_, _) => "НЕ СРАБОТАЛО: после записи кук из банка вход не появился. Возможно, для входа нужны куки других доменов (см. BANK_DOMAINS)",
    };
    println!("[BANK] verify {}: before={} after={} -> {}", char_id, before, after, verdict);

    Ok(serde_json::json!({
        "verdict": verdict,
        "before": before,
        "beforeReason": before_reason,
        "after": after,
        "afterReason": after_reason,
        "cookiesInBank": rec.cookies.len(),
        "restored": restored,
        "setErrors": set_errors,
        "ageMinutes": now_secs().saturating_sub(rec.saved_at) / 60,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        let bytes = vec![0u8, 1, 15, 16, 255];
        assert_eq!(from_hex(&to_hex(&bytes)), Some(bytes));
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
    }

    #[test]
    fn encrypt_roundtrip_and_tamper() {
        let key = vec![7u8; 32];
        let data = encrypt(&key, b"secret cookies").unwrap();
        assert_eq!(decrypt(&key, &data).unwrap(), b"secret cookies");
        let mut broken = data.clone();
        let last = broken.len() - 1;
        broken[last] ^= 1;
        assert!(decrypt(&key, &broken).is_err());
        assert!(decrypt(&vec![8u8; 32], &data).is_err());
    }

    #[test]
    fn scope_matches_domain_and_subdomains_only() {
        let mk = |d: &'static str| Cookie::build(("a", "b")).domain(d).build();
        assert!(in_scope(&mk("pwonline.ru")));
        assert!(in_scope(&mk(".pwonline.ru")));
        assert!(in_scope(&mk("www.pwonline.ru")));
        assert!(!in_scope(&mk("vkplay.ru")));
        assert!(!in_scope(&mk("notpwonline.ru")));
        assert!(!in_scope(&Cookie::new("a", "b")));
    }

    #[test]
    fn cookie_survives_string_roundtrip() {
        let c = Cookie::build(("bbsessionhash", "abc123")).domain("pwonline.ru").path("/").http_only(true).build();
        let back = Cookie::parse(c.to_string()).unwrap();
        assert_eq!(back.name(), "bbsessionhash");
        assert_eq!(back.value(), "abc123");
        assert_eq!(back.domain(), Some("pwonline.ru"));
        assert_eq!(back.http_only(), Some(true));
    }
}

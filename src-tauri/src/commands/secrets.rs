//! Учётные данные персонажей (email, пароль, телефон) в хранилище ОС:
//! Windows Credential Manager, macOS Keychain, Secret Service (Linux).
//! При отключённом vault контакты могут оставаться в state.json и его копиях.

use std::collections::HashMap;

const SERVICE: &str = crate::profile::VAULT_SERVICE;
// Не относится к пространству имён contacts:<id>: пробная запись не должна
// перезаписать или удалить контакты персонажа с необычным ID.
const PROBE_USER: &str = "vault-availability-probe";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &user(key)).map_err(|e| e.to_string())
}

/// Имя записи, каким его строит `entry` — нужно и для запасной записи в `vault`.
fn user(key: &str) -> String {
    format!("contacts:{}", key)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Проверяет хранилище **чтением**, с повторами: на старте Windows бывает ещё не готова
/// сессия входа, и запись падает с `ERROR_NO_SUCH_LOGON_SESSION` (1312), хотя чтение уже работает.
/// Пробную запись здесь не делаем: писать в хранилище на старте опаснее, чем читать.
fn probe_read_with(
    attempts: u32,
    gap: std::time::Duration,
    mut read: impl FnMut() -> Result<(), keyring::Error>,
) -> Result<u32, String> {
    let attempts = attempts.max(1);
    let mut last = String::new();
    for attempt in 0..attempts {
        match read() {
            // NoEntry — хранилище доступно, просто пробной записи ещё нет
            Ok(()) | Err(keyring::Error::NoEntry) => return Ok(attempt + 1),
            Err(e) => {
                last = e.to_string();
                if attempt + 1 < attempts {
                    std::thread::sleep(gap);
                }
            }
        }
    }
    Err(last)
}

/// Дописывает строку в `vault-diag.log`: следующее срабатывание будет с доказательством.
fn log_diag(line: &str) {
    let Some(dir) = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from) else {
        return;
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join("com.tvinoferma.desktop").join("vault-diag.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "{} {}", stamp, line)
        });
}

/// Доступно ли хранилище ОС (чтение с повторами; запись проверяется при первом сохранении).
#[tauri::command]
pub async fn secrets_available() -> bool {
    blocking(|| {
        let _guard = super::state::lock_state_io()?;
        let probe = keyring::Entry::new(SERVICE, PROBE_USER).map_err(|e| e.to_string())?;
        let started = std::time::Instant::now();
        match probe_read_with(5, std::time::Duration::from_millis(400), || {
            probe.get_password().map(|_| ())
        }) {
            Ok(attempts) => {
                if attempts > 1 {
                    log_diag(&format!(
                        "vault probe ok after {} attempts ({} ms)",
                        attempts,
                        started.elapsed().as_millis()
                    ));
                }
                Ok(true)
            }
            Err(e) => {
                log_diag(&format!(
                    "vault probe failed after {} ms: {}",
                    started.elapsed().as_millis(),
                    e
                ));
                Ok(false)
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// Читает секреты по ключам. Отсутствующие ключи в ответ не попадают.
#[tauri::command]
pub async fn secrets_get_many(keys: Vec<String>) -> Result<HashMap<String, String>, String> {
    blocking(move || {
        let _guard = super::state::lock_state_io()?;
        let mut out = HashMap::new();
        for key in keys {
            match entry(&key)?.get_password() {
                Ok(value) => {
                    out.insert(key, value);
                }
                Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(format!("{}: {}", key, e)),
            }
        }
        Ok(out)
    })
    .await
}

/// Записывает секреты. Пустое значение удаляет запись.
#[tauri::command]
pub async fn secrets_set_many(items: HashMap<String, String>) -> Result<(), String> {
    blocking(move || {
        let _guard = super::state::lock_state_io()?;
        for (key, value) in items {
            let e = entry(&key)?;
            if value.is_empty() {
                match e.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => {}
                    Err(err) => return Err(format!("{}: {}", key, err)),
                }
            } else {
                crate::vault::set_password(&e, SERVICE, &user(&key), &value)
                    .map_err(|err| format!("{}: {}", key, err))?;
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn secrets_delete_many(keys: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let _guard = super::state::lock_state_io()?;
        for key in keys {
            match entry(&key)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(format!("{}: {}", key, e)),
            }
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{probe_read_with, user, PROBE_USER};

    #[test]
    fn availability_probe_is_outside_contact_namespace() {
        assert!(!PROBE_USER.starts_with("contacts:"));
        assert_ne!(user("__probe__"), PROBE_USER);
        assert_ne!(user(PROBE_USER), PROBE_USER);
    }

    #[test]
    fn absent_probe_entry_means_the_store_is_readable() {
        let attempts = probe_read_with(5, std::time::Duration::ZERO, || {
            Err(keyring::Error::NoEntry)
        });
        assert_eq!(
            attempts,
            Ok(1),
            "NoEntry — это доступное хранилище без записи"
        );
    }

    #[test]
    fn not_ready_logon_session_is_retried() {
        let mut calls = 0;
        let attempts = probe_read_with(5, std::time::Duration::ZERO, || {
            calls += 1;
            if calls < 3 {
                Err(keyring::Error::NoStorageAccess("logon is not ready".into()))
            } else {
                Ok(())
            }
        });
        assert_eq!(attempts, Ok(3));
        assert_eq!(calls, 3);
    }

    #[test]
    fn unavailable_store_is_reported_after_the_last_attempt() {
        let mut calls = 0;
        let result = probe_read_with(3, std::time::Duration::ZERO, || {
            calls += 1;
            Err(keyring::Error::NoStorageAccess("logon is not ready".into()))
        });
        assert!(result.is_err());
        assert_eq!(calls, 3);
    }
}

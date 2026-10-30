//! Учётные данные персонажей (email, пароль, телефон) в хранилище ОС:
//! Windows Credential Manager, macOS Keychain, Secret Service (Linux).
//! При отключённом vault контакты могут оставаться в state.json и его копиях.

use std::collections::HashMap;

const SERVICE: &str = "com.tvinoferma.desktop";
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

/// Доступно ли хранилище ОС (пробная запись/чтение/удаление).
#[tauri::command]
pub async fn secrets_available() -> bool {
    blocking(|| {
        let _guard = super::state::lock_state_io()?;
        let probe = keyring::Entry::new(SERVICE, PROBE_USER).map_err(|e| e.to_string())?;
        crate::vault::set_password(&probe, SERVICE, PROBE_USER, "ok")?;
        let ok = probe.get_password().map(|v| v == "ok").unwrap_or(false);
        let _ = probe.delete_credential();
        Ok(ok)
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
    use super::{user, PROBE_USER};

    #[test]
    fn availability_probe_is_outside_contact_namespace() {
        assert!(!PROBE_USER.starts_with("contacts:"));
        assert_ne!(user("__probe__"), PROBE_USER);
        assert_ne!(user(PROBE_USER), PROBE_USER);
    }
}

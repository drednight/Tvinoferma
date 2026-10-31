//! Optional device-local remembering for standalone files. A separate OS-vault
//! namespace: never overwrites legacy keys, OAuth credentials or contacts.
use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.tvinoferma.desktop.cloud.simple-key";
const USER: &str = "current";
const ERROR: &str = "Standalone cloud key unavailable";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyRecord {
    bundle_id: String,
    data_key: String,
}

fn valid_record(raw: &str) -> bool {
    let row = match serde_json::from_str::<KeyRecord>(raw) {
        Ok(row) => row,
        Err(_) => return false,
    };
    row.bundle_id.len() == 36
        && row.bundle_id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
        && row.data_key.len() == 47
        && row.data_key.starts_with("TF1-")
        && row
            .data_key
            .bytes()
            .skip(4)
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, USER).map_err(|_| ERROR.to_owned())
}

pub(super) fn forget() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(ERROR.to_owned()),
    }
}

#[tauri::command]
pub async fn cloud_simple_key_read() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = super::state::lock_state_io()?;
        match entry()?.get_password() {
            Ok(raw) if raw.len() <= 256 && valid_record(&raw) => Ok(Some(raw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            _ => Err(ERROR.to_owned()),
        }
    })
    .await
    .map_err(|_| ERROR.to_owned())?
}

#[tauri::command]
pub async fn cloud_simple_key_remember(payload: String) -> Result<(), String> {
    if payload.len() > 256 || !valid_record(&payload) {
        return Err(ERROR.to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = super::state::lock_state_io()?;
        let target = entry()?;
        #[cfg(windows)]
        crate::vault::set_local_password(SERVICE, USER, &payload).map_err(|_| ERROR.to_owned())?;
        #[cfg(not(windows))]
        crate::vault::set_password(&target, SERVICE, USER, &payload)
            .map_err(|_| ERROR.to_owned())?;
        if target.get_password().map_err(|_| ERROR.to_owned())? != payload {
            return Err(ERROR.to_owned());
        }
        Ok(())
    })
    .await
    .map_err(|_| ERROR.to_owned())?
}

#[tauri::command]
pub async fn cloud_simple_key_forget() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = super::state::lock_state_io()?;
        forget()
    })
    .await
    .map_err(|_| ERROR.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::valid_record;

    #[test]
    fn bounded_separate_master_record() {
        let record = format!(
            r#"{{"bundleId":"7eab1931-650f-4dc7-98bb-f9e903526af4","dataKey":"TF1-{}"}}"#,
            "A".repeat(43)
        );
        assert!(valid_record(&record));
        assert!(!valid_record(&record.replace("TF1-", "key-")));
        assert!(!valid_record(&record.replace("650f", "650Z")));
        assert!(!valid_record(&record.replace("bundleId", "password")));
        assert!(!valid_record(&record.replace('}', r#", "extra":true}"#)));
    }
}

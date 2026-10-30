//! Отключённый IPC журнала внутреннего ключа синхронизации.
//! Только главное окно и Windows Credential Manager, без файлового fallback.
//! Секреты и исходные ошибки нельзя логировать; настоящий UI не вызывает IPC.

use serde::Serialize;
use tauri::AppHandle;

const ERROR: &str =
    "Локальное хранилище ключей недоступно; результат операции может быть неизвестен";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudKeyStateReply {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    slot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
enum Action {
    Read,
    Install {
        slot_id: String,
        record: String,
    },
    CompareExchange {
        slot_id: String,
        expected: String,
        next: String,
    },
    Forget,
}

async fn perform(app: AppHandle, action: Action) -> Result<CloudKeyStateReply, String> {
    tauri::async_runtime::spawn_blocking(move || execute(&app, action))
        .await
        .map_err(|_| ERROR.to_owned())?
}

#[tauri::command]
pub async fn cloud_key_state_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<CloudKeyStateReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(app, Action::Read).await
}

#[tauri::command]
pub async fn cloud_key_state_install(
    window: tauri::WebviewWindow,
    app: AppHandle,
    slot_id: String,
    record: String,
) -> Result<CloudKeyStateReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(app, Action::Install { slot_id, record }).await
}

#[tauri::command]
pub async fn cloud_key_state_compare_exchange(
    window: tauri::WebviewWindow,
    app: AppHandle,
    slot_id: String,
    expected: String,
    next: String,
) -> Result<CloudKeyStateReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(
        app,
        Action::CompareExchange {
            slot_id,
            expected,
            next,
        },
    )
    .await
}

/// Это уничтожает локальную копию ключа, но не удаляет облако. Требуется явное
/// подтверждение после проверки восстановления и резервной копии данных.
#[tauri::command]
pub async fn cloud_key_state_forget(
    window: tauri::WebviewWindow,
    app: AppHandle,
    confirmed: bool,
) -> Result<CloudKeyStateReply, String> {
    if window.label() != "main" || !confirmed {
        return Err(ERROR.into());
    }
    perform(app, Action::Forget).await
}

#[cfg(not(windows))]
fn execute(_app: &AppHandle, _action: Action) -> Result<CloudKeyStateReply, String> {
    Err(ERROR.into())
}

#[cfg(windows)]
mod windows_backend {
    use super::{Action, AppHandle, CloudKeyStateReply, ERROR};
    use crate::cloud_credential_lock::CredentialLock;
    use crate::cloud_credential_store::{CredentialVault, Inspection, Outcome};
    use crate::cloud_key_state;
    use tauri::Manager;

    const SERVICE: &str = "com.tvinoferma.desktop";
    struct NativeVault;
    fn entry(name: &str) -> Result<keyring::Entry, ()> {
        keyring::Entry::new(SERVICE, name).map_err(|_| ())
    }
    impl CredentialVault for NativeVault {
        fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
            match entry(name)?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(()),
            }
        }
        fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
            crate::vault::set_local_password(SERVICE, name, value).map_err(|_| ())
        }
        fn remove(&mut self, name: &str) -> Result<(), ()> {
            match entry(name)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(()),
            }
        }
    }
    fn reply(status: &'static str) -> CloudKeyStateReply {
        CloudKeyStateReply {
            status,
            slot_id: None,
            record: None,
        }
    }
    fn outcome(result: Outcome) -> CloudKeyStateReply {
        match result {
            Outcome::Installed => reply("installed"),
            Outcome::Occupied => reply("occupied"),
            Outcome::Swapped => reply("swapped"),
            Outcome::Mismatch => reply("mismatch"),
            Outcome::Blocked => reply("blocked"),
            Outcome::Forgotten => reply("forgotten"),
        }
    }
    pub(super) fn execute(app: &AppHandle, action: Action) -> Result<CloudKeyStateReply, String> {
        let _state_guard = super::super::state::lock_state_io().map_err(|_| ERROR.to_owned())?;
        let app_dir = app.path().app_data_dir().map_err(|_| ERROR.to_owned())?;
        let lock = CredentialLock::try_acquire(&app_dir).map_err(|_| ERROR.to_owned())?;
        let mut vault = NativeVault;
        let result = match action {
            Action::Read => match cloud_key_state::read(&mut vault) {
                Ok(Inspection::Empty) => Ok(reply("empty")),
                Ok(Inspection::Blocked) => Ok(reply("blocked")),
                Ok(Inspection::Ready { slot_id, record }) => Ok(CloudKeyStateReply {
                    status: "ready",
                    slot_id: Some(slot_id),
                    record: Some(record),
                }),
                Err(_) => Err(ERROR.to_owned()),
            },
            Action::Install { slot_id, record } => {
                cloud_key_state::install(&mut vault, &slot_id, &record)
                    .map(outcome)
                    .map_err(|_| ERROR.to_owned())
            }
            Action::CompareExchange {
                slot_id,
                expected,
                next,
            } => cloud_key_state::compare_exchange(&mut vault, &slot_id, &expected, &next)
                .map(outcome)
                .map_err(|_| ERROR.to_owned()),
            Action::Forget => cloud_key_state::forget(&mut vault)
                .map(outcome)
                .map_err(|_| ERROR.to_owned()),
        };
        lock.verify().map_err(|_| ERROR.to_owned())?;
        result
    }

    // Запускается только при явном разрешении в Windows CI. Все имена уникальны,
    // значения синтетические; записи после теста удаляются. Проверяет backend,
    // но не Tauri UI, сбой питания или безопасность чужого процесса в той же ОС.
    #[cfg(test)]
    mod native_tests {
        use super::*;
        use std::collections::BTreeSet;
        use std::time::{SystemTime, UNIX_EPOCH};

        struct ScopedVault {
            prefix: String,
            written: BTreeSet<String>,
        }
        impl ScopedVault {
            fn new(prefix: &str) -> Self {
                Self {
                    prefix: prefix.into(),
                    written: BTreeSet::new(),
                }
            }
            fn name(&self, name: &str) -> String {
                format!("{}:{name}", self.prefix)
            }
        }
        impl CredentialVault for ScopedVault {
            fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
                NativeVault.read(&self.name(name))
            }
            fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
                let name = self.name(name);
                self.written.insert(name.clone());
                NativeVault.write(&name, value)
            }
            fn remove(&mut self, name: &str) -> Result<(), ()> {
                NativeVault.remove(&self.name(name))
            }
        }
        impl Drop for ScopedVault {
            fn drop(&mut self) {
                for name in &self.written {
                    let _ = NativeVault.remove(name);
                }
            }
        }

        #[test]
        fn credential_manager_roundtrip_with_isolated_synthetic_key_state() {
            if std::env::var_os("TF_RUN_CREDENTIAL_MANAGER_TESTS").as_deref()
                != Some(std::ffi::OsStr::new("1"))
            {
                return;
            }
            const SLOT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
            const REV1: &str = "11234567-89ab-4cde-8f01-23456789abcd";
            const REV2: &str = "21234567-89ab-4cde-8f01-23456789abcd";
            const DATASET: &str = "31234567-89ab-4cde-8f01-23456789abcd";
            const BUNDLE1: &str = "41234567-89ab-4cde-8f01-23456789abcd";
            const BUNDLE2: &str = "51234567-89ab-4cde-8f01-23456789abcd";
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let prefix = format!("tf-isolated-ci-test-{}-{stamp}", std::process::id());
            let mut first = ScopedVault::new(&prefix);
            let mut second = ScopedVault::new(&prefix);
            let key = format!("TF1-{}", "A".repeat(43));
            let record = |revision: &str, bundle: &str, fingerprint: char, encoded: &str| {
                format!(
                "{{\"format\":\"tvinoferma-cloud-key-state\",\"version\":1,\"slotId\":\"{SLOT}\",\"revision\":\"{revision}\",\"datasetId\":\"{DATASET}\",\"bundleId\":\"{bundle}\",\"fingerprint\":\"{}\",\"dataKey\":\"{key}\",\"bundle\":\"{encoded}\"}}",
                fingerprint.to_string().repeat(64)
            )
            };
            let before = record(REV1, BUNDLE1, 'a', "e30");
            let after = record(REV2, BUNDLE2, 'b', "W10");
            assert!(matches!(
                cloud_key_state::read(&mut first),
                Ok(Inspection::Empty)
            ));
            assert_eq!(
                cloud_key_state::install(&mut first, SLOT, &before),
                Ok(Outcome::Installed)
            );
            assert!(
                matches!(cloud_key_state::read(&mut second), Ok(Inspection::Ready { record, .. }) if record == before)
            );
            assert_eq!(
                cloud_key_state::compare_exchange(&mut second, SLOT, &before, &after),
                Ok(Outcome::Swapped)
            );
            assert!(
                matches!(cloud_key_state::read(&mut first), Ok(Inspection::Ready { record, .. }) if record == after)
            );
            assert_eq!(cloud_key_state::forget(&mut second), Ok(Outcome::Forgotten));
            assert!(matches!(
                cloud_key_state::read(&mut first),
                Ok(Inspection::Empty)
            ));
        }
    }
}
#[cfg(windows)]
use windows_backend::execute;

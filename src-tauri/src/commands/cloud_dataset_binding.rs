//! Отключённый локальный IPC pin набора/корня. Только главное окно и Windows.
//! Запись не содержит ключ или токен, но ID аккаунта и папки могут быть личными.

use serde::Serialize;
use tauri::AppHandle;

const ERROR: &str = "Локальная привязка синхронизации недоступна; результат может быть неизвестен";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDatasetBindingReply {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
enum Action {
    Read,
    Install { record: String },
    Forget,
}

async fn perform(
    app: AppHandle,
    provider: String,
    action: Action,
) -> Result<CloudDatasetBindingReply, String> {
    tauri::async_runtime::spawn_blocking(move || execute(&app, &provider, action))
        .await
        .map_err(|_| ERROR.to_owned())?
}

#[tauri::command]
pub async fn cloud_dataset_binding_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
) -> Result<CloudDatasetBindingReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(app, provider, Action::Read).await
}

#[tauri::command]
pub async fn cloud_dataset_binding_install(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    record: String,
    confirmed: bool,
) -> Result<CloudDatasetBindingReply, String> {
    if window.label() != "main" || !confirmed {
        return Err(ERROR.into());
    }
    perform(app, provider, Action::Install { record }).await
}

#[tauri::command]
pub async fn cloud_dataset_binding_forget(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    confirmed: bool,
) -> Result<CloudDatasetBindingReply, String> {
    if window.label() != "main" || !confirmed {
        return Err(ERROR.into());
    }
    perform(app, provider, Action::Forget).await
}

#[cfg(not(windows))]
fn execute(
    _app: &AppHandle,
    _provider: &str,
    _action: Action,
) -> Result<CloudDatasetBindingReply, String> {
    Err(ERROR.into())
}

#[cfg(windows)]
mod windows_backend {
    use super::{Action, AppHandle, CloudDatasetBindingReply, ERROR};
    use crate::cloud_credential_lock::CredentialLock;
    use crate::cloud_credential_store::{CredentialVault, Outcome, Provider};
    use crate::cloud_dataset_binding::{self, DatasetInspection};
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
    fn reply(status: &'static str) -> CloudDatasetBindingReply {
        CloudDatasetBindingReply {
            status,
            record: None,
        }
    }
    fn outcome(value: Outcome) -> CloudDatasetBindingReply {
        match value {
            Outcome::Installed => reply("installed"),
            Outcome::Occupied => reply("occupied"),
            Outcome::Blocked => reply("blocked"),
            Outcome::Forgotten => reply("forgotten"),
            Outcome::Swapped | Outcome::Mismatch => reply("blocked"),
        }
    }
    pub(super) fn execute(
        app: &AppHandle,
        provider: &str,
        action: Action,
    ) -> Result<CloudDatasetBindingReply, String> {
        let provider = match provider {
            "google" => Provider::Google,
            "yandex" => Provider::Yandex,
            _ => return Err(ERROR.into()),
        };
        let _state_guard = super::super::state::lock_state_io().map_err(|_| ERROR.to_owned())?;
        let app_dir = app.path().app_data_dir().map_err(|_| ERROR.to_owned())?;
        let lock = CredentialLock::try_acquire(&app_dir).map_err(|_| ERROR.to_owned())?;
        let mut vault = NativeVault;
        let result = match action {
            Action::Read => match cloud_dataset_binding::read(&mut vault, provider) {
                Ok(DatasetInspection::Empty) => Ok(reply("empty")),
                Ok(DatasetInspection::Blocked) => Ok(reply("blocked")),
                Ok(DatasetInspection::Ready(record)) => Ok(CloudDatasetBindingReply {
                    status: "ready",
                    record: Some(record),
                }),
                Err(_) => Err(ERROR.to_owned()),
            },
            Action::Install { record } => {
                cloud_dataset_binding::install(&mut vault, provider, &record)
                    .map(outcome)
                    .map_err(|_| ERROR.to_owned())
            }
            Action::Forget => cloud_dataset_binding::forget(&mut vault, provider)
                .map(outcome)
                .map_err(|_| ERROR.to_owned()),
        };
        lock.verify().map_err(|_| ERROR.to_owned())?;
        result
    }
}

#[cfg(windows)]
use windows_backend::execute;

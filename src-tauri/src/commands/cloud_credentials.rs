//! Экспериментальный IPC локального журнала OAuth. Пока не подключён к UI или
//! реальным OAuth-токенам. Только главное окно и только Windows; остальные ОС
//! не получают небезопасный fallback. Никаких исходных ошибок или данных в логах.

use serde::Serialize;
use tauri::AppHandle;

const ERROR: &str =
    "Локальное хранилище доступа к облаку недоступно; результат операции может быть неизвестен";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCredentialReply {
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

async fn perform(
    app: AppHandle,
    provider: String,
    action: Action,
) -> Result<CloudCredentialReply, String> {
    tauri::async_runtime::spawn_blocking(move || execute(&app, &provider, action))
        .await
        .map_err(|_| ERROR.to_owned())?
}

#[tauri::command]
pub async fn cloud_credential_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
) -> Result<CloudCredentialReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(app, provider, Action::Read).await
}

#[tauri::command]
pub async fn cloud_credential_install(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    slot_id: String,
    record: String,
) -> Result<CloudCredentialReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(app, provider, Action::Install { slot_id, record }).await
}

#[tauri::command]
pub async fn cloud_credential_compare_exchange(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    slot_id: String,
    expected: String,
    next: String,
) -> Result<CloudCredentialReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(
        app,
        provider,
        Action::CompareExchange {
            slot_id,
            expected,
            next,
        },
    )
    .await
}

/// Только явно подтверждённое локальное забывание. Оно не отзывает OAuth и не
/// удаляет облачный файл. При ошибке забывание могло выполниться частично.
#[tauri::command]
pub async fn cloud_credential_forget(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    confirmed: bool,
) -> Result<CloudCredentialReply, String> {
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
) -> Result<CloudCredentialReply, String> {
    Err(ERROR.into())
}

#[cfg(windows)]
mod windows_backend {
    use super::{Action, AppHandle, CloudCredentialReply, ERROR};
    use crate::cloud_credential_lock::CredentialLock;
    use crate::cloud_credential_service;
    use crate::cloud_credential_store::{self, CredentialVault, Inspection, Outcome, Provider};
    use std::path::Path;
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
            // Только local-machine, без enterprise/roaming записи keyring.
            crate::vault::set_local_password(SERVICE, name, value).map_err(|_| ())
        }

        fn remove(&mut self, name: &str) -> Result<(), ()> {
            match entry(name)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(()),
            }
        }
    }

    fn provider(name: &str) -> Result<Provider, String> {
        match name {
            "google" => Ok(Provider::Google),
            "yandex" => Ok(Provider::Yandex),
            _ => Err(ERROR.into()),
        }
    }

    fn reply(status: &'static str) -> CloudCredentialReply {
        CloudCredentialReply {
            status,
            slot_id: None,
            record: None,
        }
    }

    fn outcome(result: Outcome) -> CloudCredentialReply {
        match result {
            Outcome::Installed => reply("installed"),
            Outcome::Occupied => reply("occupied"),
            Outcome::Swapped => reply("swapped"),
            Outcome::Mismatch => reply("mismatch"),
            Outcome::Blocked => reply("blocked"),
            Outcome::Forgotten => reply("forgotten"),
        }
    }

    pub(super) fn execute(
        app: &AppHandle,
        provider_name: &str,
        action: Action,
    ) -> Result<CloudCredentialReply, String> {
        let provider = provider(provider_name)?;
        // Этот mutex также разделяется с factory reset внутри процесса. Он не
        // заменяет локальный lock для другого экземпляра приложения.
        let _state_guard = super::super::state::lock_state_io().map_err(|_| ERROR.to_owned())?;
        let app_dir = app.path().app_data_dir().map_err(|_| ERROR.to_owned())?;
        let lock = CredentialLock::try_acquire(&app_dir).map_err(|_| ERROR.to_owned())?;
        let mut vault = NativeVault;
        let result = match action {
            Action::Read => match cloud_credential_service::read(&mut vault, provider) {
                Ok(Inspection::Empty) => Ok(reply("empty")),
                Ok(Inspection::Blocked) => Ok(reply("blocked")),
                Ok(Inspection::Ready { slot_id, record }) => Ok(CloudCredentialReply {
                    status: "ready",
                    slot_id: Some(slot_id),
                    record: Some(record),
                }),
                Err(_) => Err(ERROR.to_owned()),
            },
            Action::Install { slot_id, record } => {
                cloud_credential_service::install(&mut vault, provider, &slot_id, &record)
                    .map(outcome)
                    .map_err(|_| ERROR.to_owned())
            }
            Action::CompareExchange {
                slot_id,
                expected,
                next,
            } => cloud_credential_service::compare_exchange(
                &mut vault, provider, &slot_id, &expected, &next,
            )
            .map(outcome)
            .map_err(|_| ERROR.to_owned()),
            Action::Forget => cloud_credential_service::forget(&mut vault, provider)
                .map(outcome)
                .map_err(|_| ERROR.to_owned()),
        };
        // Даже ошибка после записи не означает, что старое содержимое осталось.
        lock.verify().map_err(|_| ERROR.to_owned())?;
        result
    }

    /// Вызывается только из factory_reset под уже удерживаемым state mutex.
    /// Пытаемся очистить обе известные записи, даже если одна недоступна.
    pub(super) fn cleanup_for_reset(app_dir: &Path) -> Result<(), String> {
        let lock = CredentialLock::try_acquire(app_dir).map_err(|_| ERROR.to_owned())?;
        let mut vault = NativeVault;
        let mut failed = false;
        for provider in [Provider::Google, Provider::Yandex] {
            match cloud_credential_store::inspect(&mut vault, provider) {
                Ok(Inspection::Empty) => {}
                Ok(Inspection::Ready { .. } | Inspection::Blocked) => {
                    if cloud_credential_service::forget(&mut vault, provider).is_err() {
                        failed = true;
                    }
                }
                Err(_) => failed = true,
            }
        }
        if lock.verify().is_err() || failed {
            return Err(ERROR.into());
        }
        Ok(())
    }
}

#[cfg(windows)]
use windows_backend::execute;

/// После полного локального сброса облако и выданное OAuth-разрешение остаются.
#[cfg(windows)]
pub(super) fn cleanup_for_reset(app_dir: &std::path::Path) -> Result<(), String> {
    windows_backend::cleanup_for_reset(app_dir)
}

#[cfg(not(windows))]
pub(super) fn cleanup_for_reset(_app_dir: &std::path::Path) -> Result<(), String> {
    Ok(())
}

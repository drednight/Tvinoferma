//! Экспериментальный IPC локального журнала OAuth подключён к первому входу в UI,
//! но настоящие OAuth-токены и сборка Tauri/Windows ещё не испытаны. Только главное
//! окно и Windows; остальные ОС не получают небезопасный fallback. Данные не логировать.

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

/// Только ранее закреплённая локальная привязка; токен наружу не возвращается.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBindingReply {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    slot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_key: Option<String>,
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
    ForgetIfUnbound {
        expected_slot: String,
    },
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

/// Pin + запись должны совпадать; старый неподтверждённый формат блокируется.
#[tauri::command]
pub async fn cloud_credential_binding_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
) -> Result<CloudBindingReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    tauri::async_runtime::spawn_blocking(move || execute_binding(&app, &provider))
        .await
        .map_err(|_| ERROR.to_owned())?
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

/// Безопасное локальное отключение для пользовательского интерфейса. Оно
/// запрещено, если закреплён или повреждён pin набора, и сверяет исходный slot.
/// Отзыв разрешения у провайдера и удаление файлов в облаке не выполняются.
#[tauri::command]
pub async fn cloud_credential_forget_if_unbound(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    expected_slot: String,
    confirmed: bool,
) -> Result<CloudCredentialReply, String> {
    if window.label() != "main" || !confirmed {
        return Err(ERROR.into());
    }
    perform(app, provider, Action::ForgetIfUnbound { expected_slot }).await
}

#[cfg(not(windows))]
fn execute(
    _app: &AppHandle,
    _provider: &str,
    _action: Action,
) -> Result<CloudCredentialReply, String> {
    Err(ERROR.into())
}

/// Только сетевой исполнитель refresh: одна попытка начинает работу после
/// контрольного чтения pending под тем же lock, что обычные операции с vault.
pub(super) async fn claim_google_refresh(
    app: AppHandle,
    slot_id: String,
    expected: String,
    pending: String,
    client_id: String,
    refresh_token: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        execute_google_refresh_claim(
            &app,
            &slot_id,
            &expected,
            &pending,
            &client_id,
            &refresh_token,
        )
    })
    .await
    .map_err(|_| ERROR.to_owned())?
}

#[cfg(not(windows))]
fn execute_binding(_app: &AppHandle, _provider: &str) -> Result<CloudBindingReply, String> {
    Err(ERROR.into())
}

#[cfg(not(windows))]
fn execute_google_refresh_claim(
    _app: &AppHandle,
    _slot_id: &str,
    _expected: &str,
    _pending: &str,
    _client_id: &str,
    _refresh_token: &str,
) -> Result<(), String> {
    Err(ERROR.into())
}

#[cfg(windows)]
mod windows_backend {
    use super::{Action, AppHandle, CloudBindingReply, CloudCredentialReply, ERROR};
    use crate::cloud_credential_binding::{self, Pair};
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
            Action::Read => match cloud_credential_binding::read(&mut vault, provider) {
                Ok(Pair::Empty) => Ok(reply("empty")),
                Ok(Pair::Blocked) => Ok(reply("blocked")),
                Ok(Pair::Ready { binding, record }) => Ok(CloudCredentialReply {
                    status: "ready",
                    slot_id: Some(binding.slot_id),
                    record: Some(record),
                }),
                Err(_) => Err(ERROR.to_owned()),
            },
            Action::Install { slot_id, record } => {
                crate::cloud_dataset_binding::install_credential_if_unbound(
                    &mut vault, provider, &slot_id, &record,
                )
                .map(outcome)
                .map_err(|_| ERROR.to_owned())
            }
            Action::CompareExchange {
                slot_id,
                expected,
                next,
            } => cloud_credential_binding::compare_exchange(
                &mut vault, provider, &slot_id, &expected, &next,
            )
            .map(outcome)
            .map_err(|_| ERROR.to_owned()),
            Action::Forget => cloud_credential_binding::forget(&mut vault, provider)
                .map(outcome)
                .map_err(|_| ERROR.to_owned()),
            Action::ForgetIfUnbound { expected_slot } => {
                crate::cloud_dataset_binding::forget_credential_if_unbound(
                    &mut vault,
                    provider,
                    &expected_slot,
                )
                .map(outcome)
                .map_err(|_| ERROR.to_owned())
            }
        };
        // Даже ошибка после записи не означает, что старое содержимое осталось.
        lock.verify().map_err(|_| ERROR.to_owned())?;
        result
    }

    pub(super) fn execute_binding(
        app: &AppHandle,
        provider_name: &str,
    ) -> Result<CloudBindingReply, String> {
        let provider = provider(provider_name)?;
        let _state_guard = super::super::state::lock_state_io().map_err(|_| ERROR.to_owned())?;
        let app_dir = app.path().app_data_dir().map_err(|_| ERROR.to_owned())?;
        let lock = CredentialLock::try_acquire(&app_dir).map_err(|_| ERROR.to_owned())?;
        let mut vault = NativeVault;
        let result = match cloud_credential_binding::read(&mut vault, provider)
            .map_err(|_| ERROR.to_owned())?
        {
            Pair::Empty => CloudBindingReply {
                status: "empty",
                slot_id: None,
                client_id: None,
                account_key: None,
            },
            Pair::Blocked => CloudBindingReply {
                status: "blocked",
                slot_id: None,
                client_id: None,
                account_key: None,
            },
            Pair::Ready { binding, .. } if binding.pending => CloudBindingReply {
                status: "pending",
                slot_id: None,
                client_id: None,
                account_key: None,
            },
            Pair::Ready { binding, .. } => CloudBindingReply {
                status: "ready",
                slot_id: Some(binding.slot_id),
                client_id: Some(binding.client_id),
                account_key: Some(binding.account_key),
            },
        };
        lock.verify().map_err(|_| ERROR.to_owned())?;
        Ok(result)
    }

    pub(super) fn execute_google_refresh_claim(
        app: &AppHandle,
        slot_id: &str,
        expected: &str,
        pending: &str,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<(), String> {
        let _state_guard = super::super::state::lock_state_io().map_err(|_| ERROR.to_owned())?;
        let app_dir = app.path().app_data_dir().map_err(|_| ERROR.to_owned())?;
        let lock = CredentialLock::try_acquire(&app_dir).map_err(|_| ERROR.to_owned())?;
        let mut vault = NativeVault;
        let claimed = cloud_credential_binding::claim_google_refresh(
            &mut vault,
            slot_id,
            expected,
            pending,
            client_id,
            refresh_token,
        )
        .map_err(|_| ERROR.to_owned())?;
        lock.verify().map_err(|_| ERROR.to_owned())?;
        if claimed {
            Ok(())
        } else {
            Err(ERROR.into())
        }
    }

    /// Вызывается только из factory_reset под уже удерживаемым state mutex.
    /// Пытаемся очистить обе известные записи, даже если одна недоступна.
    pub(super) fn cleanup_for_reset(app_dir: &Path) -> Result<(), String> {
        let lock = CredentialLock::try_acquire(app_dir).map_err(|_| ERROR.to_owned())?;
        let mut vault = NativeVault;
        let mut failed = false;
        for provider in [Provider::Google, Provider::Yandex] {
            if crate::cloud_dataset_binding::forget(&mut vault, provider).is_err() {
                failed = true;
            }
            match cloud_credential_binding::read(&mut vault, provider) {
                Ok(Pair::Empty) => {}
                Ok(Pair::Ready { .. } | Pair::Blocked) => {
                    if cloud_credential_binding::forget(&mut vault, provider).is_err() {
                        failed = true;
                    }
                }
                Err(_) => failed = true,
            }
        }
        match cloud_credential_store::inspect(&mut vault, Provider::KeyState) {
            Ok(Inspection::Empty) => {}
            Ok(Inspection::Ready { .. } | Inspection::Blocked) => {
                if cloud_credential_service::forget(&mut vault, Provider::KeyState).is_err() {
                    failed = true;
                }
            }
            Err(_) => failed = true,
        }
        if lock.verify().is_err() || failed {
            return Err(ERROR.into());
        }
        Ok(())
    }
    // Только opt-in Windows CI. Имена уникальны, данные синтетические;
    // cleanup best-effort. Это не тест Tauri IPC, сбоя питания или OAuth.
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
                let result = NativeVault.read(&self.name(name));
                if result.is_err() {
                    eprintln!("Synthetic Credential Manager test: read failed");
                }
                result
            }
            fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
                let name = self.name(name);
                self.written.insert(name.clone());
                // Только тестовые значения. Печатаем номер ошибки Windows, но не
                // имя, содержимое или исходное сообщение ОС/хранилища.
                match crate::vault::set_local_password(SERVICE, &name, value) {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        let code = error
                            .split("Windows вернула код ")
                            .nth(1)
                            .and_then(|part| part.split(|c: char| !c.is_ascii_digit()).next())
                            .filter(|part| !part.is_empty())
                            .unwrap_or("unclassified");
                        eprintln!("Synthetic Credential Manager test: write failed, code={code}");
                        Err(())
                    }
                }
            }
            fn remove(&mut self, name: &str) -> Result<(), ()> {
                let result = NativeVault.remove(&self.name(name));
                if result.is_err() {
                    eprintln!("Synthetic Credential Manager test: remove failed");
                }
                result
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
        fn credential_manager_binding_and_one_time_claim_with_synthetic_values() {
            if std::env::var_os("TF_RUN_CREDENTIAL_MANAGER_TESTS").as_deref()
                != Some(std::ffi::OsStr::new("1"))
            {
                return;
            }
            const SLOT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
            const REV1: &str = "11234567-89ab-4cde-8f01-23456789abcd";
            const REV2: &str = "21234567-89ab-4cde-8f01-23456789abcd";
            const ATTEMPT: &str = "31234567-89ab-4cde-8f01-23456789abcd";
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let prefix = format!("tf-binding-ci-{}-{stamp}", std::process::id());
            let mut first = ScopedVault::new(&prefix);
            let mut second = ScopedVault::new(&prefix);
            let client = format!("{}.apps.googleusercontent.com", "a".repeat(200));
            let account = "b".repeat(256);
            let token = "fake".repeat(1500);
            let record = |revision: &str, phase: &str, attempt: &str, refresh: &str| {
                format!(
                "{{\"format\":\"tvinoferma-google-oauth-credential\",\"version\":1,\"slotId\":\"{SLOT}\",\"clientId\":\"{client}\",\"accountKey\":\"{account}\",\"revision\":\"{revision}\",\"phase\":\"{phase}\",\"attemptId\":{attempt},\"refreshToken\":{refresh},\"refreshExpiresAt\":null}}"
            )
            };
            let before = record(REV1, "ready", "null", &format!("\"{token}\""));
            let pending = record(REV2, "pending", &format!("\"{ATTEMPT}\""), "null");
            assert!(matches!(
                cloud_credential_binding::read(&mut first, Provider::Google),
                Ok(Pair::Empty)
            ));
            assert_eq!(
                crate::cloud_dataset_binding::install_credential_if_unbound(
                    &mut first,
                    Provider::Google,
                    SLOT,
                    &before
                ),
                Ok(Outcome::Installed)
            );
            assert_eq!(
                crate::cloud_dataset_binding::forget_credential_if_unbound(
                    &mut first,
                    Provider::Google,
                    REV1
                ),
                Ok(Outcome::Mismatch)
            );
            assert!(
                matches!(cloud_credential_binding::read(&mut second, Provider::Google),
                Ok(Pair::Ready { binding, record }) if binding.slot_id == SLOT && binding.client_id == client && binding.account_key == account && record == before)
            );
            const KEY_SLOT: &str = "41234567-89ab-4cde-8f01-23456789abcd";
            const KEY_REV: &str = "51234567-89ab-4cde-8f01-23456789abcd";
            const DATASET: &str = "61234567-89ab-4cde-8f01-23456789abcd";
            const BUNDLE: &str = "71234567-89ab-4cde-8f01-23456789abcd";
            const ROOT: &str = "81234567-89ab-4cde-8f01-23456789abcd";
            let key = format!("{{\"format\":\"tvinoferma-cloud-key-state\",\"version\":1,\"slotId\":\"{KEY_SLOT}\",\"revision\":\"{KEY_REV}\",\"datasetId\":\"{DATASET}\",\"bundleId\":\"{BUNDLE}\",\"fingerprint\":\"{}\",\"dataKey\":\"TF1-{}\",\"bundle\":\"e30\"}}", "a".repeat(64), "A".repeat(43));
            assert_eq!(
                crate::cloud_key_state::install(&mut first, KEY_SLOT, &key),
                Ok(Outcome::Installed)
            );
            let dataset_pin = format!("tf-dataset-binding-v1|google|ready|{SLOT}|{KEY_SLOT}|{DATASET}|{BUNDLE}|{}|{ROOT}|{}|{}", "a".repeat(64), "b".repeat(64), "F".repeat(256));
            assert_eq!(
                crate::cloud_dataset_binding::install(&mut first, Provider::Google, &dataset_pin),
                Ok(Outcome::Installed)
            );
            assert!(
                matches!(crate::cloud_dataset_binding::read(&mut second, Provider::Google), Ok(crate::cloud_dataset_binding::DatasetInspection::Ready(value)) if value == dataset_pin)
            );
            assert_eq!(
                crate::cloud_dataset_binding::install_credential_if_unbound(
                    &mut second,
                    Provider::Google,
                    SLOT,
                    &before
                ),
                Ok(Outcome::Blocked)
            );
            assert_eq!(
                crate::cloud_dataset_binding::forget_credential_if_unbound(
                    &mut second,
                    Provider::Google,
                    SLOT
                ),
                Ok(Outcome::Blocked)
            );
            let pin = second
                .read("cloud-account-binding-v1:google:pin")
                .unwrap()
                .unwrap();
            assert!(!pin.contains(&token));
            assert_eq!(
                cloud_credential_binding::claim_google_refresh(
                    &mut second,
                    SLOT,
                    &before,
                    &pending,
                    &client,
                    &token
                ),
                Ok(true)
            );
            assert_eq!(
                cloud_credential_binding::claim_google_refresh(
                    &mut first, SLOT, &before, &pending, &client, &token
                ),
                Ok(false)
            );
            assert!(
                matches!(cloud_credential_binding::read(&mut first, Provider::Google), Ok(Pair::Ready { binding, record }) if binding.pending && record == pending)
            );
            assert!(matches!(
                crate::cloud_dataset_binding::read(&mut first, Provider::Google),
                Ok(crate::cloud_dataset_binding::DatasetInspection::Blocked)
            ));
            assert_eq!(
                crate::cloud_dataset_binding::forget(&mut second, Provider::Google),
                Ok(Outcome::Forgotten)
            );
            assert_eq!(
                crate::cloud_key_state::forget(&mut second),
                Ok(Outcome::Forgotten)
            );
            assert_eq!(
                cloud_credential_binding::forget(&mut second, Provider::Google),
                Ok(Outcome::Forgotten)
            );
            assert!(matches!(
                cloud_credential_binding::read(&mut first, Provider::Google),
                Ok(Pair::Empty)
            ));
            let yandex = format!("{{\"format\":\"tvinoferma-yandex-oauth-access\",\"version\":1,\"slotId\":\"{SLOT}\",\"clientId\":\"0123456789abcdef\",\"accountKey\":\"synthetic-account\",\"revision\":\"{REV1}\",\"accessToken\":\"synthetic-token\",\"expiresAt\":1800000000000}}");
            assert_eq!(
                crate::cloud_dataset_binding::install_credential_if_unbound(
                    &mut first,
                    Provider::Yandex,
                    SLOT,
                    &yandex
                ),
                Ok(Outcome::Installed)
            );
            assert_eq!(
                crate::cloud_dataset_binding::forget_credential_if_unbound(
                    &mut second,
                    Provider::Yandex,
                    SLOT
                ),
                Ok(Outcome::Forgotten)
            );
            assert!(matches!(
                cloud_credential_binding::read(&mut first, Provider::Yandex),
                Ok(Pair::Empty)
            ));
        }
    }
}

#[cfg(windows)]
use windows_backend::{execute, execute_binding, execute_google_refresh_claim};

/// После полного локального сброса облако и выданное OAuth-разрешение остаются.
#[cfg(windows)]
pub(super) fn cleanup_for_reset(app_dir: &std::path::Path) -> Result<(), String> {
    windows_backend::cleanup_for_reset(app_dir)
}

#[cfg(not(windows))]
pub(super) fn cleanup_for_reset(_app_dir: &std::path::Path) -> Result<(), String> {
    Ok(())
}

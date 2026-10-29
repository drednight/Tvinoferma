//! Экспериментальный Windows backend журнала исходящих облачных версий.
//! Реальному UI ещё не подключён. Только главное окно, фиксированные имена,
//! зашифрованный конверт и отдельная OS-отметка; исходные ошибки не выдаются.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const ERROR: &str =
    "Локальный журнал облачной отправки недоступен; результат записи может быть неизвестен";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct OutboxWrite {
    slot_id: String,
    dataset_id: String,
    device_id: String,
    revision_id: String,
    record: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct OutboxSwap {
    slot_id: String,
    dataset_id: String,
    device_id: String,
    revision_id: String,
    record: String,
    expected_revision_id: String,
    expected_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxReply {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    slot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dataset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
enum Action {
    Read,
    Install(OutboxWrite),
    CompareExchange(OutboxSwap),
}

async fn perform(app: AppHandle, provider: String, action: Action) -> Result<OutboxReply, String> {
    tauri::async_runtime::spawn_blocking(move || execute(&app, &provider, action))
        .await
        .map_err(|_| ERROR.to_owned())?
}

#[tauri::command]
pub async fn cloud_outbox_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
) -> Result<OutboxReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(app, provider, Action::Read).await
}

#[tauri::command]
pub async fn cloud_outbox_install(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    args: OutboxWrite,
) -> Result<OutboxReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(app, provider, Action::Install(args)).await
}

#[tauri::command]
pub async fn cloud_outbox_compare_exchange(
    window: tauri::WebviewWindow,
    app: AppHandle,
    provider: String,
    args: OutboxSwap,
) -> Result<OutboxReply, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    perform(app, provider, Action::CompareExchange(args)).await
}

#[cfg(not(windows))]
fn execute(_app: &AppHandle, _provider: &str, _action: Action) -> Result<OutboxReply, String> {
    Err(ERROR.into())
}

#[cfg(windows)]
mod windows_backend {
    use super::{Action, AppHandle, OutboxReply, ERROR};
    use crate::cloud_credential_lock::CredentialLock;
    use crate::cloud_credential_store::CredentialVault;
    use crate::cloud_outbox_store::{
        self, Expected, Inspection, NewRecord, OutboxFile, Outcome, Receipt, Target,
        MAX_OUTBOX_RECORD_BYTES,
    };
    use std::ffi::c_void;
    use std::fs::{self, File, OpenOptions};
    use std::io::Read;
    use std::mem::MaybeUninit;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use tauri::Manager;

    const SERVICE: &str = "com.tvinoferma.desktop";
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct FileInformation {
        attributes: u32,
        creation: FileTime,
        access: FileTime,
        write: FileTime,
        volume_serial: u32,
        size_high: u32,
        size_low: u32,
        link_count: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut c_void, info: *mut FileInformation) -> i32;
    }

    // Проверка открытого handle не устраняет подмену родительского каталога или
    // некооперативную гонку после закрытия handle; она отклоняет reparse/hard link.
    fn safe_file(file: &File) -> Result<(), ()> {
        let metadata = file.metadata().map_err(|_| ())?;
        if !metadata.is_file()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || metadata.len() > MAX_OUTBOX_RECORD_BYTES as u64
        {
            return Err(());
        }
        let mut info = MaybeUninit::<FileInformation>::uninit();
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
        if ok == 0 {
            return Err(());
        }
        let info = unsafe { info.assume_init() };
        if info.link_count != 1 || info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(());
        }
        Ok(())
    }

    struct NativeFile {
        path: PathBuf,
    }
    impl OutboxFile for NativeFile {
        fn read(&mut self) -> Result<Option<String>, ()> {
            let metadata = match fs::symlink_metadata(&self.path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(()),
            };
            if !metadata.file_type().is_file()
                || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || metadata.len() > MAX_OUTBOX_RECORD_BYTES as u64
            {
                return Err(());
            }
            let file = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&self.path)
                .map_err(|_| ())?;
            safe_file(&file)?;
            let mut bytes = Vec::new();
            file.take(MAX_OUTBOX_RECORD_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| ())?;
            if bytes.len() > MAX_OUTBOX_RECORD_BYTES || !bytes.is_ascii() {
                return Err(());
            }
            String::from_utf8(bytes).map(Some).map_err(|_| ())
        }

        fn publish(&mut self, expected: Option<&str>, next: &str) -> Result<(), ()> {
            if self.read()?.as_deref() != expected {
                return Err(());
            }
            match expected {
                None => super::super::state_files::create_new_state(&self.path, next.as_bytes()),
                Some(old) => super::super::state_files::replace_state_if_unchanged(
                    &self.path,
                    next.as_bytes(),
                    old.as_bytes(),
                ),
            }
            .map_err(|_| ())?;
            if self.read()?.as_deref() != Some(next) {
                return Err(());
            }
            Ok(())
        }

        fn remove_for_reset(&mut self) -> Result<(), ()> {
            if self.read()?.is_some() {
                fs::remove_file(&self.path).map_err(|_| ())?;
            }
            if self.read()?.is_none() {
                Ok(())
            } else {
                Err(())
            }
        }
    }

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

    fn target(provider: &str) -> Result<(Target, &'static str), String> {
        match provider {
            "google" => Ok((Target::Google, "cloud-outbox-v1-google.tfqo")),
            "yandex" => Ok((Target::Yandex, "cloud-outbox-v1-yandex.tfqo")),
            _ => Err(ERROR.into()),
        }
    }
    fn reply(status: &'static str) -> OutboxReply {
        OutboxReply {
            status,
            slot_id: None,
            dataset_id: None,
            device_id: None,
            revision_id: None,
            sha256: None,
            record: None,
        }
    }
    fn ready(value: Receipt) -> OutboxReply {
        OutboxReply {
            status: "ready",
            slot_id: Some(value.slot_id),
            dataset_id: Some(value.dataset_id),
            device_id: Some(value.device_id),
            revision_id: Some(value.revision_id),
            sha256: Some(value.sha256),
            record: Some(value.record),
        }
    }
    fn outcome(value: Outcome) -> OutboxReply {
        match value {
            Outcome::Installed => reply("installed"),
            Outcome::Occupied => reply("occupied"),
            Outcome::Swapped => reply("swapped"),
            Outcome::Mismatch => reply("mismatch"),
            Outcome::Blocked => reply("blocked"),
        }
    }

    /// Только при явно подтверждённом полном сбросе. Неподходящие файлы не
    /// удаляются; ошибка может означать частично выполненную очистку.
    pub(super) fn cleanup_for_reset(app_dir: &Path) -> Result<(), String> {
        let lock = CredentialLock::try_acquire(app_dir).map_err(|_| ERROR.to_owned())?;
        let mut vault = NativeVault;
        let mut failed = false;
        for provider in ["google", "yandex"] {
            let (target, name) = target(provider)?;
            let mut file = NativeFile {
                path: app_dir.join(name),
            };
            if cloud_outbox_store::remove_for_reset(&mut vault, &mut file, target).is_err() {
                failed = true;
            }
        }
        if lock.verify().is_err() || failed {
            return Err(ERROR.into());
        }
        Ok(())
    }

    pub(super) fn execute(
        app: &AppHandle,
        provider: &str,
        action: Action,
    ) -> Result<OutboxReply, String> {
        let (target, file_name) = target(provider)?;
        let _state_guard = super::super::state::lock_state_io().map_err(|_| ERROR.to_owned())?;
        let app_dir = app.path().app_data_dir().map_err(|_| ERROR.to_owned())?;
        let lock = CredentialLock::try_acquire(&app_dir).map_err(|_| ERROR.to_owned())?;
        let mut vault = NativeVault;
        let mut file = NativeFile {
            path: app_dir.join(file_name),
        };
        let result = match action {
            Action::Read => match cloud_outbox_store::inspect(&mut vault, &mut file, target) {
                Ok(Inspection::Empty) => Ok(reply("empty")),
                Ok(Inspection::Pending) => Ok(reply("pending")),
                Ok(Inspection::Blocked) => Ok(reply("blocked")),
                Ok(Inspection::Ready(value)) => Ok(ready(value)),
                Err(_) => Err(ERROR.to_owned()),
            },
            Action::Install(args) => {
                let next = NewRecord {
                    slot_id: &args.slot_id,
                    dataset_id: &args.dataset_id,
                    device_id: &args.device_id,
                    revision_id: &args.revision_id,
                    record: &args.record,
                };
                cloud_outbox_store::install(&mut vault, &mut file, target, &next)
                    .map(outcome)
                    .map_err(|_| ERROR.to_owned())
            }
            Action::CompareExchange(args) => {
                let next = NewRecord {
                    slot_id: &args.slot_id,
                    dataset_id: &args.dataset_id,
                    device_id: &args.device_id,
                    revision_id: &args.revision_id,
                    record: &args.record,
                };
                let expected = Expected {
                    revision_id: &args.expected_revision_id,
                    sha256: &args.expected_sha256,
                };
                cloud_outbox_store::compare_exchange(
                    &mut vault, &mut file, target, &expected, &next,
                )
                .map(outcome)
                .map_err(|_| ERROR.to_owned())
            }
        };
        lock.verify().map_err(|_| ERROR.to_owned())?;
        result
    }
}

#[cfg(windows)]
use windows_backend::execute;

#[cfg(windows)]
pub(super) fn cleanup_for_reset(app_dir: &std::path::Path) -> Result<(), String> {
    windows_backend::cleanup_for_reset(app_dir)
}

#[cfg(not(windows))]
pub(super) fn cleanup_for_reset(_app_dir: &std::path::Path) -> Result<(), String> {
    Ok(())
}

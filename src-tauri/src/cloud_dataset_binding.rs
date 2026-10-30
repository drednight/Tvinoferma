//! Экспериментальный локальный pin набора и корневой версии для одного диска.
//!
//! Привязка не содержит токен или dataKey и должна храниться только в локальном
//! vault под общим межпроцессным lock. Она связывает slot учётной записи и ключа,
//! dataset, отпечатки ключа/корня и Google folder ID. Сама установка НЕ доказывает
//! независимость кода, соответствие папки корню, согласие человека, HMAC ключа или
//! сохранность backup: всё это обязан проверить вызывающий код до установки.
//! Один credential/pin в одном vault не защищает от согласованного отката, удаления,
//! другого процесса, подмены UI или потери питания. Отсутствие не означает первый запуск.

use crate::cloud_credential_binding::{self, Pair};
use crate::cloud_credential_store::{valid_uuid, CredentialVault, Outcome, Provider, StoreError};
use crate::cloud_key_state;

const PREFIX: &str = "tf-dataset-binding-v1";
const PENDING: &str = "tf-dataset-binding-v1|pending";
const MAX_PIN: usize = 1024;

// Не Debug: идентификаторы и папка могут быть личными.
struct Binding<'a> {
    account_slot: &'a str,
    key_slot: &'a str,
    dataset: &'a str,
    bundle: &'a str,
    key_hash: &'a str,
    root: &'a str,
    root_hash: &'a str,
    folder: &'a str,
}

pub(crate) enum DatasetInspection {
    Empty,
    Blocked,
    Ready(String),
}

fn name(provider: Provider) -> Result<String, StoreError> {
    let suffix = match provider {
        Provider::Google => "google",
        Provider::Yandex => "yandex",
        Provider::KeyState => return Err(StoreError::Invalid),
    };
    Ok(format!("cloud-dataset-binding-v1:{suffix}:pin"))
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse(provider: Provider, raw: &str) -> Option<Binding<'_>> {
    if raw.len() > MAX_PIN || !raw.is_ascii() {
        return None;
    }
    let mut fields = raw.split('|');
    let head = fields.next()?;
    let provider_text = fields.next()?;
    let state = fields.next()?;
    let binding = Binding {
        account_slot: fields.next()?,
        key_slot: fields.next()?,
        dataset: fields.next()?,
        bundle: fields.next()?,
        key_hash: fields.next()?,
        root: fields.next()?,
        root_hash: fields.next()?,
        folder: fields.next()?,
    };
    let expected = match provider {
        Provider::Google => "google",
        Provider::Yandex => "yandex",
        Provider::KeyState => return None,
    };
    let folder_ok = match provider {
        Provider::Google => {
            !binding.folder.is_empty()
                && binding.folder.len() <= 256
                && binding
                    .folder
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        }
        Provider::Yandex => binding.folder == "-",
        Provider::KeyState => false,
    };
    if head != PREFIX
        || provider_text != expected
        || state != "ready"
        || fields.next().is_some()
        || !folder_ok
        || ![
            binding.account_slot,
            binding.key_slot,
            binding.dataset,
            binding.bundle,
            binding.root,
        ]
        .iter()
        .all(|value| valid_uuid(value))
        || !hash(binding.key_hash)
        || !hash(binding.root_hash)
    {
        return None;
    }
    Some(binding)
}

fn get(vault: &mut impl CredentialVault, name: &str) -> Result<Option<String>, StoreError> {
    vault.read(name).map_err(|_| StoreError::Unavailable)
}

fn put(vault: &mut impl CredentialVault, name: &str, value: &str) -> Result<(), StoreError> {
    vault
        .write(name, value)
        .map_err(|_| StoreError::Unavailable)?;
    if get(vault, name)?.as_deref() != Some(value) {
        return Err(StoreError::Unavailable);
    }
    Ok(())
}

fn matches_local(
    vault: &mut impl CredentialVault,
    provider: Provider,
    binding: &Binding<'_>,
) -> Result<bool, StoreError> {
    let account = match cloud_credential_binding::read(vault, provider)? {
        Pair::Ready { binding, .. } if !binding.pending => binding,
        Pair::Empty | Pair::Blocked | Pair::Ready { .. } => return Ok(false),
    };
    let Some(key) = cloud_key_state::public_binding(vault)? else {
        return Ok(false);
    };
    Ok(account.slot_id == binding.account_slot
        && key.slot_id == binding.key_slot
        && key.dataset_id == binding.dataset
        && key.bundle_id == binding.bundle
        && key.fingerprint == binding.key_hash)
}

/// Возвращает только pin без секрета и только при совпадении обеих локальных записей.
pub(crate) fn read(
    vault: &mut impl CredentialVault,
    provider: Provider,
) -> Result<DatasetInspection, StoreError> {
    let Some(raw) = get(vault, &name(provider)?)? else {
        return Ok(DatasetInspection::Empty);
    };
    let Some(binding) = parse(provider, &raw) else {
        return Ok(DatasetInspection::Blocked);
    };
    if !matches_local(vault, provider, &binding)? {
        return Ok(DatasetInspection::Blocked);
    }
    Ok(DatasetInspection::Ready(raw))
}

/// Вызывающий код обязан подтвердить независимый корень/папку и проверку ключа.
/// Существующий pin не заменяем; неизвестный результат требует ручного восстановления.
pub(crate) fn install(
    vault: &mut impl CredentialVault,
    provider: Provider,
    raw: &str,
) -> Result<Outcome, StoreError> {
    let Some(binding) = parse(provider, raw) else {
        return Err(StoreError::Invalid);
    };
    let target = name(provider)?;
    if get(vault, &target)?.is_some() {
        return match read(vault, provider)? {
            DatasetInspection::Ready(_) => Ok(Outcome::Occupied),
            DatasetInspection::Blocked | DatasetInspection::Empty => Ok(Outcome::Blocked),
        };
    }
    if !matches_local(vault, provider, &binding)? {
        return Ok(Outcome::Blocked);
    }
    put(vault, &target, PENDING)?;
    put(vault, &target, raw)?;
    match read(vault, provider)? {
        DatasetInspection::Ready(value) if value == raw => Ok(Outcome::Installed),
        _ => Err(StoreError::Unavailable),
    }
}

/// Установка первого OAuth-доступа не должна создавать новый slot поверх
/// сохранившейся или незавершённой привязки набора. Проверка и установка должны
/// выполняться под тем же межпроцессным lock. Отсутствие pin не означает, что
/// отсутствуют старые данные в облаке.
pub(crate) fn install_credential_if_unbound(
    vault: &mut impl CredentialVault,
    provider: Provider,
    slot_id: &str,
    record: &str,
) -> Result<Outcome, StoreError> {
    match read(vault, provider)? {
        DatasetInspection::Empty => {
            cloud_credential_binding::install(vault, provider, slot_id, record)
        }
        DatasetInspection::Blocked | DatasetInspection::Ready(_) => Ok(Outcome::Blocked),
    }
}

/// Забрать OAuth-доступ только когда pin набора действительно отсутствует и
/// сохранённый slot всё ещё совпадает с тем, который пользователь проверял.
/// Вызывающий удерживает тот же межпроцессный lock для всех этих проверок и
/// удаления. Отсутствие pin не доказывает, что в облаке нет старых данных.
/// Никакие ключи, облачные файлы или разрешения у провайдера здесь не удаляются.
/// При ошибке во время удаления результат может быть частичным или неизвестным.
pub(crate) fn forget_credential_if_unbound(
    vault: &mut impl CredentialVault,
    provider: Provider,
    expected_slot: &str,
) -> Result<Outcome, StoreError> {
    if !valid_uuid(expected_slot) {
        return Err(StoreError::Invalid);
    }
    match read(vault, provider)? {
        DatasetInspection::Empty => {}
        DatasetInspection::Blocked | DatasetInspection::Ready(_) => return Ok(Outcome::Blocked),
    }
    match cloud_credential_binding::read(vault, provider)? {
        Pair::Ready { binding, .. } if !binding.pending && binding.slot_id == expected_slot => {}
        Pair::Empty | Pair::Ready { .. } => return Ok(Outcome::Mismatch),
        Pair::Blocked => return Ok(Outcome::Blocked),
    }
    cloud_credential_binding::forget(vault, provider)
}

/// Удаляет только локальный pin, в том числе повреждённый. Облако не затрагивается.
pub(crate) fn forget(
    vault: &mut impl CredentialVault,
    provider: Provider,
) -> Result<Outcome, StoreError> {
    let target = name(provider)?;
    if get(vault, &target)?.is_none() {
        return Ok(Outcome::Forgotten);
    }
    put(vault, &target, PENDING)?;
    vault.remove(&target).map_err(|_| StoreError::Unavailable)?;
    if get(vault, &target)?.is_some() {
        return Err(StoreError::Unavailable);
    }
    Ok(Outcome::Forgotten)
}

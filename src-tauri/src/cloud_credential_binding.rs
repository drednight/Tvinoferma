//! Дополнительный локальный pin привязки аккаунта OAuth. Все операции требуют
//! общего межпроцессного lock и отдельного подтверждения пользователя до install.
//! Сбой после pending блокирует автоматическое использование и новую установку.
//! Это не защита от согласованного отката, другого процесса того же пользователя,
//! подмены UI, сбоев питания или отозванного доступа. Включает приватный account ID;
//! запись, промежуточные значения и исходные ошибки нельзя журналировать.

use crate::cloud_credential_records::{self, PublicBinding};
use crate::cloud_credential_service;
use crate::cloud_credential_store::{CredentialVault, Inspection, Outcome, Provider, StoreError};

const PENDING: &str = "tf-cloud-account-binding-v1|pending";
const READY: &str = "tf-cloud-account-binding-v1|ready";

fn key(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::Google => Some("cloud-account-binding-v1:google:pin"),
        Provider::Yandex => Some("cloud-account-binding-v1:yandex:pin"),
        Provider::KeyState => None,
    }
}

fn pin(binding: &PublicBinding) -> String {
    // Все поля проверены парсером OAuth и не могут содержать разделитель `|`.
    format!(
        "{READY}|{}|{}|{}",
        binding.slot_id, binding.client_id, binding.account_key
    )
}

fn get(vault: &mut impl CredentialVault, name: &str) -> Result<Option<String>, StoreError> {
    vault.read(name).map_err(|_| StoreError::Unavailable)
}

fn set_checked(
    vault: &mut impl CredentialVault,
    name: &str,
    value: &str,
) -> Result<(), StoreError> {
    vault
        .write(name, value)
        .map_err(|_| StoreError::Unavailable)?;
    if get(vault, name)?.as_deref() != Some(value) {
        return Err(StoreError::Unavailable);
    }
    Ok(())
}

// Намеренно без Debug: запись содержит токен, binding содержит личный account ID.
pub(crate) enum Pair {
    Empty,
    Blocked,
    Ready {
        binding: PublicBinding,
        record: String,
    },
}

/// Сверяет две независимые записи ОС. Отсутствие обеих — только наблюдение,
/// не доказательство первого подключения. Частичные и старые unpinned записи
/// не мигрируются автоматически.
pub(crate) fn read(
    vault: &mut impl CredentialVault,
    provider: Provider,
) -> Result<Pair, StoreError> {
    let name = key(provider).ok_or(StoreError::Invalid)?;
    let stored_pin = get(vault, name)?;
    let stored = cloud_credential_service::read(vault, provider)?;
    match (stored_pin, stored) {
        (None, Inspection::Empty) => Ok(Pair::Empty),
        (Some(observed), Inspection::Ready { slot_id, record }) => {
            let Some(binding) = cloud_credential_records::public_binding(provider, &record) else {
                return Ok(Pair::Blocked);
            };
            if slot_id != binding.slot_id || observed != pin(&binding) {
                return Ok(Pair::Blocked);
            }
            Ok(Pair::Ready { binding, record })
        }
        _ => Ok(Pair::Blocked),
    }
}

/// Устанавливает pin и токен только в действительно наблюдаемые пустые ячейки.
/// Любая ошибка после начала записи может оставить pending или полный результат;
/// её нельзя автоматически повторять. Caller подтверждает аккаунт и первый вход.
pub(crate) fn install(
    vault: &mut impl CredentialVault,
    provider: Provider,
    slot_id: &str,
    record: &str,
) -> Result<Outcome, StoreError> {
    let name = key(provider).ok_or(StoreError::Invalid)?;
    if !cloud_credential_records::valid_initial(provider, slot_id, record) {
        return Err(StoreError::Invalid);
    }
    let binding =
        cloud_credential_records::public_binding(provider, record).ok_or(StoreError::Invalid)?;
    match read(vault, provider)? {
        Pair::Empty => {}
        Pair::Ready { .. } => return Ok(Outcome::Occupied),
        Pair::Blocked => return Ok(Outcome::Blocked),
    }
    set_checked(vault, name, PENDING)?;
    match cloud_credential_service::install(vault, provider, slot_id, record)? {
        Outcome::Installed => {}
        _ => return Err(StoreError::Unavailable),
    }
    match cloud_credential_service::read(vault, provider)? {
        Inspection::Ready {
            slot_id: actual,
            record: stored,
        } if actual == slot_id && stored == record => {}
        _ => return Err(StoreError::Unavailable),
    }
    set_checked(vault, name, &pin(&binding))?;
    match read(vault, provider)? {
        Pair::Ready {
            binding: actual,
            record: stored,
        } if actual.slot_id == slot_id && stored == record => Ok(Outcome::Installed),
        _ => Err(StoreError::Unavailable),
    }
}

/// При ротации pin не меняется; повреждение одной части блокирует обе.
pub(crate) fn compare_exchange(
    vault: &mut impl CredentialVault,
    provider: Provider,
    slot_id: &str,
    expected: &str,
    next: &str,
) -> Result<Outcome, StoreError> {
    if !cloud_credential_records::valid_transition(provider, slot_id, expected, next) {
        return Err(StoreError::Invalid);
    }
    match read(vault, provider)? {
        Pair::Empty => return Ok(Outcome::Mismatch),
        Pair::Blocked => return Ok(Outcome::Blocked),
        Pair::Ready { binding, record } if binding.slot_id == slot_id && record == expected => {}
        Pair::Ready { .. } => return Ok(Outcome::Mismatch),
    }
    match cloud_credential_service::compare_exchange(vault, provider, slot_id, expected, next)? {
        Outcome::Swapped => match read(vault, provider)? {
            Pair::Ready { binding, record } if binding.slot_id == slot_id && record == next => {
                Ok(Outcome::Swapped)
            }
            _ => Err(StoreError::Unavailable),
        },
        other => Ok(other),
    }
}

/// Одноразовый claim до POST. Контрольный pin проверяется до и после перехода.
pub(crate) fn claim_google_refresh(
    vault: &mut impl CredentialVault,
    slot_id: &str,
    expected: &str,
    pending: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<bool, StoreError> {
    match read(vault, Provider::Google)? {
        Pair::Ready { binding, record } if binding.slot_id == slot_id && record == expected => {}
        Pair::Empty | Pair::Blocked | Pair::Ready { .. } => return Ok(false),
    }
    if !cloud_credential_service::claim_google_refresh(
        vault,
        slot_id,
        expected,
        pending,
        client_id,
        refresh_token,
    )? {
        return Ok(false);
    }
    match read(vault, Provider::Google)? {
        Pair::Ready { binding, record } if binding.slot_id == slot_id && record == pending => {
            Ok(true)
        }
        _ => Err(StoreError::Unavailable),
    }
}

/// Только явное забывание или полный сброс. Файлы облака и разрешение OAuth не
/// удаляются. Ошибка может означать частичное удаление; pin остаётся pending.
pub(crate) fn forget(
    vault: &mut impl CredentialVault,
    provider: Provider,
) -> Result<Outcome, StoreError> {
    let name = key(provider).ok_or(StoreError::Invalid)?;
    set_checked(vault, name, PENDING)?;
    if cloud_credential_service::forget(vault, provider)? != Outcome::Forgotten {
        return Err(StoreError::Unavailable);
    }
    vault.remove(name).map_err(|_| StoreError::Unavailable)?;
    if get(vault, name)?.is_some() {
        return Err(StoreError::Unavailable);
    }
    match read(vault, provider)? {
        Pair::Empty => Ok(Outcome::Forgotten),
        _ => Err(StoreError::Unavailable),
    }
}

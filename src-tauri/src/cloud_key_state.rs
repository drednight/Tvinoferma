//! Отключённая модель локального журнала ключа синхронизации.
//!
//! В журнале находятся внутренний ключ данных и зашифрованный набор с двумя
//! обёртками. Их можно хранить только в защищённом хранилище ОС под единым lock.
//! Этот слой проверяет каноническую форму и неизменность привязок, но НЕ проверяет
//! криптографическое доказательство, пароль, запасной ключ или согласие человека.
//! Вызывающий JS обязан проверять доказательство и отпечаток как до записи, так и
//! при каждом чтении; запись с неверным доказательством нельзя использовать.
//! Согласованный откат head/частей, отмена доступа и сбой питания не обнаруживаются.

use crate::cloud_credential_store::{
    self, valid_uuid, CredentialVault, Inspection, Outcome, Provider, StoreError, MAX_RECORD_BYTES,
};

const TARGET: Provider = Provider::KeyState;
const PREFIX: &str = "{\"format\":\"tvinoferma-cloud-key-state\",\"version\":1,\"slotId\":\"";
const MAX_BUNDLE: usize = 12_000;

// Без Debug: внутри находится ключ данных.
struct Binding<'a> {
    slot_id: &'a str,
    revision: &'a str,
    dataset_id: &'a str,
    bundle_id: &'a str,
    fingerprint: &'a str,
    data_key: &'a str,
    bundle: &'a str,
}

fn base64url_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

fn canonical_base64url(value: &str) -> bool {
    if value.is_empty() || !value.bytes().all(|byte| base64url_value(byte).is_some()) {
        return false;
    }
    let last = base64url_value(value.as_bytes()[value.len() - 1]).unwrap_or(0);
    match value.len() % 4 {
        0 => true,
        2 => last & 15 == 0,
        3 => last & 3 == 0,
        _ => false,
    }
}

fn parse(raw: &str) -> Option<Binding<'_>> {
    if raw.len() > MAX_RECORD_BYTES || !raw.is_ascii() {
        return None;
    }
    let body = raw.strip_prefix(PREFIX)?;
    let (slot_id, body) = body.split_once("\",\"revision\":\"")?;
    let (revision, body) = body.split_once("\",\"datasetId\":\"")?;
    let (dataset_id, body) = body.split_once("\",\"bundleId\":\"")?;
    let (bundle_id, body) = body.split_once("\",\"fingerprint\":\"")?;
    let (fingerprint, body) = body.split_once("\",\"dataKey\":\"")?;
    let (data_key, body) = body.split_once("\",\"bundle\":\"")?;
    let bundle = body.strip_suffix("\"}")?;
    if ![slot_id, revision, dataset_id, bundle_id]
        .iter()
        .all(|value| valid_uuid(value))
        || slot_id == revision
        || slot_id == dataset_id
        || slot_id == bundle_id
        || revision == dataset_id
        || revision == bundle_id
        || dataset_id == bundle_id
        || fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !data_key.starts_with("TF1-")
        || data_key.len() != 47
        || !canonical_base64url(&data_key[4..])
        || bundle.len() > MAX_BUNDLE
        || !canonical_base64url(bundle)
    {
        return None;
    }
    Some(Binding {
        slot_id,
        revision,
        dataset_id,
        bundle_id,
        fingerprint,
        data_key,
        bundle,
    })
}

/// Вызывается под тем же межпроцессным lock, что и OAuth-журнал и reset.
/// Ready содержит секрет: не выводить в сообщения и журналы.
pub(crate) fn read(vault: &mut impl CredentialVault) -> Result<Inspection, StoreError> {
    match cloud_credential_store::inspect(vault, TARGET)? {
        Inspection::Ready { slot_id, record } => {
            if parse(&record).is_some_and(|binding| binding.slot_id == slot_id) {
                Ok(Inspection::Ready { slot_id, record })
            } else {
                Ok(Inspection::Blocked)
            }
        }
        other => Ok(other),
    }
}

pub(crate) fn install(
    vault: &mut impl CredentialVault,
    slot_id: &str,
    record: &str,
) -> Result<Outcome, StoreError> {
    if parse(record).is_none_or(|binding| binding.slot_id != slot_id) {
        return Err(StoreError::Invalid);
    }
    match read(vault)? {
        Inspection::Empty => cloud_credential_store::install(vault, TARGET, slot_id, record),
        Inspection::Ready { .. } => Ok(Outcome::Occupied),
        Inspection::Blocked => Ok(Outcome::Blocked),
    }
}

/// Меняем только обёртки существующего ключа и новую ревизию. Это не отзывает
/// старые облачные файлы и не подтверждает, что новая обёртка сохранена на диске.
pub(crate) fn compare_exchange(
    vault: &mut impl CredentialVault,
    slot_id: &str,
    expected: &str,
    next: &str,
) -> Result<Outcome, StoreError> {
    let (Some(old), Some(new)) = (parse(expected), parse(next)) else {
        return Err(StoreError::Invalid);
    };
    if old.slot_id != slot_id
        || new.slot_id != slot_id
        || old.dataset_id != new.dataset_id
        || old.data_key != new.data_key
        || old.revision == new.revision
        || old.bundle_id == new.bundle_id
        || old.fingerprint == new.fingerprint
        || old.bundle == new.bundle
    {
        return Err(StoreError::Invalid);
    }
    match read(vault)? {
        Inspection::Empty => Ok(Outcome::Mismatch),
        Inspection::Blocked => Ok(Outcome::Blocked),
        Inspection::Ready { .. } => {
            cloud_credential_store::compare_exchange(vault, TARGET, slot_id, expected, next)
        }
    }
}

/// Локальное удаление допустимо только после отдельного подтверждения; оно не
/// удаляет старое облако. Результат ошибки может означать частичное удаление.
pub(crate) fn forget(vault: &mut impl CredentialVault) -> Result<Outcome, StoreError> {
    cloud_credential_store::forget(vault, TARGET)
}

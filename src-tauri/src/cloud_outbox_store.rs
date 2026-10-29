//! Двухфазный журнал зашифрованной очереди: pin в хранилище ОС, тело в файле.
//! Вызывающий обязан удерживать общий межпроцессный lock на всей операции. После
//! ошибки запись могла произойти; автоматического восстановления pending нет.
//! Согласованный откат/удаление обоих хранилищ и сбой питания здесь не обнаруживаются.

use crate::cloud_credential_store::{valid_uuid, CredentialVault};
use crate::cloud_disk_transport::canonical_envelope;
use sha2::{Digest, Sha256};

pub(crate) const MAX_OUTBOX_RECORD_BYTES: usize = 24 * 1024 * 1024;
const PENDING: &str = "tf-cloud-outbox-v1|pending";
const READY: &str = "tf-cloud-outbox-v1|ready";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    Google,
    Yandex,
}

impl Target {
    pub(crate) fn head(self) -> &'static str {
        match self {
            Self::Google => "cloud-outbox-v1:google:head",
            Self::Yandex => "cloud-outbox-v1:yandex:head",
        }
    }
}

/// Все ошибки записи/замены могут иметь неизвестный исход. Реализация обязана
/// ограничивать размер и не заменять файл при несовпадении ожидаемых байтов.
pub(crate) trait OutboxFile {
    fn read(&mut self) -> Result<Option<String>, ()>;
    fn publish(&mut self, expected: Option<&str>, next: &str) -> Result<(), ()>;
    /// Только при подтверждённом сбросе: небезопасный файл должен оставаться на месте.
    fn remove_for_reset(&mut self) -> Result<(), ()>;
}

// Намеренно без Debug: record содержит зашифрованный снимок и идентификаторы.
pub(crate) struct Receipt {
    pub(crate) slot_id: String,
    pub(crate) dataset_id: String,
    pub(crate) device_id: String,
    pub(crate) revision_id: String,
    pub(crate) sha256: String,
    pub(crate) record: String,
}

// Empty — лишь текущее наблюдение, не доказательство первого подключения.
pub(crate) enum Inspection {
    Empty,
    Pending,
    Blocked,
    Ready(Receipt),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Installed,
    Occupied,
    Swapped,
    Mismatch,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StoreError {
    Invalid,
    Unavailable,
}

pub(crate) struct NewRecord<'a> {
    pub(crate) slot_id: &'a str,
    pub(crate) dataset_id: &'a str,
    pub(crate) device_id: &'a str,
    pub(crate) revision_id: &'a str,
    pub(crate) record: &'a str,
}

pub(crate) struct Expected<'a> {
    pub(crate) revision_id: &'a str,
    pub(crate) sha256: &'a str,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn ids(slot: &str, dataset: &str, device: &str, revision: &str) -> bool {
    let values = [slot, dataset, device, revision];
    values.iter().all(|value| valid_uuid(value))
        && values
            .iter()
            .enumerate()
            .all(|(index, value)| !values[index + 1..].contains(value))
}

fn valid_new(value: &NewRecord<'_>) -> bool {
    ids(
        value.slot_id,
        value.dataset_id,
        value.device_id,
        value.revision_id,
    ) && value.record.len() <= MAX_OUTBOX_RECORD_BYTES
        && canonical_envelope(value.record, value.dataset_id, value.revision_id)
}

fn digest(value: &str) -> String {
    use std::fmt::Write;
    let bytes = Sha256::digest(value.as_bytes());
    let mut text = String::with_capacity(64);
    for byte in bytes {
        let _ = write!(&mut text, "{byte:02x}");
    }
    text
}

fn ready_head(value: &NewRecord<'_>) -> String {
    format!(
        "{READY}|{}|{}|{}|{}|{}|{}",
        value.slot_id,
        value.dataset_id,
        value.device_id,
        value.revision_id,
        value.record.len(),
        digest(value.record)
    )
}

struct Head<'a> {
    slot_id: &'a str,
    dataset_id: &'a str,
    device_id: &'a str,
    revision_id: &'a str,
    length: usize,
    sha256: &'a str,
}

fn parse_head(value: &str) -> Option<Head<'_>> {
    let tail = value.strip_prefix(READY)?.strip_prefix('|')?;
    let mut fields = tail.split('|');
    let slot_id = fields.next()?;
    let dataset_id = fields.next()?;
    let device_id = fields.next()?;
    let revision_id = fields.next()?;
    let length_text = fields.next()?;
    let sha256 = fields.next()?;
    if fields.next().is_some()
        || !ids(slot_id, dataset_id, device_id, revision_id)
        || length_text.is_empty()
        || length_text.len() > 8
        || (length_text.len() > 1 && length_text.starts_with('0'))
        || !length_text.bytes().all(|byte| byte.is_ascii_digit())
        || !valid_hash(sha256)
    {
        return None;
    }
    let length = length_text.parse::<usize>().ok()?;
    if length == 0 || length > MAX_OUTBOX_RECORD_BYTES {
        return None;
    }
    Some(Head {
        slot_id,
        dataset_id,
        device_id,
        revision_id,
        length,
        sha256,
    })
}

fn vault_read(vault: &mut impl CredentialVault, name: &str) -> Result<Option<String>, StoreError> {
    vault.read(name).map_err(|_| StoreError::Unavailable)
}

fn write_head(vault: &mut impl CredentialVault, name: &str, value: &str) -> Result<(), StoreError> {
    vault
        .write(name, value)
        .map_err(|_| StoreError::Unavailable)?;
    if vault_read(vault, name)?.as_deref() != Some(value) {
        return Err(StoreError::Unavailable);
    }
    Ok(())
}

/// Возвращает тело только при совпадении с независимой отметкой и форматом.
/// Это не удостоверяет настоящий AES-GCM, fsync или отсутствие отката обеих копий.
pub(crate) fn inspect(
    vault: &mut impl CredentialVault,
    file: &mut impl OutboxFile,
    target: Target,
) -> Result<Inspection, StoreError> {
    let head = vault_read(vault, target.head())?;
    if head.as_deref() == Some(PENDING) {
        return Ok(Inspection::Pending);
    }
    let body = file.read().map_err(|_| StoreError::Unavailable)?;
    let Some(head) = head else {
        return Ok(if body.is_none() {
            Inspection::Empty
        } else {
            Inspection::Blocked
        });
    };
    let Some(head) = parse_head(&head) else {
        return Ok(Inspection::Blocked);
    };
    let Some(body) = body else {
        return Ok(Inspection::Blocked);
    };
    if body.len() != head.length
        || digest(&body) != head.sha256
        || !canonical_envelope(&body, head.dataset_id, head.revision_id)
    {
        return Ok(Inspection::Blocked);
    }
    Ok(Inspection::Ready(Receipt {
        slot_id: head.slot_id.to_owned(),
        dataset_id: head.dataset_id.to_owned(),
        device_id: head.device_id.to_owned(),
        revision_id: head.revision_id.to_owned(),
        sha256: head.sha256.to_owned(),
        record: body,
    }))
}

fn commit(
    vault: &mut impl CredentialVault,
    file: &mut impl OutboxFile,
    target: Target,
    previous: Option<&str>,
    next: &NewRecord<'_>,
) -> Result<(), StoreError> {
    // Пока head=pending, другой процесс не использует старую или новую очередь.
    write_head(vault, target.head(), PENDING)?;
    file.publish(previous, next.record)
        .map_err(|_| StoreError::Unavailable)?;
    if file.read().map_err(|_| StoreError::Unavailable)?.as_deref() != Some(next.record) {
        return Err(StoreError::Unavailable);
    }
    write_head(vault, target.head(), &ready_head(next))?;
    match inspect(vault, file, target)? {
        Inspection::Ready(receipt)
            if receipt.slot_id == next.slot_id
                && receipt.dataset_id == next.dataset_id
                && receipt.device_id == next.device_id
                && receipt.revision_id == next.revision_id
                && receipt.record == next.record =>
        {
            Ok(())
        }
        _ => Err(StoreError::Unavailable),
    }
}

/// Только при полном сбросе под общим lock. Пытаемся удалить обе известные
/// части даже при ошибке одной из них; частичный исход нельзя считать успехом.
/// Облачные файлы и разрешения провайдера этот метод не затрагивает.
pub(crate) fn remove_for_reset(
    vault: &mut impl CredentialVault,
    file: &mut impl OutboxFile,
    target: Target,
) -> Result<(), StoreError> {
    let file_ok = file.remove_for_reset().is_ok() && matches!(file.read(), Ok(None));
    let head_ok =
        vault.remove(target.head()).is_ok() && matches!(vault.read(target.head()), Ok(None));
    if file_ok && head_ok {
        Ok(())
    } else {
        Err(StoreError::Unavailable)
    }
}

/// Только по отдельному подтверждению первого создания. Не заменяет старые данные.
pub(crate) fn install(
    vault: &mut impl CredentialVault,
    file: &mut impl OutboxFile,
    target: Target,
    next: &NewRecord<'_>,
) -> Result<Outcome, StoreError> {
    if !valid_new(next) {
        return Err(StoreError::Invalid);
    }
    match inspect(vault, file, target)? {
        Inspection::Empty => {}
        Inspection::Ready(_) => return Ok(Outcome::Occupied),
        Inspection::Pending | Inspection::Blocked => return Ok(Outcome::Blocked),
    }
    commit(vault, file, target, None, next)?;
    Ok(Outcome::Installed)
}

/// CAS по slot, набору, устройству, ревизии и хешу под удерживаемым lock.
/// Сама запись намерения ещё не разрешает повторить неизвестный сетевой запрос.
pub(crate) fn compare_exchange(
    vault: &mut impl CredentialVault,
    file: &mut impl OutboxFile,
    target: Target,
    expected: &Expected<'_>,
    next: &NewRecord<'_>,
) -> Result<Outcome, StoreError> {
    if !valid_new(next)
        || !valid_uuid(expected.revision_id)
        || !valid_hash(expected.sha256)
        || expected.revision_id == next.revision_id
    {
        return Err(StoreError::Invalid);
    }
    let previous = match inspect(vault, file, target)? {
        Inspection::Empty => return Ok(Outcome::Mismatch),
        Inspection::Pending | Inspection::Blocked => return Ok(Outcome::Blocked),
        Inspection::Ready(receipt) => receipt,
    };
    if previous.slot_id != next.slot_id
        || previous.dataset_id != next.dataset_id
        || previous.device_id != next.device_id
        || previous.revision_id != expected.revision_id
        || previous.sha256 != expected.sha256
    {
        return Ok(Outcome::Mismatch);
    }
    commit(vault, file, target, Some(&previous.record), next)?;
    Ok(Outcome::Swapped)
}

//! Старт одного нового локального набора под общим lock хранилища облака.
//! Это не проверяет шифрование, подтверждение человеком или наличие старого облака.
//! Два процесса, использующие этот протокол, не могут начать разные корни на двух
//! дисках: до единственной установки проверяются ОБЕ очереди и ОБЕ привязки.
//! Файловая система и согласованный откат всё ещё не являются транзакцией.

use crate::cloud_credential_binding::{self, Pair};
use crate::cloud_credential_store::{valid_uuid, CredentialVault, Provider};
use crate::cloud_dataset_binding::{self, DatasetInspection};
use crate::cloud_key_state;
use crate::cloud_outbox_store::{
    self, Inspection, NewRecord, OutboxFile, Outcome, StoreError, Target,
};

pub(crate) struct LinkSource<'a> {
    pub(crate) binding: &'a str,
    pub(crate) revision_id: &'a str,
    pub(crate) sha256: &'a str,
}

pub(crate) struct Guard<'a> {
    pub(crate) account_slot: &'a str,
    pub(crate) key_slot: &'a str,
    pub(crate) bundle_id: &'a str,
    pub(crate) fingerprint: &'a str,
    pub(crate) link_source: Option<LinkSource<'a>>,
}

/// Caller удерживает тот же межпроцессный lock для обеих проверок и установки.
/// При любой неизвестной ошибке автоматический повтор или новый корень запрещены.
pub(crate) fn install(
    vault: &mut impl CredentialVault,
    file: &mut impl OutboxFile,
    other_file: &mut impl OutboxFile,
    target: Target,
    next: &NewRecord<'_>,
    guard: &Guard<'_>,
) -> Result<Outcome, StoreError> {
    if ![guard.account_slot, guard.key_slot, guard.bundle_id]
        .iter()
        .all(|value| valid_uuid(value))
        || guard.fingerprint.len() != 64
        || !guard
            .fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(StoreError::Invalid);
    }
    let (provider, other_provider, other_target) = match target {
        Target::Google => (Provider::Google, Provider::Yandex, Target::Yandex),
        Target::Yandex => (Provider::Yandex, Provider::Google, Target::Google),
    };
    let account_matches = matches!(
        cloud_credential_binding::read(vault, provider).map_err(|_| StoreError::Unavailable)?,
        Pair::Ready { binding, .. } if !binding.pending && binding.slot_id == guard.account_slot
    );
    let key_matches = cloud_key_state::public_binding(vault)
        .map_err(|_| StoreError::Unavailable)?
        .is_some_and(|key| {
            key.slot_id == guard.key_slot
                && key.dataset_id == next.dataset_id
                && key.bundle_id == guard.bundle_id
                && key.fingerprint == guard.fingerprint
        });
    if !account_matches || !key_matches {
        return Ok(Outcome::Blocked);
    }
    if !matches!(
        cloud_dataset_binding::read(vault, provider).map_err(|_| StoreError::Unavailable)?,
        DatasetInspection::Empty
    ) {
        return Ok(Outcome::Blocked);
    }
    let source_pin =
        cloud_dataset_binding::read(vault, other_provider).map_err(|_| StoreError::Unavailable)?;
    let source_queue = cloud_outbox_store::inspect(vault, other_file, other_target)?;
    match &guard.link_source {
        None => {
            if !matches!(source_pin, DatasetInspection::Empty)
                || !matches!(source_queue, Inspection::Empty)
            {
                return Ok(Outcome::Blocked);
            }
        }
        Some(source) => {
            // Explicitly link the SAME dataset, never start an independent root.
            // JS must also authenticate the source queue/root and key proof.
            if source.binding.len() > 1024
                || !source.binding.is_ascii()
                || !valid_uuid(source.revision_id)
                || source.sha256.len() != 64
                || !source
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !matches!(source_pin, DatasetInspection::Ready(ref raw) if raw == source.binding)
                || !matches!(source_queue, Inspection::Ready(ref receipt)
                    if receipt.dataset_id == next.dataset_id
                        && receipt.revision_id == source.revision_id
                        && receipt.sha256 == source.sha256)
            {
                return Ok(Outcome::Blocked);
            }
        }
    }
    cloud_outbox_store::install(vault, file, target, next)
}

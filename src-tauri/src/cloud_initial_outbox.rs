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

pub(crate) struct Guard<'a> {
    pub(crate) account_slot: &'a str,
    pub(crate) key_slot: &'a str,
    pub(crate) bundle_id: &'a str,
    pub(crate) fingerprint: &'a str,
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
    for value in [provider, other_provider] {
        if !matches!(
            cloud_dataset_binding::read(vault, value).map_err(|_| StoreError::Unavailable)?,
            DatasetInspection::Empty
        ) {
            return Ok(Outcome::Blocked);
        }
    }
    if !matches!(
        cloud_outbox_store::inspect(vault, other_file, other_target)?,
        Inspection::Empty
    ) {
        return Ok(Outcome::Blocked);
    }
    cloud_outbox_store::install(vault, file, target, next)
}

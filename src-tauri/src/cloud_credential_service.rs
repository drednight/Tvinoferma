//! Узкая связка журнала с каноническими OAuth-записями. Сама по себе не
//! предоставляет хранилище ОС, lock, UI, сетевой обмен или подтверждение аккаунта.

use crate::cloud_credential_records;
use crate::cloud_credential_store::{
    self, CredentialVault, Inspection, Outcome, Provider, StoreError,
};

/// Даже совпадающие части и hash не дают наружу синтаксически повреждённую или
/// перепривязанную запись. Результат Ready содержит токен: не логировать.
pub(crate) fn read(
    vault: &mut impl CredentialVault,
    provider: Provider,
) -> Result<Inspection, StoreError> {
    match cloud_credential_store::inspect(vault, provider)? {
        Inspection::Ready { slot_id, record } => {
            if cloud_credential_records::parse(provider, &record)
                .is_some_and(|value| value.slot_id == slot_id)
            {
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
    provider: Provider,
    slot_id: &str,
    record: &str,
) -> Result<Outcome, StoreError> {
    if !cloud_credential_records::valid_initial(provider, slot_id, record) {
        return Err(StoreError::Invalid);
    }
    match read(vault, provider)? {
        Inspection::Empty => {}
        Inspection::Ready { .. } => return Ok(Outcome::Occupied),
        Inspection::Blocked => return Ok(Outcome::Blocked),
    }
    // Нижний слой под тем же lock повторно проверяет, что запись отсутствует.
    cloud_credential_store::install(vault, provider, slot_id, record)
}

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
        Inspection::Empty => return Ok(Outcome::Mismatch),
        Inspection::Blocked => return Ok(Outcome::Blocked),
        Inspection::Ready { .. } => {}
    }
    cloud_credential_store::compare_exchange(vault, provider, slot_id, expected, next)
}

pub(crate) fn forget(
    vault: &mut impl CredentialVault,
    provider: Provider,
) -> Result<Outcome, StoreError> {
    cloud_credential_store::forget(vault, provider)
}

/// Одноразовый claim конкретной формы. Вызывающий обязан удерживать общий
/// межпроцессный lock до конца CAS и контрольного чтения. `false` запрещает сеть;
/// ошибка тоже запрещает сеть, но запись могла успеть измениться. Возвращаемое
/// значение не доказывает защиту от отката или устойчивость при потере питания.
pub(crate) fn claim_google_refresh(
    vault: &mut impl CredentialVault,
    slot_id: &str,
    expected: &str,
    pending: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<bool, StoreError> {
    if !cloud_credential_records::valid_google_refresh_claim(
        slot_id,
        expected,
        pending,
        client_id,
        refresh_token,
    ) {
        return Err(StoreError::Invalid);
    }
    match compare_exchange(vault, Provider::Google, slot_id, expected, pending)? {
        Outcome::Mismatch | Outcome::Blocked => Ok(false),
        Outcome::Swapped => match read(vault, Provider::Google)? {
            Inspection::Ready {
                slot_id: actual,
                record,
            } if actual == slot_id && record == pending => Ok(true),
            _ => Err(StoreError::Unavailable),
        },
        _ => Err(StoreError::Unavailable),
    }
}

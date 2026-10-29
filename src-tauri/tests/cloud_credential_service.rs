//! Интеграция валидатора и журнала на поддельном хранилище, без Tauri/Windows.

#[path = "../src/cloud_credential_records.rs"]
mod cloud_credential_records;
#[path = "../src/cloud_credential_service.rs"]
mod cloud_credential_service;
#[path = "../src/cloud_credential_store.rs"]
mod cloud_credential_store;

use cloud_credential_store::{CredentialVault, Inspection, Outcome, Provider, StoreError};
use std::collections::BTreeMap;

const SLOT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
const REV1: &str = "11234567-89ab-4cde-8f01-23456789abcd";
const REV2: &str = "21234567-89ab-4cde-8f01-23456789abcd";
const REV3: &str = "31234567-89ab-4cde-8f01-23456789abcd";
const ATTEMPT: &str = "41234567-89ab-4cde-8f01-23456789abcd";

#[derive(Default)]
struct Vault(BTreeMap<String, String>);
impl CredentialVault for Vault {
    fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
        Ok(self.0.get(name).cloned())
    }
    fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
        self.0.insert(name.to_owned(), value.to_owned());
        Ok(())
    }
    fn remove(&mut self, name: &str) -> Result<(), ()> {
        self.0.remove(name);
        Ok(())
    }
}

fn google(revision: &str, phase: &str, attempt: &str, token: &str) -> String {
    format!(
        "{{\"format\":\"tvinoferma-google-oauth-credential\",\"version\":1,\"slotId\":\"{SLOT}\",\"clientId\":\"fake-client.apps.googleusercontent.com\",\"accountKey\":\"fake-account\",\"revision\":\"{revision}\",\"phase\":\"{phase}\",\"attemptId\":{attempt},\"refreshToken\":{token},\"refreshExpiresAt\":null}}"
    )
}
fn ready(revision: &str) -> String {
    google(revision, "ready", "null", "\"fake-refresh-token\"")
}
fn pending() -> String {
    google(REV2, "pending", &format!("\"{ATTEMPT}\""), "null")
}
fn yandex() -> String {
    format!("{{\"format\":\"tvinoferma-yandex-oauth-access\",\"version\":1,\"slotId\":\"{SLOT}\",\"clientId\":\"0123456789abcdef\",\"accountKey\":\"fake-account\",\"revision\":\"{REV1}\",\"accessToken\":\"fake-token\",\"expiresAt\":1800000000000}}")
}

#[test]
fn install_read_rotate_and_forget_are_composed_without_secret_leaks_in_head() {
    let mut vault = Vault::default();
    let a = ready(REV1);
    let p = pending();
    let b = ready(REV3);
    assert_eq!(
        cloud_credential_service::install(&mut vault, Provider::Google, SLOT, &a),
        Ok(Outcome::Installed)
    );
    let head = vault.0.get("cloud-sync-v1:google:head").unwrap();
    assert!(!head.contains("fake-refresh-token"));
    assert!(!head.contains("fake-account"));
    assert!(
        matches!(cloud_credential_service::read(&mut vault, Provider::Google), Ok(Inspection::Ready { slot_id, record }) if slot_id == SLOT && record == a)
    );
    assert_eq!(
        cloud_credential_service::compare_exchange(&mut vault, Provider::Google, SLOT, &a, &p),
        Ok(Outcome::Swapped)
    );
    // После успешного begin в известных частях нет прежнего refresh token.
    assert!(vault
        .0
        .values()
        .all(|value| !value.contains("fake-refresh-token")));
    assert!(
        matches!(cloud_credential_service::read(&mut vault, Provider::Google), Ok(Inspection::Ready { record, .. }) if record == p)
    );
    assert_eq!(
        cloud_credential_service::compare_exchange(&mut vault, Provider::Google, SLOT, &p, &b),
        Ok(Outcome::Swapped)
    );
    assert_eq!(
        cloud_credential_service::forget(&mut vault, Provider::Google),
        Ok(Outcome::Forgotten)
    );
    assert!(matches!(
        cloud_credential_service::read(&mut vault, Provider::Google),
        Ok(Inspection::Empty)
    ));
    assert!(vault.0.is_empty());
}

#[test]
fn invalid_records_and_transitions_never_touch_the_store() {
    let mut vault = Vault::default();
    assert_eq!(
        cloud_credential_service::install(&mut vault, Provider::Google, SLOT, &pending()),
        Err(StoreError::Invalid)
    );
    assert_eq!(
        cloud_credential_service::install(&mut vault, Provider::Google, SLOT, &yandex()),
        Err(StoreError::Invalid)
    );
    assert!(vault.0.is_empty());
    let a = ready(REV1);
    assert_eq!(
        cloud_credential_service::install(&mut vault, Provider::Google, SLOT, &a),
        Ok(Outcome::Installed)
    );
    let original = vault.0.clone();
    assert_eq!(
        cloud_credential_service::compare_exchange(
            &mut vault,
            Provider::Google,
            SLOT,
            &a,
            &ready(REV3)
        ),
        Err(StoreError::Invalid)
    );
    assert_eq!(
        cloud_credential_service::compare_exchange(
            &mut vault,
            Provider::Google,
            SLOT,
            &a,
            &pending().replace("fake-account", "other-account")
        ),
        Err(StoreError::Invalid)
    );
    assert_eq!(vault.0, original);
}

#[test]
fn blocked_and_wrong_slot_states_are_never_returned_as_secrets() {
    let mut vault = Vault::default();
    let a = ready(REV1);
    // Нижний слой намеренно считает строку непрозрачной: сервис обязан проверить её сам.
    assert_eq!(
        cloud_credential_store::install(&mut vault, Provider::Google, SLOT, "invalid-but-ascii"),
        Ok(Outcome::Installed)
    );
    assert!(matches!(
        cloud_credential_service::read(&mut vault, Provider::Google),
        Ok(Inspection::Blocked)
    ));
    assert_eq!(
        cloud_credential_service::install(&mut vault, Provider::Google, SLOT, &a),
        Ok(Outcome::Blocked)
    );
    assert_eq!(
        cloud_credential_service::forget(&mut vault, Provider::Google),
        Ok(Outcome::Forgotten)
    );
    assert_eq!(
        cloud_credential_store::install(&mut vault, Provider::Google, REV3, &a),
        Ok(Outcome::Installed)
    );
    assert!(matches!(
        cloud_credential_service::read(&mut vault, Provider::Google),
        Ok(Inspection::Blocked)
    ));
}

#[test]
fn yandex_record_is_install_only_and_cannot_be_silently_replaced() {
    let mut vault = Vault::default();
    let a = yandex();
    assert_eq!(
        cloud_credential_service::install(&mut vault, Provider::Yandex, SLOT, &a),
        Ok(Outcome::Installed)
    );
    assert!(
        matches!(cloud_credential_service::read(&mut vault, Provider::Yandex), Ok(Inspection::Ready { record, .. }) if record == a)
    );
    let b = a.replace(REV1, REV2);
    assert_eq!(
        cloud_credential_service::compare_exchange(&mut vault, Provider::Yandex, SLOT, &a, &b),
        Err(StoreError::Invalid)
    );
    assert_eq!(
        cloud_credential_service::install(&mut vault, Provider::Yandex, SLOT, &b),
        Ok(Outcome::Occupied)
    );
    assert_eq!(
        cloud_credential_service::forget(&mut vault, Provider::Yandex),
        Ok(Outcome::Forgotten)
    );
    assert_eq!(
        cloud_credential_service::install(&mut vault, Provider::Yandex, SLOT, &b),
        Ok(Outcome::Installed)
    );
}

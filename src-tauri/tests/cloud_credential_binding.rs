//! Проверка отдельного pin и журнала на поддельном vault. Не Windows/IPC/fsync.
#[path = "../src/cloud_credential_binding.rs"]
mod cloud_credential_binding;
#[path = "../src/cloud_credential_records.rs"]
mod cloud_credential_records;
#[path = "../src/cloud_credential_service.rs"]
mod cloud_credential_service;
#[path = "../src/cloud_credential_store.rs"]
mod cloud_credential_store;

use cloud_credential_binding::Pair;
use cloud_credential_store::{CredentialVault, Outcome, Provider, StoreError};
use std::collections::BTreeMap;

const SLOT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
const REV1: &str = "11234567-89ab-4cde-8f01-23456789abcd";
const REV2: &str = "21234567-89ab-4cde-8f01-23456789abcd";
const ATTEMPT: &str = "31234567-89ab-4cde-8f01-23456789abcd";
const CLIENT: &str = "fake-client.apps.googleusercontent.com";
const TOKEN: &str = "fake-REFRESH";
const ACCOUNT: &str = "fake-account";

#[derive(Default)]
struct Vault {
    data: BTreeMap<String, String>,
    operations: usize,
    fail_at: Option<usize>,
}
impl CredentialVault for Vault {
    fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
        Ok(self.data.get(name).cloned())
    }
    fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
        self.operations += 1;
        self.data.insert(name.to_owned(), value.to_owned());
        if self.fail_at == Some(self.operations) {
            Err(())
        } else {
            Ok(())
        }
    }
    fn remove(&mut self, name: &str) -> Result<(), ()> {
        self.operations += 1;
        self.data.remove(name);
        if self.fail_at == Some(self.operations) {
            Err(())
        } else {
            Ok(())
        }
    }
}
fn google(rev: &str, phase: &str, attempt: &str, token: &str) -> String {
    format!("{{\"format\":\"tvinoferma-google-oauth-credential\",\"version\":1,\"slotId\":\"{SLOT}\",\"clientId\":\"{CLIENT}\",\"accountKey\":\"{ACCOUNT}\",\"revision\":\"{rev}\",\"phase\":\"{phase}\",\"attemptId\":{attempt},\"refreshToken\":{token},\"refreshExpiresAt\":null}}")
}
fn ready() -> String {
    google(REV1, "ready", "null", &format!("\"{TOKEN}\""))
}
fn pending() -> String {
    google(REV2, "pending", &format!("\"{ATTEMPT}\""), "null")
}
fn yandex() -> String {
    format!("{{\"format\":\"tvinoferma-yandex-oauth-access\",\"version\":1,\"slotId\":\"{SLOT}\",\"clientId\":\"0123456789abcdef\",\"accountKey\":\"{ACCOUNT}\",\"revision\":\"{REV1}\",\"accessToken\":\"fake-token\",\"expiresAt\":1800000000000}}")
}

#[test]
fn install_binds_two_providers_and_never_exposes_token_in_pin() {
    let mut vault = Vault::default();
    for (provider, record) in [(Provider::Google, ready()), (Provider::Yandex, yandex())] {
        assert!(matches!(
            cloud_credential_binding::read(&mut vault, provider),
            Ok(Pair::Empty)
        ));
        assert_eq!(
            cloud_credential_binding::install(&mut vault, provider, SLOT, &record),
            Ok(Outcome::Installed)
        );
        assert!(
            matches!(cloud_credential_binding::read(&mut vault, provider),
            Ok(Pair::Ready { binding, record: stored }) if binding.slot_id == SLOT && binding.account_key == ACCOUNT && !binding.pending && stored == record)
        );
        assert_eq!(
            cloud_credential_binding::install(&mut vault, provider, SLOT, &record),
            Ok(Outcome::Occupied)
        );
    }
    for (name, value) in &vault.data {
        if name.starts_with("cloud-account-binding-v1:") {
            assert!(!value.contains(TOKEN));
            assert!(!value.contains("fake-token"));
        }
    }
    assert_eq!(
        cloud_credential_binding::forget(&mut vault, Provider::Google),
        Ok(Outcome::Forgotten)
    );
    assert!(matches!(
        cloud_credential_binding::read(&mut vault, Provider::Google),
        Ok(Pair::Empty)
    ));
    assert!(matches!(
        cloud_credential_binding::read(&mut vault, Provider::Yandex),
        Ok(Pair::Ready { .. })
    ));
    assert_eq!(
        cloud_credential_binding::forget(&mut vault, Provider::Yandex),
        Ok(Outcome::Forgotten)
    );
    assert!(vault.data.is_empty());
}

#[test]
fn missing_changed_or_unpinned_parts_never_authorize_a_refresh() {
    let mut vault = Vault::default();
    let a = ready();
    let p = pending();
    // Старую синтетическую запись нельзя молча признать подтверждённой.
    assert_eq!(
        cloud_credential_service::install(&mut vault, Provider::Google, SLOT, &a),
        Ok(Outcome::Installed)
    );
    assert!(matches!(
        cloud_credential_binding::read(&mut vault, Provider::Google),
        Ok(Pair::Blocked)
    ));
    assert_eq!(
        cloud_credential_binding::install(&mut vault, Provider::Google, SLOT, &a),
        Ok(Outcome::Blocked)
    );
    assert_eq!(
        cloud_credential_binding::claim_google_refresh(&mut vault, SLOT, &a, &p, CLIENT, TOKEN),
        Ok(false)
    );
    assert_eq!(
        cloud_credential_binding::forget(&mut vault, Provider::Google),
        Ok(Outcome::Forgotten)
    );
    assert_eq!(
        cloud_credential_binding::install(&mut vault, Provider::Google, SLOT, &a),
        Ok(Outcome::Installed)
    );
    let pin_name = "cloud-account-binding-v1:google:pin";
    let correct = vault.data[pin_name].clone();
    for changed in [
        None,
        Some(correct.replace(ACCOUNT, "different-account")),
        Some("tf-cloud-account-binding-v1|pending".to_owned()),
    ] {
        match changed {
            Some(value) => {
                vault.data.insert(pin_name.into(), value);
            }
            None => {
                vault.data.remove(pin_name);
            }
        }
        assert!(matches!(
            cloud_credential_binding::read(&mut vault, Provider::Google),
            Ok(Pair::Blocked)
        ));
        assert_eq!(
            cloud_credential_binding::claim_google_refresh(&mut vault, SLOT, &a, &p, CLIENT, TOKEN),
            Ok(false)
        );
    }
    vault.data.insert(pin_name.into(), correct);
    assert_eq!(
        cloud_credential_binding::claim_google_refresh(
            &mut vault,
            SLOT,
            &a,
            &p,
            CLIENT,
            "wrong-token"
        ),
        Err(StoreError::Invalid)
    );
    assert_eq!(
        cloud_credential_binding::claim_google_refresh(&mut vault, SLOT, &a, &p, CLIENT, TOKEN),
        Ok(true)
    );
    assert_eq!(
        cloud_credential_binding::claim_google_refresh(&mut vault, SLOT, &a, &p, CLIENT, TOKEN),
        Ok(false)
    );
    assert!(
        matches!(cloud_credential_binding::read(&mut vault, Provider::Google), Ok(Pair::Ready { binding, record }) if binding.pending && record == p)
    );
}

#[test]
fn every_interrupted_install_is_empty_blocked_or_exact_complete_pair() {
    let a = ready();
    let mut baseline = Vault::default();
    assert_eq!(
        cloud_credential_binding::install(&mut baseline, Provider::Google, SLOT, &a),
        Ok(Outcome::Installed)
    );
    for stop in 1..=baseline.operations {
        let mut vault = Vault {
            fail_at: Some(stop),
            ..Vault::default()
        };
        assert!(cloud_credential_binding::install(&mut vault, Provider::Google, SLOT, &a).is_err());
        vault.fail_at = None;
        match cloud_credential_binding::read(&mut vault, Provider::Google).unwrap() {
            Pair::Empty | Pair::Blocked => {}
            Pair::Ready { binding, record } => {
                assert_eq!(binding.slot_id, SLOT);
                assert_eq!(binding.client_id, CLIENT);
                assert_eq!(binding.account_key, ACCOUNT);
                assert_eq!(record, a);
            }
        }
        // Больше ни одна неуспешная установка не заменяет частичную запись.
        assert!(matches!(
            cloud_credential_binding::install(&mut vault, Provider::Google, SLOT, &a),
            Ok(Outcome::Blocked | Outcome::Occupied)
        ));
    }
}

#[test]
fn failed_forget_blocks_old_credentials_and_requires_explicit_recovery() {
    let mut vault = Vault::default();
    let a = ready();
    assert_eq!(
        cloud_credential_binding::install(&mut vault, Provider::Google, SLOT, &a),
        Ok(Outcome::Installed)
    );
    vault.fail_at = Some(vault.operations + 1);
    assert_eq!(
        cloud_credential_binding::forget(&mut vault, Provider::Google),
        Err(StoreError::Unavailable)
    );
    vault.fail_at = None;
    assert!(matches!(
        cloud_credential_binding::read(&mut vault, Provider::Google),
        Ok(Pair::Blocked)
    ));
    assert_eq!(
        cloud_credential_binding::install(&mut vault, Provider::Google, SLOT, &a),
        Ok(Outcome::Blocked)
    );
    assert_eq!(
        cloud_credential_binding::forget(&mut vault, Provider::Google),
        Ok(Outcome::Forgotten)
    );
    assert!(matches!(
        cloud_credential_binding::read(&mut vault, Provider::Google),
        Ok(Pair::Empty)
    ));
}

#[test]
fn protected_rotation_preserves_pin_and_rejects_unrelated_or_changed_records() {
    let mut vault = Vault::default();
    let a = ready();
    let p = pending();
    assert_eq!(
        cloud_credential_binding::install(&mut vault, Provider::Google, SLOT, &a),
        Ok(Outcome::Installed)
    );
    let pin_before = vault.data["cloud-account-binding-v1:google:pin"].clone();
    assert_eq!(
        cloud_credential_binding::compare_exchange(&mut vault, Provider::Google, SLOT, &a, &p),
        Ok(Outcome::Swapped)
    );
    assert_eq!(
        vault.data["cloud-account-binding-v1:google:pin"],
        pin_before
    );
    assert_eq!(
        cloud_credential_binding::compare_exchange(&mut vault, Provider::Google, SLOT, &a, &p),
        Ok(Outcome::Mismatch)
    );
    let next = google(
        "41234567-89ab-4cde-8f01-23456789abcd",
        "ready",
        "null",
        "\"fake-NEW\"",
    );
    assert_eq!(
        cloud_credential_binding::compare_exchange(&mut vault, Provider::Google, SLOT, &p, &next),
        Ok(Outcome::Swapped)
    );
    assert_eq!(
        vault.data["cloud-account-binding-v1:google:pin"],
        pin_before
    );
    assert!(
        matches!(cloud_credential_binding::read(&mut vault, Provider::Google), Ok(Pair::Ready { binding, .. }) if !binding.pending)
    );
    assert!(matches!(
        cloud_credential_binding::read(&mut vault, Provider::KeyState),
        Err(StoreError::Invalid)
    ));
}

#![allow(dead_code)]

#[path = "../src/cloud_credential_binding.rs"]
mod cloud_credential_binding;
#[path = "../src/cloud_credential_records.rs"]
mod cloud_credential_records;
#[path = "../src/cloud_credential_service.rs"]
mod cloud_credential_service;
#[path = "../src/cloud_credential_store.rs"]
mod cloud_credential_store;
#[path = "../src/cloud_dataset_binding.rs"]
mod cloud_dataset_binding;
#[path = "../src/cloud_key_state.rs"]
mod cloud_key_state;

use cloud_credential_store::{CredentialVault, Outcome, Provider, StoreError};
use cloud_dataset_binding::DatasetInspection;
use std::collections::BTreeMap;

const ACCOUNT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
const REV: &str = "11234567-89ab-4cde-8f01-23456789abcd";
const KEY_SLOT: &str = "21234567-89ab-4cde-8f01-23456789abcd";
const KEY_REV: &str = "31234567-89ab-4cde-8f01-23456789abcd";
const DATASET: &str = "41234567-89ab-4cde-8f01-23456789abcd";
const BUNDLE: &str = "51234567-89ab-4cde-8f01-23456789abcd";
const ROOT: &str = "61234567-89ab-4cde-8f01-23456789abcd";
const CLIENT: &str = "fake-client.apps.googleusercontent.com";

#[derive(Default)]
struct Vault {
    values: BTreeMap<String, String>,
    writes: usize,
    fail_at: Option<usize>,
}
impl CredentialVault for Vault {
    fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
        Ok(self.values.get(name).cloned())
    }
    fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
        self.writes += 1;
        if self.fail_at == Some(self.writes) {
            return Err(());
        }
        self.values.insert(name.into(), value.into());
        Ok(())
    }
    fn remove(&mut self, name: &str) -> Result<(), ()> {
        self.writes += 1;
        if self.fail_at == Some(self.writes) {
            return Err(());
        }
        self.values.remove(name);
        Ok(())
    }
}

fn credentials(provider: Provider) -> String {
    match provider {
        Provider::Google => format!("{{\"format\":\"tvinoferma-google-oauth-credential\",\"version\":1,\"slotId\":\"{ACCOUNT}\",\"clientId\":\"{CLIENT}\",\"accountKey\":\"private-account\",\"revision\":\"{REV}\",\"phase\":\"ready\",\"attemptId\":null,\"refreshToken\":\"private-token\",\"refreshExpiresAt\":null}}"),
        Provider::Yandex => format!("{{\"format\":\"tvinoferma-yandex-oauth-access\",\"version\":1,\"slotId\":\"{ACCOUNT}\",\"clientId\":\"0123456789abcdef\",\"accountKey\":\"private-account\",\"revision\":\"{REV}\",\"accessToken\":\"private-token\",\"expiresAt\":1000000}}"),
        Provider::KeyState => unreachable!(),
    }
}
fn key() -> String {
    format!("{{\"format\":\"tvinoferma-cloud-key-state\",\"version\":1,\"slotId\":\"{KEY_SLOT}\",\"revision\":\"{KEY_REV}\",\"datasetId\":\"{DATASET}\",\"bundleId\":\"{BUNDLE}\",\"fingerprint\":\"{}\",\"dataKey\":\"TF1-{}\",\"bundle\":\"e30\"}}", "a".repeat(64), "A".repeat(43))
}
fn pin(provider: Provider) -> String {
    let (provider, folder) = match provider {
        Provider::Google => ("google", "FOLDER_123"),
        Provider::Yandex => ("yandex", "-"),
        Provider::KeyState => unreachable!(),
    };
    format!("tf-dataset-binding-v1|{provider}|ready|{ACCOUNT}|{KEY_SLOT}|{DATASET}|{BUNDLE}|{}|{ROOT}|{}|{folder}", "a".repeat(64), "b".repeat(64))
}
fn setup(provider: Provider) -> Vault {
    let mut vault = Vault::default();
    assert_eq!(
        cloud_credential_binding::install(&mut vault, provider, ACCOUNT, &credentials(provider)),
        Ok(Outcome::Installed)
    );
    assert_eq!(
        cloud_key_state::install(&mut vault, KEY_SLOT, &key()),
        Ok(Outcome::Installed)
    );
    vault
}
fn ready(vault: &mut Vault, provider: Provider, expected: &str) -> bool {
    matches!(cloud_dataset_binding::read(vault, provider), Ok(DatasetInspection::Ready(raw)) if raw == expected)
}

#[test]
fn installs_and_reads_public_pin_for_each_provider_without_secrets() {
    for provider in [Provider::Google, Provider::Yandex] {
        let mut vault = setup(provider);
        let raw = pin(provider);
        assert!(matches!(
            cloud_dataset_binding::read(&mut vault, provider),
            Ok(DatasetInspection::Empty)
        ));
        assert_eq!(
            cloud_dataset_binding::install(&mut vault, provider, &raw),
            Ok(Outcome::Installed)
        );
        assert!(ready(&mut vault, provider, &raw));
        assert!(
            !raw.contains("private-token")
                && !raw.contains("private-account")
                && !raw.contains("TF1-")
        );
        assert_eq!(
            cloud_dataset_binding::install(&mut vault, provider, &raw),
            Ok(Outcome::Occupied)
        );
        assert_eq!(
            cloud_dataset_binding::forget(&mut vault, provider),
            Ok(Outcome::Forgotten)
        );
        assert!(matches!(
            cloud_dataset_binding::read(&mut vault, provider),
            Ok(DatasetInspection::Empty)
        ));
    }
}

#[test]
fn malformed_wrong_provider_and_wrong_bindings_never_install() {
    let mut vault = setup(Provider::Google);
    let valid = pin(Provider::Google);
    for raw in [
        format!("{valid}|extra"),
        valid.replace("FOLDER_123", "bad/path"),
        valid.replace("|ready|", "|pending|"),
        valid.replace("|google|", "|yandex|"),
        valid.replace(&"a".repeat(64), &"A".repeat(64)),
        valid.replace(ROOT, "not-a-uuid"),
        valid.replace("FOLDER_123", &"a".repeat(257)),
        valid.replace("FOLDER_123", ""),
    ] {
        assert_eq!(
            cloud_dataset_binding::install(&mut vault, Provider::Google, &raw),
            Err(StoreError::Invalid)
        );
    }
    for raw in [
        valid.replace(ACCOUNT, ROOT),
        valid.replace(KEY_SLOT, ROOT),
        valid.replace(DATASET, ROOT),
        valid.replace(BUNDLE, ROOT),
        valid.replace(&"a".repeat(64), &"c".repeat(64)),
    ] {
        assert_eq!(
            cloud_dataset_binding::install(&mut vault, Provider::Google, &raw),
            Ok(Outcome::Blocked)
        );
    }
    assert!(matches!(
        cloud_dataset_binding::read(&mut vault, Provider::Google),
        Ok(DatasetInspection::Empty)
    ));
}

#[test]
fn changed_or_missing_account_or_key_blocks_existing_pin() {
    for deleted in [
        "cloud-account-binding-v1:google:pin",
        "cloud-sync-v1:key-state:head",
        "cloud-sync-v1:google:head",
    ] {
        let mut vault = setup(Provider::Google);
        let raw = pin(Provider::Google);
        assert_eq!(
            cloud_dataset_binding::install(&mut vault, Provider::Google, &raw),
            Ok(Outcome::Installed)
        );
        vault.values.remove(deleted);
        assert!(matches!(
            cloud_dataset_binding::read(&mut vault, Provider::Google),
            Ok(DatasetInspection::Blocked)
        ));
        assert_eq!(
            cloud_dataset_binding::install(&mut vault, Provider::Google, &raw),
            Ok(Outcome::Blocked)
        );
    }
}

#[test]
fn incomplete_writes_never_become_ready_for_another_pin() {
    for fail_after in 1..=2 {
        let mut vault = setup(Provider::Google);
        let raw = pin(Provider::Google);
        vault.fail_at = Some(vault.writes + fail_after);
        assert_eq!(
            cloud_dataset_binding::install(&mut vault, Provider::Google, &raw),
            Err(StoreError::Unavailable)
        );
        vault.fail_at = None;
        match cloud_dataset_binding::read(&mut vault, Provider::Google).unwrap() {
            DatasetInspection::Empty if fail_after == 1 => {}
            DatasetInspection::Blocked if fail_after == 2 => {}
            _ => panic!("unexpected publication state"),
        }
    }
}

#[test]
fn interrupted_forget_blocks_and_can_be_explicitly_completed() {
    let mut vault = setup(Provider::Google);
    let raw = pin(Provider::Google);
    assert_eq!(
        cloud_dataset_binding::install(&mut vault, Provider::Google, &raw),
        Ok(Outcome::Installed)
    );
    vault.fail_at = Some(vault.writes + 2);
    assert_eq!(
        cloud_dataset_binding::forget(&mut vault, Provider::Google),
        Err(StoreError::Unavailable)
    );
    vault.fail_at = None;
    assert!(matches!(
        cloud_dataset_binding::read(&mut vault, Provider::Google),
        Ok(DatasetInspection::Blocked)
    ));
    assert_eq!(
        cloud_dataset_binding::forget(&mut vault, Provider::Google),
        Ok(Outcome::Forgotten)
    );
    assert!(matches!(
        cloud_dataset_binding::read(&mut vault, Provider::Google),
        Ok(DatasetInspection::Empty)
    ));
}

#[test]
fn disconnect_requires_the_same_ready_account_and_preserves_key_state() {
    for provider in [Provider::Google, Provider::Yandex] {
        let mut vault = setup(provider);
        let before = vault.values.clone();
        assert_eq!(
            cloud_dataset_binding::forget_credential_if_unbound(&mut vault, provider, "bad-slot"),
            Err(StoreError::Invalid)
        );
        assert_eq!(
            cloud_dataset_binding::forget_credential_if_unbound(&mut vault, provider, ROOT),
            Ok(Outcome::Mismatch)
        );
        assert_eq!(vault.values, before);
        assert_eq!(
            cloud_dataset_binding::forget_credential_if_unbound(&mut vault, provider, ACCOUNT),
            Ok(Outcome::Forgotten)
        );
        assert!(matches!(
            cloud_credential_binding::read(&mut vault, provider),
            Ok(cloud_credential_binding::Pair::Empty)
        ));
        // No dataset/key deletion, including the key shared with the other disk.
        assert!(before.keys().any(|name| name.contains(":key-state:")));
        for (name, value) in before
            .iter()
            .filter(|(name, _)| name.contains(":key-state:"))
        {
            assert_eq!(vault.values.get(name), Some(value));
        }
        assert!(matches!(
            cloud_dataset_binding::read(&mut vault, provider),
            Ok(DatasetInspection::Empty)
        ));
        // A second request must not manufacture a fresh pending marker.
        let after = vault.values.clone();
        assert_eq!(
            cloud_dataset_binding::forget_credential_if_unbound(&mut vault, provider, ACCOUNT),
            Ok(Outcome::Mismatch)
        );
        assert_eq!(vault.values, after);
    }
}

#[test]
fn disconnect_blocks_present_or_incomplete_dataset_pins_without_touching_anything() {
    for provider in [Provider::Google, Provider::Yandex] {
        let mut vault = setup(provider);
        let raw = pin(provider);
        assert_eq!(
            cloud_dataset_binding::install(&mut vault, provider, &raw),
            Ok(Outcome::Installed)
        );
        let before = vault.values.clone();
        assert_eq!(
            cloud_dataset_binding::forget_credential_if_unbound(&mut vault, provider, ACCOUNT),
            Ok(Outcome::Blocked)
        );
        assert_eq!(vault.values, before);
        let pin_name = match provider {
            Provider::Google => "cloud-dataset-binding-v1:google:pin",
            Provider::Yandex => "cloud-dataset-binding-v1:yandex:pin",
            Provider::KeyState => unreachable!(),
        };
        vault
            .values
            .insert(pin_name.to_string(), "incomplete".to_string());
        let before = vault.values.clone();
        assert_eq!(
            cloud_dataset_binding::forget_credential_if_unbound(&mut vault, provider, ACCOUNT),
            Ok(Outcome::Blocked)
        );
        assert_eq!(vault.values, before);
    }
}

#[test]
fn disconnect_does_not_repair_a_damaged_or_incomplete_credential() {
    let mut vault = setup(Provider::Google);
    vault.values.insert(
        "cloud-account-binding-v1:google:pin".into(),
        "incomplete".into(),
    );
    let before = vault.values.clone();
    assert_eq!(
        cloud_dataset_binding::forget_credential_if_unbound(&mut vault, Provider::Google, ACCOUNT),
        Ok(Outcome::Blocked)
    );
    assert_eq!(vault.values, before);
}

#[test]
fn disconnect_failure_can_be_partial_and_must_not_be_retried_automatically() {
    let mut vault = setup(Provider::Google);
    vault.fail_at = Some(vault.writes + 2);
    assert_eq!(
        cloud_dataset_binding::forget_credential_if_unbound(&mut vault, Provider::Google, ACCOUNT),
        Err(StoreError::Unavailable)
    );
    vault.fail_at = None;
    assert!(matches!(
        cloud_credential_binding::read(&mut vault, Provider::Google),
        Ok(cloud_credential_binding::Pair::Blocked)
    ));
    let before = vault.values.clone();
    assert_eq!(
        cloud_dataset_binding::forget_credential_if_unbound(&mut vault, Provider::Google, ACCOUNT),
        Ok(Outcome::Blocked)
    );
    assert_eq!(vault.values, before);
}

#[test]
fn first_connection_requires_no_existing_or_incomplete_dataset_pin() {
    for provider in [Provider::Google, Provider::Yandex] {
        let mut vault = Vault::default();
        assert_eq!(
            cloud_dataset_binding::install_credential_if_unbound(
                &mut vault,
                provider,
                ACCOUNT,
                &credentials(provider)
            ),
            Ok(Outcome::Installed)
        );
        assert_eq!(
            cloud_dataset_binding::install_credential_if_unbound(
                &mut vault,
                provider,
                ACCOUNT,
                &credentials(provider)
            ),
            Ok(Outcome::Occupied)
        );
        let mut bound = setup(provider);
        assert_eq!(
            cloud_dataset_binding::install(&mut bound, provider, &pin(provider)),
            Ok(Outcome::Installed)
        );
        let before = bound.values.clone();
        assert_eq!(
            cloud_dataset_binding::install_credential_if_unbound(
                &mut bound,
                provider,
                ACCOUNT,
                &credentials(provider)
            ),
            Ok(Outcome::Blocked)
        );
        assert_eq!(bound.values, before);
        let pin_name = match provider {
            Provider::Google => "cloud-dataset-binding-v1:google:pin",
            Provider::Yandex => "cloud-dataset-binding-v1:yandex:pin",
            Provider::KeyState => unreachable!(),
        };
        // A leftover or damaged pin must block creation even if credentials are absent.
        let mut orphan = Vault::default();
        orphan.values.insert(pin_name.into(), "incomplete".into());
        let before = orphan.values.clone();
        assert_eq!(
            cloud_dataset_binding::install_credential_if_unbound(
                &mut orphan,
                provider,
                ACCOUNT,
                &credentials(provider)
            ),
            Ok(Outcome::Blocked)
        );
        assert_eq!(orphan.values, before);
    }
}

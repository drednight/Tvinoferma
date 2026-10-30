//! Синтетический vault и файлы: проверяет последовательность, но не ОС, сеть,
//! настоящие криптографические данные, сбой питания или некооперативные процессы.
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
#[path = "../src/cloud_disk_transport.rs"]
mod cloud_disk_transport;
#[path = "../src/cloud_initial_outbox.rs"]
mod cloud_initial_outbox;
#[path = "../src/cloud_key_state.rs"]
mod cloud_key_state;
#[path = "../src/cloud_oauth_transport.rs"]
mod cloud_oauth_transport;
#[path = "../src/cloud_outbox_store.rs"]
mod cloud_outbox_store;

use cloud_credential_store::{CredentialVault, Outcome as VaultOutcome, Provider};
use cloud_initial_outbox::Guard;
use cloud_outbox_store::{NewRecord, OutboxFile, Outcome, StoreError, Target};
use std::collections::BTreeMap;

const ACCOUNT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
const REV: &str = "11234567-89ab-4cde-8f01-23456789abcd";
const KEY_SLOT: &str = "21234567-89ab-4cde-8f01-23456789abcd";
const KEY_REV: &str = "31234567-89ab-4cde-8f01-23456789abcd";
const DATASET: &str = "41234567-89ab-4cde-8f01-23456789abcd";
const BUNDLE: &str = "51234567-89ab-4cde-8f01-23456789abcd";
const SLOT: &str = "61234567-89ab-4cde-8f01-23456789abcd";
const DEVICE: &str = "71234567-89ab-4cde-8f01-23456789abcd";
const QUEUE_REV: &str = "81234567-89ab-4cde-8f01-23456789abcd";
const FP: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[derive(Default)]
struct Vault {
    values: BTreeMap<String, String>,
    writes: usize,
}
impl CredentialVault for Vault {
    fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
        Ok(self.values.get(name).cloned())
    }
    fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
        self.writes += 1;
        self.values.insert(name.into(), value.into());
        Ok(())
    }
    fn remove(&mut self, name: &str) -> Result<(), ()> {
        self.values.remove(name);
        Ok(())
    }
}
#[derive(Default)]
struct Disk(Option<String>);
impl OutboxFile for Disk {
    fn read(&mut self) -> Result<Option<String>, ()> {
        Ok(self.0.clone())
    }
    fn publish(&mut self, expected: Option<&str>, next: &str) -> Result<(), ()> {
        if self.0.as_deref() != expected {
            return Err(());
        }
        self.0 = Some(next.to_owned());
        Ok(())
    }
    fn remove_for_reset(&mut self) -> Result<(), ()> {
        self.0 = None;
        Ok(())
    }
}
fn credentials(provider: Provider) -> String {
    match provider {
        Provider::Google => format!("{{\"format\":\"tvinoferma-google-oauth-credential\",\"version\":1,\"slotId\":\"{ACCOUNT}\",\"clientId\":\"fake-client.apps.googleusercontent.com\",\"accountKey\":\"private-account\",\"revision\":\"{REV}\",\"phase\":\"ready\",\"attemptId\":null,\"refreshToken\":\"private-token\",\"refreshExpiresAt\":null}}"),
        Provider::Yandex => format!("{{\"format\":\"tvinoferma-yandex-oauth-access\",\"version\":1,\"slotId\":\"{ACCOUNT}\",\"clientId\":\"0123456789abcdef\",\"accountKey\":\"private-account\",\"revision\":\"{REV}\",\"accessToken\":\"private-token\",\"expiresAt\":1000000}}"),
        Provider::KeyState => unreachable!(),
    }
}
fn key() -> String {
    format!("{{\"format\":\"tvinoferma-cloud-key-state\",\"version\":1,\"slotId\":\"{KEY_SLOT}\",\"revision\":\"{KEY_REV}\",\"datasetId\":\"{DATASET}\",\"bundleId\":\"{BUNDLE}\",\"fingerprint\":\"{FP}\",\"dataKey\":\"TF1-{}\",\"bundle\":\"e30\"}}", "A".repeat(43))
}
fn envelope() -> String {
    // Только синтаксическая заглушка; это не доказательство шифрования.
    format!("{{\"format\":\"tvinoferma-cloud-sync\",\"version\":1,\"algorithm\":\"AES-256-GCM\",\"datasetId\":\"{DATASET}\",\"versionId\":\"{QUEUE_REV}\",\"iv\":\"AAAAAAAAAAAAAAAA\",\"ciphertext\":\"AAAAAAAAAAAAAAAAAAAAAA\"}}")
}
fn setup() -> Vault {
    let mut vault = Vault::default();
    for provider in [Provider::Google, Provider::Yandex] {
        assert_eq!(
            cloud_credential_binding::install(
                &mut vault,
                provider,
                ACCOUNT,
                &credentials(provider)
            ),
            Ok(VaultOutcome::Installed)
        );
    }
    assert_eq!(
        cloud_key_state::install(&mut vault, KEY_SLOT, &key()),
        Ok(VaultOutcome::Installed)
    );
    vault
}
fn record(raw: &str) -> NewRecord<'_> {
    NewRecord {
        slot_id: SLOT,
        dataset_id: DATASET,
        device_id: DEVICE,
        revision_id: QUEUE_REV,
        record: raw,
    }
}
fn guard() -> Guard<'static> {
    Guard {
        account_slot: ACCOUNT,
        key_slot: KEY_SLOT,
        bundle_id: BUNDLE,
        fingerprint: FP,
    }
}

#[test]
fn starting_one_provider_blocks_a_different_root_on_the_other() {
    for first in [Target::Google, Target::Yandex] {
        let second = if first == Target::Google {
            Target::Yandex
        } else {
            Target::Google
        };
        let mut vault = setup();
        let mut file = Disk::default();
        let mut other = Disk::default();
        let raw = envelope();
        assert_eq!(
            cloud_initial_outbox::install(
                &mut vault,
                &mut file,
                &mut other,
                first,
                &record(&raw),
                &guard()
            ),
            Ok(Outcome::Installed)
        );
        assert_eq!(
            cloud_initial_outbox::install(
                &mut vault,
                &mut other,
                &mut file,
                second,
                &record(&raw),
                &guard()
            ),
            Ok(Outcome::Blocked)
        );
        assert_eq!(
            cloud_initial_outbox::install(
                &mut vault,
                &mut file,
                &mut other,
                first,
                &record(&raw),
                &guard()
            ),
            Ok(Outcome::Occupied)
        );
        assert!(other.0.is_none());
    }
}

#[test]
fn invalid_expected_slots_and_foreign_key_never_write() {
    let mut vault = setup();
    let raw = envelope();
    let original = vault.values.clone();
    for bad in [
        Guard {
            account_slot: SLOT,
            ..guard()
        },
        Guard {
            key_slot: SLOT,
            ..guard()
        },
        Guard {
            bundle_id: SLOT,
            ..guard()
        },
        Guard {
            fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ..guard()
        },
    ] {
        let (mut file, mut other) = (Disk::default(), Disk::default());
        assert_eq!(
            cloud_initial_outbox::install(
                &mut vault,
                &mut file,
                &mut other,
                Target::Google,
                &record(&raw),
                &bad
            ),
            Ok(Outcome::Blocked)
        );
        assert!(file.0.is_none() && other.0.is_none());
    }
    let mut invalid = guard();
    invalid.key_slot = "not-a-uuid";
    assert_eq!(
        cloud_initial_outbox::install(
            &mut vault,
            &mut Disk::default(),
            &mut Disk::default(),
            Target::Google,
            &record(&raw),
            &invalid
        ),
        Err(StoreError::Invalid)
    );
    assert_eq!(vault.values, original);
}

#[test]
fn pending_or_orphaned_other_queue_and_any_dataset_pin_block_installation() {
    let raw = envelope();
    for (name, value, orphan) in [
        (
            "cloud-outbox-v1:yandex:head",
            "tf-cloud-outbox-v1|pending",
            false,
        ),
        ("cloud-outbox-v1:yandex:head", "corrupt", false),
        ("cloud-dataset-binding-v1:google:pin", "damaged", false),
        ("cloud-dataset-binding-v1:yandex:pin", "damaged", false),
        ("unrelated", "value", true),
    ] {
        let mut vault = setup();
        vault.values.insert(name.into(), value.into());
        let before = vault.values.clone();
        let mut file = Disk::default();
        let mut other = Disk(if orphan { Some("orphan".into()) } else { None });
        assert_eq!(
            cloud_initial_outbox::install(
                &mut vault,
                &mut file,
                &mut other,
                Target::Google,
                &record(&raw),
                &guard()
            ),
            Ok(Outcome::Blocked)
        );
        assert!(file.0.is_none());
        assert_eq!(vault.values, before);
    }
}

#[test]
fn missing_or_inconsistent_credential_and_key_block_both_providers() {
    let raw = envelope();
    for (target, name) in [
        (Target::Google, "cloud-account-binding-v1:google:pin"),
        (Target::Yandex, "cloud-account-binding-v1:yandex:pin"),
        (Target::Google, "cloud-sync-v1:key-state:head"),
    ] {
        let mut vault = setup();
        assert!(vault.values.remove(name).is_some());
        let before = vault.values.clone();
        let (mut file, mut other) = (Disk::default(), Disk::default());
        assert_eq!(
            cloud_initial_outbox::install(
                &mut vault,
                &mut file,
                &mut other,
                target,
                &record(&raw),
                &guard()
            ),
            Ok(Outcome::Blocked)
        );
        assert_eq!(vault.values, before);
        assert!(file.0.is_none());
    }
}

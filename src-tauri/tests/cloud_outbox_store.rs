//! Тесты порядка записи журнала с искусственными vault и файлом. Эти тесты не
//! проверяют Credential Manager, Tauri, сбой питания, NTFS или реальный диск.

#[allow(dead_code)]
#[path = "../src/cloud_credential_store.rs"]
mod cloud_credential_store;
#[allow(dead_code)]
#[path = "../src/cloud_disk_transport.rs"]
mod cloud_disk_transport;
#[allow(dead_code)]
#[path = "../src/cloud_oauth_transport.rs"]
mod cloud_oauth_transport;
#[path = "../src/cloud_outbox_store.rs"]
mod cloud_outbox_store;

use cloud_credential_store::CredentialVault;
use cloud_outbox_store::{
    Expected, Inspection, NewRecord, OutboxFile, Outcome, StoreError, Target,
};
use std::collections::BTreeMap;

const SLOT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
const DATASET: &str = "11234567-89ab-4cde-8f01-23456789abcd";
const DEVICE: &str = "21234567-89ab-4cde-8f01-23456789abcd";
const REV1: &str = "31234567-89ab-4cde-8f01-23456789abcd";
const REV2: &str = "41234567-89ab-4cde-8f01-23456789abcd";
const REV3: &str = "51234567-89ab-4cde-8f01-23456789abcd";
const GOOGLE_HEAD: &str = "cloud-outbox-v1:google:head";

fn envelope(revision: &str) -> String {
    // Синтаксическая заглушка: этот тест не утверждает, что данные зашифрованы.
    format!("{{\"format\":\"tvinoferma-cloud-sync\",\"version\":1,\"algorithm\":\"AES-256-GCM\",\"datasetId\":\"{DATASET}\",\"versionId\":\"{revision}\",\"iv\":\"AAAAAAAAAAAAAAAA\",\"ciphertext\":\"AAAAAAAAAAAAAAAAAAAAAA\"}}")
}
fn record<'a>(revision: &'a str, raw: &'a str) -> NewRecord<'a> {
    NewRecord {
        slot_id: SLOT,
        dataset_id: DATASET,
        device_id: DEVICE,
        revision_id: revision,
        record: raw,
    }
}

#[derive(Default)]
struct Vault {
    values: BTreeMap<String, String>,
    writes: usize,
    fail_write: Option<(usize, bool)>,
    fail_remove: bool,
}
impl CredentialVault for Vault {
    fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
        Ok(self.values.get(name).cloned())
    }
    fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
        self.writes += 1;
        if self.fail_write == Some((self.writes, false)) {
            return Err(());
        }
        self.values.insert(name.into(), value.into());
        if self.fail_write == Some((self.writes, true)) {
            return Err(());
        }
        Ok(())
    }
    fn remove(&mut self, name: &str) -> Result<(), ()> {
        if self.fail_remove {
            return Err(());
        }
        self.values.remove(name);
        Ok(())
    }
}

#[derive(Default)]
struct Disk {
    raw: Option<String>,
    fail_publish: Option<bool>,
    fail_remove: bool,
}
impl OutboxFile for Disk {
    fn read(&mut self) -> Result<Option<String>, ()> {
        Ok(self.raw.clone())
    }
    fn publish(&mut self, expected: Option<&str>, next: &str) -> Result<(), ()> {
        if self.raw.as_deref() != expected || self.fail_publish == Some(false) {
            return Err(());
        }
        self.raw = Some(next.to_owned());
        if self.fail_publish == Some(true) {
            return Err(());
        }
        Ok(())
    }
    fn remove_for_reset(&mut self) -> Result<(), ()> {
        if self.fail_remove {
            return Err(());
        }
        self.raw = None;
        Ok(())
    }
}
fn ready(vault: &mut Vault, file: &mut Disk) -> cloud_outbox_store::Receipt {
    match cloud_outbox_store::inspect(vault, file, Target::Google).unwrap() {
        Inspection::Ready(value) => value,
        _ => panic!("expected an intact test journal"),
    }
}
fn install(vault: &mut Vault, file: &mut Disk) {
    assert_eq!(
        cloud_outbox_store::install(vault, file, Target::Google, &record(REV1, &envelope(REV1))),
        Ok(Outcome::Installed)
    );
}

#[test]
fn initial_install_is_read_back_and_never_overwrites_existing_queue() {
    let mut vault = Vault::default();
    let mut file = Disk::default();
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
        Ok(Inspection::Empty)
    ));
    install(&mut vault, &mut file);
    let got = ready(&mut vault, &mut file);
    assert_eq!(got.slot_id, SLOT);
    assert_eq!(got.dataset_id, DATASET);
    assert_eq!(got.device_id, DEVICE);
    assert_eq!(got.revision_id, REV1);
    assert_eq!(got.record, envelope(REV1));
    assert_eq!(
        cloud_outbox_store::install(
            &mut vault,
            &mut file,
            Target::Google,
            &record(REV2, &envelope(REV2))
        ),
        Ok(Outcome::Occupied)
    );
    assert_eq!(ready(&mut vault, &mut file).revision_id, REV1);
}

#[test]
fn atomic_compare_exchange_checks_receipt_and_binding() {
    let mut vault = Vault::default();
    let mut file = Disk::default();
    install(&mut vault, &mut file);
    let first = ready(&mut vault, &mut file);
    let next = envelope(REV2);
    let expected = Expected {
        revision_id: &first.revision_id,
        sha256: &first.sha256,
    };
    assert_eq!(
        cloud_outbox_store::compare_exchange(
            &mut vault,
            &mut file,
            Target::Google,
            &expected,
            &record(REV2, &next)
        ),
        Ok(Outcome::Swapped)
    );
    assert_eq!(ready(&mut vault, &mut file).record, next);
    assert_eq!(
        cloud_outbox_store::compare_exchange(
            &mut vault,
            &mut file,
            Target::Google,
            &expected,
            &record(REV3, &envelope(REV3))
        ),
        Ok(Outcome::Mismatch)
    );
    assert_eq!(ready(&mut vault, &mut file).revision_id, REV2);
}

#[test]
fn incomplete_or_tampered_parts_never_become_empty_or_ready() {
    let mut vault = Vault::default();
    let mut file = Disk {
        raw: Some(envelope(REV1)),
        ..Disk::default()
    };
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
        Ok(Inspection::Blocked)
    ));
    assert_eq!(
        cloud_outbox_store::install(
            &mut vault,
            &mut file,
            Target::Google,
            &record(REV2, &envelope(REV2))
        ),
        Ok(Outcome::Blocked)
    );
    file.raw = None;
    install(&mut vault, &mut file);
    let original = file.raw.clone();
    file.raw = None;
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
        Ok(Inspection::Blocked)
    ));
    file.raw = Some(envelope(REV2));
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
        Ok(Inspection::Blocked)
    ));
    file.raw = original;
    vault.values.insert(GOOGLE_HEAD.into(), "malformed".into());
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
        Ok(Inspection::Blocked)
    ));
}

#[test]
fn losing_or_damaging_the_independent_pin_blocks_use() {
    let mut vault = Vault::default();
    let mut file = Disk::default();
    install(&mut vault, &mut file);
    vault.values.remove(GOOGLE_HEAD);
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
        Ok(Inspection::Blocked)
    ));
    assert_eq!(
        cloud_outbox_store::install(
            &mut vault,
            &mut file,
            Target::Google,
            &record(REV2, &envelope(REV2))
        ),
        Ok(Outcome::Blocked)
    );
}

#[test]
fn pending_head_survives_failure_before_or_after_file_publication() {
    for after in [false, true] {
        let mut vault = Vault::default();
        let mut file = Disk::default();
        install(&mut vault, &mut file);
        let old = ready(&mut vault, &mut file);
        file.fail_publish = Some(after);
        let expected = Expected {
            revision_id: &old.revision_id,
            sha256: &old.sha256,
        };
        assert_eq!(
            cloud_outbox_store::compare_exchange(
                &mut vault,
                &mut file,
                Target::Google,
                &expected,
                &record(REV2, &envelope(REV2))
            ),
            Err(StoreError::Unavailable)
        );
        file.fail_publish = None;
        assert!(matches!(
            cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
            Ok(Inspection::Pending)
        ));
        assert_eq!(
            cloud_outbox_store::compare_exchange(
                &mut vault,
                &mut file,
                Target::Google,
                &expected,
                &record(REV2, &envelope(REV2))
            ),
            Ok(Outcome::Blocked)
        );
    }
}

#[test]
fn lost_response_after_pending_write_is_not_assumed_unchanged() {
    let mut vault = Vault::default();
    let mut file = Disk::default();
    install(&mut vault, &mut file);
    let old = ready(&mut vault, &mut file);
    vault.fail_write = Some((vault.writes + 1, true));
    let expected = Expected {
        revision_id: &old.revision_id,
        sha256: &old.sha256,
    };
    assert_eq!(
        cloud_outbox_store::compare_exchange(
            &mut vault,
            &mut file,
            Target::Google,
            &expected,
            &record(REV2, &envelope(REV2))
        ),
        Err(StoreError::Unavailable)
    );
    vault.fail_write = None;
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
        Ok(Inspection::Pending)
    ));
    assert_eq!(file.raw, Some(envelope(REV1)));
}

#[test]
fn lost_response_after_ready_write_can_leave_the_new_record() {
    let mut vault = Vault::default();
    let mut file = Disk::default();
    install(&mut vault, &mut file);
    let old = ready(&mut vault, &mut file);
    vault.fail_write = Some((vault.writes + 2, true));
    let expected = Expected {
        revision_id: &old.revision_id,
        sha256: &old.sha256,
    };
    assert_eq!(
        cloud_outbox_store::compare_exchange(
            &mut vault,
            &mut file,
            Target::Google,
            &expected,
            &record(REV2, &envelope(REV2))
        ),
        Err(StoreError::Unavailable)
    );
    vault.fail_write = None;
    assert_eq!(ready(&mut vault, &mut file).revision_id, REV2);
}

#[test]
fn rejects_invalid_or_noncanonical_envelopes_without_modifying_storage() {
    let mut vault = Vault::default();
    let mut file = Disk::default();
    let correct = envelope(REV1);
    for raw in [
        "PRIVATE open content".to_owned(),
        correct.replace("\"iv\"", "\"iv\":\"AAAAAAAAAAAAAAAA\",\"iv\""),
        correct.replace("AAAAAAAAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAB"),
        correct.replace(REV1, REV2),
    ] {
        assert_eq!(
            cloud_outbox_store::install(&mut vault, &mut file, Target::Google, &record(REV1, &raw)),
            Err(StoreError::Invalid)
        );
    }
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
        Ok(Inspection::Empty)
    ));
}

#[test]
fn different_providers_use_separate_os_heads() {
    let mut vault = Vault::default();
    let mut google = Disk::default();
    let mut yandex = Disk::default();
    install(&mut vault, &mut google);
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut yandex, Target::Yandex),
        Ok(Inspection::Empty)
    ));
    assert_eq!(
        cloud_outbox_store::install(
            &mut vault,
            &mut yandex,
            Target::Yandex,
            &record(REV2, &envelope(REV2))
        ),
        Ok(Outcome::Installed)
    );
    assert_eq!(ready(&mut vault, &mut google).revision_id, REV1);
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut yandex, Target::Yandex),
        Ok(Inspection::Ready(_))
    ));
}

#[test]
fn full_reset_removes_only_the_selected_known_parts_and_reports_partial_failures() {
    let mut vault = Vault::default();
    let mut google = Disk::default();
    let mut yandex = Disk::default();
    install(&mut vault, &mut google);
    assert_eq!(
        cloud_outbox_store::install(
            &mut vault,
            &mut yandex,
            Target::Yandex,
            &record(REV2, &envelope(REV2))
        ),
        Ok(Outcome::Installed)
    );
    assert_eq!(
        cloud_outbox_store::remove_for_reset(&mut vault, &mut google, Target::Google),
        Ok(())
    );
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut google, Target::Google),
        Ok(Inspection::Empty)
    ));
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut yandex, Target::Yandex),
        Ok(Inspection::Ready(_))
    ));

    install(&mut vault, &mut google);
    google.fail_remove = true;
    assert_eq!(
        cloud_outbox_store::remove_for_reset(&mut vault, &mut google, Target::Google),
        Err(StoreError::Unavailable)
    );
    google.fail_remove = false;
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut google, Target::Google),
        Ok(Inspection::Blocked)
    ));
    assert_eq!(
        cloud_outbox_store::remove_for_reset(&mut vault, &mut google, Target::Google),
        Ok(())
    );
    install(&mut vault, &mut google);
    vault.fail_remove = true;
    assert_eq!(
        cloud_outbox_store::remove_for_reset(&mut vault, &mut google, Target::Google),
        Err(StoreError::Unavailable)
    );
    vault.fail_remove = false;
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut google, Target::Google),
        Ok(Inspection::Blocked)
    ));
}

#[test]
fn failed_initial_write_never_claims_that_install_happened() {
    for after in [false, true] {
        let mut vault = Vault {
            fail_write: Some((1, after)),
            ..Vault::default()
        };
        let mut file = Disk::default();
        assert_eq!(
            cloud_outbox_store::install(
                &mut vault,
                &mut file,
                Target::Google,
                &record(REV1, &envelope(REV1))
            ),
            Err(StoreError::Unavailable)
        );
        vault.fail_write = None;
        let observed = cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google).unwrap();
        if after {
            assert!(matches!(observed, Inspection::Pending));
        } else {
            assert!(matches!(observed, Inspection::Empty));
        }
    }
}

#[test]
fn failed_ready_head_write_leaves_pending_after_file_was_changed() {
    let mut vault = Vault::default();
    let mut file = Disk::default();
    install(&mut vault, &mut file);
    let old = ready(&mut vault, &mut file);
    vault.fail_write = Some((vault.writes + 2, false));
    let expected = Expected {
        revision_id: &old.revision_id,
        sha256: &old.sha256,
    };
    assert_eq!(
        cloud_outbox_store::compare_exchange(
            &mut vault,
            &mut file,
            Target::Google,
            &expected,
            &record(REV2, &envelope(REV2))
        ),
        Err(StoreError::Unavailable)
    );
    vault.fail_write = None;
    assert_eq!(file.raw, Some(envelope(REV2)));
    assert!(matches!(
        cloud_outbox_store::inspect(&mut vault, &mut file, Target::Google),
        Ok(Inspection::Pending)
    ));
}

#[test]
fn binding_change_does_not_replace_existing_queue() {
    let mut vault = Vault::default();
    let mut file = Disk::default();
    install(&mut vault, &mut file);
    let old = ready(&mut vault, &mut file);
    let next = envelope(REV2);
    let expected = Expected {
        revision_id: &old.revision_id,
        sha256: &old.sha256,
    };
    let wrong_slot = NewRecord {
        slot_id: REV3,
        ..record(REV2, &next)
    };
    assert_eq!(
        cloud_outbox_store::compare_exchange(
            &mut vault,
            &mut file,
            Target::Google,
            &expected,
            &wrong_slot
        ),
        Ok(Outcome::Mismatch)
    );
    assert_eq!(ready(&mut vault, &mut file).record, old.record);
}

//! Синтетический vault; не реальный Credential Manager и не криптография ключей.

#[allow(dead_code)]
#[path = "../src/cloud_credential_store.rs"]
mod cloud_credential_store;
#[path = "../src/cloud_key_state.rs"]
mod cloud_key_state;

use cloud_credential_store::{CredentialVault, Inspection, Outcome, Provider, StoreError};
use std::collections::BTreeMap;

const SLOT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
const REV1: &str = "11234567-89ab-4cde-8f01-23456789abcd";
const REV2: &str = "21234567-89ab-4cde-8f01-23456789abcd";
const DATASET: &str = "31234567-89ab-4cde-8f01-23456789abcd";
const BUNDLE1: &str = "41234567-89ab-4cde-8f01-23456789abcd";
const BUNDLE2: &str = "51234567-89ab-4cde-8f01-23456789abcd";

fn record(
    revision: &str,
    bundle_id: &str,
    fingerprint: char,
    data_key: &str,
    bundle: &str,
) -> String {
    format!(
        "{{\"format\":\"tvinoferma-cloud-key-state\",\"version\":1,\"slotId\":\"{SLOT}\",\"revision\":\"{revision}\",\"datasetId\":\"{DATASET}\",\"bundleId\":\"{bundle_id}\",\"fingerprint\":\"{}\",\"dataKey\":\"{data_key}\",\"bundle\":\"{bundle}\"}}",
        fingerprint.to_string().repeat(64)
    )
}
fn old() -> String {
    record(
        REV1,
        BUNDLE1,
        'a',
        &format!("TF1-{}", "A".repeat(43)),
        "e30",
    )
}
fn next() -> String {
    record(
        REV2,
        BUNDLE2,
        'b',
        &format!("TF1-{}", "A".repeat(43)),
        "W10",
    )
}

#[derive(Default)]
struct Vault {
    values: BTreeMap<String, String>,
    fail_write_at: Option<usize>,
    writes: usize,
}
impl CredentialVault for Vault {
    fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
        Ok(self.values.get(name).cloned())
    }
    fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
        self.writes += 1;
        if self.fail_write_at == Some(self.writes) {
            return Err(());
        }
        self.values.insert(name.into(), value.into());
        Ok(())
    }
    fn remove(&mut self, name: &str) -> Result<(), ()> {
        self.values.remove(name);
        Ok(())
    }
}

#[test]
fn install_read_replace_and_forget_use_a_separate_namespace() {
    let mut vault = Vault::default();
    assert!(matches!(
        cloud_key_state::read(&mut vault),
        Ok(Inspection::Empty)
    ));
    assert_eq!(
        cloud_key_state::install(&mut vault, SLOT, &old()),
        Ok(Outcome::Installed)
    );
    assert!(
        matches!(cloud_key_state::read(&mut vault), Ok(Inspection::Ready { slot_id, record }) if slot_id == SLOT && record == old())
    );
    let public = cloud_key_state::public_binding(&mut vault)
        .unwrap()
        .unwrap();
    assert_eq!(public.slot_id, SLOT);
    assert_eq!(public.dataset_id, DATASET);
    assert_eq!(public.bundle_id, BUNDLE1);
    assert_eq!(public.fingerprint, "a".repeat(64));
    assert!(matches!(
        cloud_credential_store::inspect(&mut vault, Provider::Google),
        Ok(Inspection::Empty)
    ));
    assert!(matches!(
        cloud_credential_store::inspect(&mut vault, Provider::Yandex),
        Ok(Inspection::Empty)
    ));
    assert_eq!(
        cloud_key_state::install(&mut vault, SLOT, &old()),
        Ok(Outcome::Occupied)
    );
    assert_eq!(
        cloud_key_state::compare_exchange(&mut vault, SLOT, &old(), &next()),
        Ok(Outcome::Swapped)
    );
    assert_eq!(
        cloud_key_state::compare_exchange(&mut vault, SLOT, &old(), &next()),
        Ok(Outcome::Mismatch)
    );
    assert_eq!(cloud_key_state::forget(&mut vault), Ok(Outcome::Forgotten));
    assert!(matches!(
        cloud_key_state::read(&mut vault),
        Ok(Inspection::Empty)
    ));
}

#[test]
fn refuses_malformed_or_noncanonical_records() {
    let key = format!("TF1-{}", "A".repeat(43));
    let valid = old();
    let invalid = [
        valid.replace("\"version\":1", "\"version\":2"),
        valid.replace(SLOT, REV1),
        valid.replace(BUNDLE1, DATASET),
        valid.replace(&"a".repeat(64), &"A".repeat(64)),
        valid.replace(&key, &format!("TF1-{}B", "A".repeat(42))),
        valid.replace("\"e30\"", "\"e31\""),
        valid.replace("\"e30\"", "\"e\""),
        valid.replace("\"e30\"", &format!("\"{}\"", "A".repeat(12_004))),
        valid.replace("\"bundle\":", "\"unexpected\":null,\"bundle\":"),
        valid.replace("e30", "кириллица"),
    ];
    for value in invalid {
        let mut vault = Vault::default();
        assert_eq!(
            cloud_key_state::install(&mut vault, SLOT, &value),
            Err(StoreError::Invalid)
        );
        assert!(matches!(
            cloud_key_state::read(&mut vault),
            Ok(Inspection::Empty)
        ));
    }
    assert_eq!(
        cloud_key_state::install(&mut Vault::default(), REV2, &valid),
        Err(StoreError::Invalid)
    );
}

#[test]
fn transitions_cannot_change_dataset_or_data_key_or_reuse_revision_and_bundle() {
    let mut vault = Vault::default();
    let before = old();
    assert_eq!(
        cloud_key_state::install(&mut vault, SLOT, &before),
        Ok(Outcome::Installed)
    );
    let changed_key = format!("TF1-{}", "B".repeat(42) + "A");
    let invalid = [
        next().replace(DATASET, REV1),
        record(REV2, BUNDLE2, 'b', &changed_key, "W10"),
        record(
            REV1,
            BUNDLE2,
            'b',
            &format!("TF1-{}", "A".repeat(43)),
            "W10",
        ),
        record(
            REV2,
            BUNDLE1,
            'b',
            &format!("TF1-{}", "A".repeat(43)),
            "W10",
        ),
        record(
            REV2,
            BUNDLE2,
            'a',
            &format!("TF1-{}", "A".repeat(43)),
            "W10",
        ),
        record(
            REV2,
            BUNDLE2,
            'b',
            &format!("TF1-{}", "A".repeat(43)),
            "e30",
        ),
    ];
    for value in invalid {
        assert_eq!(
            cloud_key_state::compare_exchange(&mut vault, SLOT, &before, &value),
            Err(StoreError::Invalid)
        );
    }
    assert!(
        matches!(cloud_key_state::read(&mut vault), Ok(Inspection::Ready { record, .. }) if record == before)
    );
}

#[test]
fn partial_write_and_corrupt_record_block_automatic_reinitialization() {
    let mut interrupted = Vault {
        fail_write_at: Some(2),
        ..Vault::default()
    };
    assert_eq!(
        cloud_key_state::install(&mut interrupted, SLOT, &old()),
        Err(StoreError::Unavailable)
    );
    assert!(matches!(
        cloud_key_state::read(&mut interrupted),
        Ok(Inspection::Blocked)
    ));
    assert_eq!(
        cloud_key_state::install(&mut interrupted, SLOT, &old()),
        Ok(Outcome::Blocked)
    );
    assert_eq!(
        cloud_key_state::forget(&mut interrupted),
        Ok(Outcome::Forgotten)
    );
    assert!(matches!(
        cloud_key_state::read(&mut interrupted),
        Ok(Inspection::Empty)
    ));

    let mut malformed = Vault::default();
    assert_eq!(
        cloud_credential_store::install(
            &mut malformed,
            Provider::KeyState,
            SLOT,
            "ascii-but-invalid"
        ),
        Ok(Outcome::Installed)
    );
    assert!(matches!(
        cloud_key_state::read(&mut malformed),
        Ok(Inspection::Blocked)
    ));
    assert_eq!(
        cloud_key_state::install(&mut malformed, SLOT, &old()),
        Ok(Outcome::Blocked)
    );
}

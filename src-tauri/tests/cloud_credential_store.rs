//! Изолированные тесты журнала облачных записей. Здесь нет Windows Credential
//! Manager, Tauri или настоящих токенов. Тестируется порядок операций и fail-closed,
//! а не устойчивость хранилища ОС, межпроцессный lock или реальный сбой питания.

#[path = "../src/cloud_credential_store.rs"]
mod store;

use std::collections::BTreeMap;
use store::{CredentialVault, Inspection, Outcome, Provider, StoreError};

const SLOT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
const OTHER_SLOT: &str = "11234567-89ab-4cde-8f01-23456789abcd";
const GOOGLE: Provider = Provider::Google;
const YANDEX: Provider = Provider::Yandex;

#[derive(Clone, Default)]
struct FakeVault {
    data: BTreeMap<String, String>,
    calls: usize,
    fail: Option<(usize, bool)>,
}

impl FakeVault {
    fn step(&mut self, after: bool) -> Result<(), ()> {
        if !after {
            self.calls += 1;
        }
        if self.fail == Some((self.calls, after)) {
            return Err(());
        }
        Ok(())
    }

    fn fail_at(&mut self, call: usize, after: bool) {
        self.calls = 0;
        self.fail = Some((call, after));
    }

    fn recovered(&mut self) {
        self.calls = 0;
        self.fail = None;
    }
}

impl CredentialVault for FakeVault {
    fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
        self.step(false)?;
        let result = self.data.get(name).cloned();
        self.step(true)?;
        Ok(result)
    }

    fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
        self.step(false)?;
        self.data.insert(name.to_owned(), value.to_owned());
        self.step(true)
    }

    fn remove(&mut self, name: &str) -> Result<(), ()> {
        self.step(false)?;
        self.data.remove(name);
        self.step(true)
    }
}

fn ready(vault: &mut FakeVault, provider: Provider) -> (String, String) {
    match store::inspect(vault, provider).unwrap() {
        Inspection::Ready { slot_id, record } => (slot_id, record),
        Inspection::Empty => panic!("expected a fake record, got empty"),
        Inspection::Blocked => panic!("expected a fake record, got blocked"),
    }
}

fn is_blocked(vault: &mut FakeVault, provider: Provider) -> bool {
    matches!(
        store::inspect(vault, provider).unwrap(),
        Inspection::Blocked
    )
}

fn is_empty(vault: &mut FakeVault, provider: Provider) -> bool {
    matches!(store::inspect(vault, provider).unwrap(), Inspection::Empty)
}

fn install(vault: &mut FakeVault, provider: Provider, raw: &str) {
    assert_eq!(
        store::install(vault, provider, SLOT, raw),
        Ok(Outcome::Installed)
    );
}

#[test]
fn first_install_and_restart_read_a_long_record_without_losing_parts() {
    let mut vault = FakeVault::default();
    assert!(is_empty(&mut vault, GOOGLE));
    let record = format!("{{\"fake\":\"{}\"}}", "a".repeat(16_000));
    install(&mut vault, GOOGLE, &record);
    let restarted = &mut vault.clone();
    assert_eq!(ready(restarted, GOOGLE), (SLOT.to_owned(), record.clone()));
    let parts: Vec<_> = vault
        .data
        .iter()
        .filter(|(name, _)| name.contains(":part:"))
        .collect();
    assert!(parts.len() > 20);
    assert!(parts
        .iter()
        .all(|(_, value)| value.len() <= 768 && value.is_ascii()));
    assert!(!vault.data.values().any(|value| value.contains(&record)));
}

#[test]
fn provider_and_key_namespaces_do_not_share_head_or_parts() {
    let mut vault = FakeVault::default();
    install(&mut vault, GOOGLE, "google-test-secret");
    install(&mut vault, YANDEX, "yandex-test-secret");
    install(&mut vault, Provider::KeyState, "key-test-secret");
    assert_eq!(ready(&mut vault, GOOGLE).1, "google-test-secret");
    assert_eq!(ready(&mut vault, YANDEX).1, "yandex-test-secret");
    assert_eq!(ready(&mut vault, Provider::KeyState).1, "key-test-secret");
    assert_eq!(store::forget(&mut vault, GOOGLE), Ok(Outcome::Forgotten));
    assert!(is_empty(&mut vault, GOOGLE));
    assert_eq!(ready(&mut vault, YANDEX).1, "yandex-test-secret");
    assert_eq!(ready(&mut vault, Provider::KeyState).1, "key-test-secret");
}

#[test]
fn initial_install_never_overwrites_existing_or_partial_records() {
    let mut vault = FakeVault::default();
    install(&mut vault, GOOGLE, "old-fake-token");
    let original = vault.data.clone();
    assert_eq!(
        store::install(&mut vault, GOOGLE, OTHER_SLOT, "other"),
        Ok(Outcome::Occupied)
    );
    assert_eq!(vault.data, original);
    vault.data.remove("cloud-sync-v1:google:head");
    let broken = vault.data.clone();
    assert!(is_blocked(&mut vault, GOOGLE));
    assert_eq!(
        store::install(&mut vault, GOOGLE, OTHER_SLOT, "other"),
        Ok(Outcome::Blocked)
    );
    assert_eq!(vault.data, broken);
}

#[test]
fn input_is_checked_before_accessing_the_vault() {
    let mut vault = FakeVault::default();
    for (slot, record) in [
        ("not-a-uuid", "x"),
        ("01234567-89ab-1cde-8f01-23456789abcd", "x"),
        (SLOT, ""),
        (SLOT, "line\nbreak"),
        (SLOT, "тест"),
        (SLOT, "a\0b"),
    ] {
        assert_eq!(
            store::install(&mut vault, GOOGLE, slot, record),
            Err(StoreError::Invalid)
        );
    }
    assert_eq!(
        store::install(
            &mut vault,
            GOOGLE,
            SLOT,
            &"a".repeat(store::MAX_RECORD_BYTES + 1)
        ),
        Err(StoreError::Invalid)
    );
    assert_eq!(vault.calls, 0);
    assert!(vault.data.is_empty());
}

#[test]
fn max_length_is_supported() {
    let mut vault = FakeVault::default();
    let record = "X".repeat(store::MAX_RECORD_BYTES);
    install(&mut vault, GOOGLE, &record);
    assert_eq!(ready(&mut vault, GOOGLE).1, record);
    assert!(vault.data.values().all(|value| value.len() <= 768));
}

#[test]
fn compare_exchange_rechecks_both_slot_and_exact_record() {
    let mut vault = FakeVault::default();
    install(&mut vault, GOOGLE, "old");
    let original = vault.data.clone();
    assert_eq!(
        store::compare_exchange(&mut vault, GOOGLE, SLOT, "wrong", "new"),
        Ok(Outcome::Mismatch)
    );
    assert_eq!(
        store::compare_exchange(&mut vault, GOOGLE, OTHER_SLOT, "old", "new"),
        Ok(Outcome::Mismatch)
    );
    assert_eq!(vault.data, original);
    assert_eq!(
        store::compare_exchange(&mut vault, GOOGLE, SLOT, "old", "old"),
        Err(StoreError::Invalid)
    );
    assert_eq!(
        store::compare_exchange(&mut vault, GOOGLE, SLOT, "old", "new"),
        Ok(Outcome::Swapped)
    );
    assert_eq!(
        ready(&mut vault, GOOGLE),
        (SLOT.to_owned(), "new".to_owned())
    );
    assert_eq!(
        store::compare_exchange(&mut vault, GOOGLE, SLOT, "old", "newer"),
        Ok(Outcome::Mismatch)
    );
}

#[test]
fn shortening_an_update_erases_obsolete_parts_before_publishing_head() {
    let mut vault = FakeVault::default();
    let old = "o".repeat(3000);
    install(&mut vault, GOOGLE, &old);
    assert_eq!(
        store::compare_exchange(&mut vault, GOOGLE, SLOT, &old, "new"),
        Ok(Outcome::Swapped)
    );
    assert_eq!(ready(&mut vault, GOOGLE).1, "new");
    assert!(!vault.data.contains_key("cloud-sync-v1:google:part:01"));
    assert!(!vault.data.contains_key("cloud-sync-v1:google:part:03"));
}

#[test]
fn corruption_missing_parts_extra_parts_or_bad_head_blocks_reads_and_writes() {
    let mut seed = FakeVault::default();
    let record = "r".repeat(1600);
    install(&mut seed, GOOGLE, &record);
    let head_key = "cloud-sync-v1:google:head";
    let part_key = "cloud-sync-v1:google:part:00";
    let mut examples = Vec::new();
    let mut v = seed.clone();
    v.data.remove(part_key);
    examples.push(v);
    let mut v = seed.clone();
    v.data.get_mut(part_key).unwrap().replace_range(0..1, "x");
    examples.push(v);
    let mut v = seed.clone();
    v.data
        .insert("cloud-sync-v1:google:part:21".into(), "extra".into());
    examples.push(v);
    for bad_head in [
        "tf-cloud-credential-v1|pending".to_owned(),
        "tf-cloud-credential-v1|ready|no-id|1|not-a-hash".to_owned(),
        "garbage".to_owned(),
        format!("{}|extra", seed.data[head_key]),
        seed.data[head_key].replace("|1600|", "|01600|"),
    ] {
        let mut v = seed.clone();
        v.data.insert(head_key.into(), bad_head);
        examples.push(v);
    }
    for mut v in examples {
        let before = v.data.clone();
        assert!(is_blocked(&mut v, GOOGLE));
        assert_eq!(
            store::install(&mut v, GOOGLE, SLOT, "replacement"),
            Ok(Outcome::Blocked)
        );
        assert_eq!(
            store::compare_exchange(&mut v, GOOGLE, SLOT, &record, "new"),
            Ok(Outcome::Blocked)
        );
        assert_eq!(v.data, before);
    }
}

#[test]
fn unavailable_reads_are_not_treated_as_absence() {
    let mut vault = FakeVault::default();
    vault.fail_at(1, false);
    assert!(matches!(
        store::inspect(&mut vault, GOOGLE),
        Err(StoreError::Unavailable)
    ));
    vault.fail_at(2, false);
    assert_eq!(
        store::install(&mut vault, GOOGLE, SLOT, "fake"),
        Err(StoreError::Unavailable)
    );
    assert!(vault.data.is_empty());
}

#[test]
fn every_install_interruption_is_empty_blocked_or_the_complete_new_record() {
    let record = "n".repeat(2200);
    let mut successful = FakeVault::default();
    install(&mut successful, GOOGLE, &record);
    let calls = successful.calls;
    for after in [false, true] {
        for fail_at in 1..=calls {
            let mut vault = FakeVault::default();
            vault.fail_at(fail_at, after);
            let result = store::install(&mut vault, GOOGLE, SLOT, &record);
            assert_eq!(
                result,
                Err(StoreError::Unavailable),
                "call {fail_at}, after={after}"
            );
            vault.recovered();
            match store::inspect(&mut vault, GOOGLE).unwrap() {
                Inspection::Empty | Inspection::Blocked => {}
                Inspection::Ready {
                    slot_id,
                    record: actual,
                } => {
                    assert_eq!(slot_id, SLOT);
                    assert_eq!(actual, record);
                }
            }
        }
    }
}

#[test]
fn every_update_interruption_returns_only_a_complete_old_or_new_record_or_blocks() {
    let old = "old".repeat(900);
    let next = "new".repeat(350);
    let mut seed = FakeVault::default();
    install(&mut seed, GOOGLE, &old);
    seed.recovered();
    let mut successful = seed.clone();
    assert_eq!(
        store::compare_exchange(&mut successful, GOOGLE, SLOT, &old, &next),
        Ok(Outcome::Swapped)
    );
    let calls = successful.calls;
    for after in [false, true] {
        for fail_at in 1..=calls {
            let mut vault = seed.clone();
            vault.fail_at(fail_at, after);
            let result = store::compare_exchange(&mut vault, GOOGLE, SLOT, &old, &next);
            assert_eq!(
                result,
                Err(StoreError::Unavailable),
                "call {fail_at}, after={after}"
            );
            vault.recovered();
            match store::inspect(&mut vault, GOOGLE).unwrap() {
                Inspection::Blocked => {}
                Inspection::Ready { slot_id, record } => {
                    assert_eq!(slot_id, SLOT);
                    assert!(record == old || record == next, "a hybrid record escaped");
                }
                Inspection::Empty => panic!("an existing record disappeared"),
            }
        }
    }
}

#[test]
fn every_forget_interruption_never_exposes_a_partial_record() {
    let old = "s".repeat(1600);
    let mut seed = FakeVault::default();
    install(&mut seed, GOOGLE, &old);
    seed.recovered();
    let mut successful = seed.clone();
    assert_eq!(
        store::forget(&mut successful, GOOGLE),
        Ok(Outcome::Forgotten)
    );
    let calls = successful.calls;
    assert!(is_empty(&mut successful, GOOGLE));
    for after in [false, true] {
        for fail_at in 1..=calls {
            let mut vault = seed.clone();
            vault.fail_at(fail_at, after);
            let result = store::forget(&mut vault, GOOGLE);
            assert_eq!(
                result,
                Err(StoreError::Unavailable),
                "call {fail_at}, after={after}"
            );
            vault.recovered();
            match store::inspect(&mut vault, GOOGLE).unwrap() {
                Inspection::Empty | Inspection::Blocked => {}
                Inspection::Ready { slot_id, record } => {
                    assert_eq!(slot_id, SLOT);
                    assert_eq!(record, old);
                }
            }
        }
    }
}

#[test]
fn explicit_forget_recovers_from_a_partially_damaged_local_connection() {
    let mut vault = FakeVault::default();
    install(&mut vault, GOOGLE, &"a".repeat(900));
    vault.data.remove("cloud-sync-v1:google:head");
    assert!(is_blocked(&mut vault, GOOGLE));
    assert_eq!(store::forget(&mut vault, GOOGLE), Ok(Outcome::Forgotten));
    assert!(is_empty(&mut vault, GOOGLE));
    install(&mut vault, GOOGLE, "new-connection-after-explicit-forget");
}

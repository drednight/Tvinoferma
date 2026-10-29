//! Изолированная проверка формы записей; никакого реального OAuth или ОС.

#[path = "../src/cloud_credential_records.rs"]
mod cloud_credential_records;
#[allow(dead_code)]
#[path = "../src/cloud_credential_store.rs"]
mod cloud_credential_store;

use cloud_credential_records::{parse, valid_initial, valid_transition};
use cloud_credential_store::Provider::{Google, Yandex};

const SLOT: &str = "01234567-89ab-4cde-8f01-23456789abcd";
const REV1: &str = "11234567-89ab-4cde-8f01-23456789abcd";
const REV2: &str = "21234567-89ab-4cde-8f01-23456789abcd";
const REV3: &str = "31234567-89ab-4cde-8f01-23456789abcd";
const ATTEMPT: &str = "41234567-89ab-4cde-8f01-23456789abcd";
const CLIENT: &str = "fake-client.apps.googleusercontent.com";
const ACCOUNT: &str = "fake-account_123";

fn google(revision: &str, phase: &str, attempt: &str, token: &str, expires: &str) -> String {
    format!(
        "{{\"format\":\"tvinoferma-google-oauth-credential\",\"version\":1,\"slotId\":\"{SLOT}\",\"clientId\":\"{CLIENT}\",\"accountKey\":\"{ACCOUNT}\",\"revision\":\"{revision}\",\"phase\":\"{phase}\",\"attemptId\":{attempt},\"refreshToken\":{token},\"refreshExpiresAt\":{expires}}}"
    )
}
fn ready(revision: &str) -> String {
    google(revision, "ready", "null", "\"fake-REFRESH\"", "null")
}
fn pending(revision: &str, attempt: &str) -> String {
    google(
        revision,
        "pending",
        &format!("\"{attempt}\""),
        "null",
        "null",
    )
}
fn yandex() -> String {
    format!(
        "{{\"format\":\"tvinoferma-yandex-oauth-access\",\"version\":1,\"slotId\":\"{SLOT}\",\"clientId\":\"0123456789abcdef\",\"accountKey\":\"{ACCOUNT}\",\"revision\":\"{REV1}\",\"accessToken\":\"fake_ABC-123==\",\"expiresAt\":1800000000000}}"
    )
}

#[test]
fn canonical_google_and_yandex_are_accepted_for_their_own_slot() {
    assert!(valid_initial(Google, SLOT, &ready(REV1)));
    assert!(valid_initial(Yandex, SLOT, &yandex()));
    assert!(!valid_initial(Google, REV3, &ready(REV1)));
    assert!(!valid_initial(Yandex, REV3, &yandex()));
    assert!(!valid_initial(Google, SLOT, &yandex()));
    assert!(!valid_initial(Yandex, SLOT, &ready(REV1)));
}

#[test]
fn google_refresh_rotation_requires_matching_binding_and_two_distinct_phases() {
    let r1 = ready(REV1);
    let p = pending(REV2, ATTEMPT);
    let r3 = ready(REV3);
    assert!(!valid_initial(Google, SLOT, &p));
    assert!(valid_transition(Google, SLOT, &r1, &p));
    assert!(valid_transition(Google, SLOT, &p, &r3));
    assert!(!valid_transition(Google, SLOT, &r1, &r3));
    assert!(!valid_transition(Google, SLOT, &p, &p));
    assert!(!valid_transition(Google, REV3, &r1, &p));
    assert!(!valid_transition(
        Google,
        SLOT,
        &r1,
        &p.replace(ACCOUNT, "other-account")
    ));
    assert!(!valid_transition(
        Google,
        SLOT,
        &r1,
        &p.replace(CLIENT, "other.apps.googleusercontent.com")
    ));
    assert!(!valid_transition(Google, SLOT, &r1, &pending(REV2, REV1)));
    assert!(!valid_transition(Google, SLOT, &pending(REV2, REV3), &r3));
    assert!(!valid_transition(
        Yandex,
        SLOT,
        &yandex(),
        &yandex().replace(REV1, REV2)
    ));
}

#[test]
fn pending_record_cannot_keep_or_reuse_a_token_or_an_invalid_attempt() {
    for bad in [
        google(
            REV2,
            "pending",
            &format!("\"{ATTEMPT}\""),
            "\"secret\"",
            "null",
        ),
        google(REV2, "pending", "null", "null", "null"),
        google(REV2, "pending", &format!("\"{SLOT}\""), "null", "null"),
        google(REV2, "pending", &format!("\"{REV2}\""), "null", "null"),
        google(REV2, "pending", &format!("\"{ATTEMPT}\""), "null", "1"),
        google(
            REV2,
            "ready",
            &format!("\"{ATTEMPT}\""),
            "\"token\"",
            "null",
        ),
        google(REV2, "ready", "null", "null", "null"),
    ] {
        assert!(parse(Google, &bad).is_none());
    }
}

#[test]
fn canonical_json_required_duplicate_fields_and_escaping_rejected() {
    let raw = ready(REV1);
    for bad in [
        format!(" {raw}"),
        format!("{raw} "),
        raw.replace(
            "\"phase\":\"ready\"",
            "\"phase\":\"ready\",\"phase\":\"ready\"",
        ),
        raw.replace("\"revision\":", "\"revis\\u0069on\":"),
        raw.replace("\"version\":1", "\"version\":01"),
        raw.replace("\"accountKey\":", "\"unknown\":1,\"accountKey\":"),
        raw.replace("\"fake-REFRESH\"", "\"fake\\/REFRESH\""),
        raw.replace("\"fake-REFRESH\"", "\"fake\\u002dREFRESH\""),
        raw.replace("\"fake-REFRESH\"", "\"fake\\nREFRESH\""),
    ] {
        assert!(parse(Google, &bad).is_none());
    }
    // JSON.stringify does escape quotes and backslashes in otherwise valid tokens.
    assert!(valid_initial(
        Google,
        SLOT,
        &raw.replace("fake-REFRESH", "fake\\\"and\\\\slash")
    ));
}

#[test]
fn invalid_client_account_uuid_token_and_numbers_are_rejected() {
    let g = ready(REV1);
    for bad in [
        g.replace(CLIENT, "ab.apps.googleusercontent.com"),
        g.replace(CLIENT, "abc.apps.googleusercontent.com.evil"),
        g.replace(ACCOUNT, "unsafe account"),
        g.replace(SLOT, "01234567-89ab-1cde-8f01-23456789abcd"),
        g.replace(REV1, SLOT),
        g.replace("fake-REFRESH", ""),
        g.replace("fake-REFRESH", &"x".repeat(8193)),
        g.replace("fake-REFRESH", "has space"),
        g.replace("\"refreshExpiresAt\":null", "\"refreshExpiresAt\":0"),
        g.replace(
            "\"refreshExpiresAt\":null",
            "\"refreshExpiresAt\":9007199254740992",
        ),
        g.replace("\"refreshExpiresAt\":null", "\"refreshExpiresAt\":-1"),
    ] {
        assert!(parse(Google, &bad).is_none());
    }
    for bad in [
        yandex().replace("0123456789abcdef", "short"),
        yandex().replace("fake_ABC-123==", ""),
        yandex().replace("fake_ABC-123==", "has=middle"),
        yandex().replace("fake_ABC-123==", "a b"),
        yandex().replace("1800000000000", "0"),
        yandex().replace("1800000000000", "9007199254740992"),
    ] {
        assert!(parse(Yandex, &bad).is_none());
    }
    assert!(valid_initial(
        Google,
        SLOT,
        &g.replace(
            "\"refreshExpiresAt\":null",
            "\"refreshExpiresAt\":9007199254740991"
        )
    ));
}

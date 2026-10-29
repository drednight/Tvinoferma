use super::state::lock_state_io;
use super::state_files::{classify_write_error, create_verified_backup, replace_state_for_restore};
use super::{data_dir, state_path};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    name: String,
    /// Время создания, мс с 1970 (для отображения в интерфейсе)
    created_at: u64,
    size: u64,
}

// The fingerprints are temporary witnesses for the confirmation dialog, not a
// password hash, proof of origin, durable pin, or a cross-process lock. Do not log them.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreWitness {
    backup_sha256: String,
    current_sha256: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInspection {
    witness: RestoreWitness,
    schema_version: Option<u64>,
    characters: Option<usize>,
    archived_characters: Option<usize>,
    planner_entries: Option<usize>,
    vault_reference: &'static str,
    current_state: &'static str,
}

const MAX_RESTORE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `state.backup-<unix>[-label].json` (новый формат) и `backup-<iso>.json` (старый фронтенд).
fn is_valid_backup_name(name: &str) -> bool {
    !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && (name.starts_with("state.backup-") || name.starts_with("backup-"))
        && name.ends_with(".json")
}

fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(32)
        .collect()
}

fn list_backup_files(dir: &Path) -> Result<Vec<(PathBuf, u64, u64)>, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !path.is_file() || !is_valid_backup_name(name) {
            continue;
        }
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push((path, modified, meta.len()));
    }
    files.sort_by_key(|a| std::cmp::Reverse(a.1)); // новые сверху
    Ok(files)
}

fn prune_backups(dir: &Path, max_count: usize, protected: &str) -> Result<(), String> {
    // Новая проверенная копия обязательно остаётся, даже если у файлов одинаковое mtime.
    let keep_others = max_count.max(1) - 1;
    let files = list_backup_files(dir)?;
    if !files
        .iter()
        .any(|(path, _, _)| path.file_name().and_then(|name| name.to_str()) == Some(protected))
    {
        return Err("Новая резервная копия недоступна; старые сохранены".to_string());
    }
    for (path, _, _) in files
        .into_iter()
        .filter(|(path, _, _)| path.file_name().and_then(|name| name.to_str()) != Some(protected))
        .skip(keep_others)
    {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn create_backup_at(
    dir: &Path,
    state: &Path,
    max_count: usize,
    label: &str,
    timestamp: u64,
) -> Result<String, String> {
    let label = sanitize_label(label);
    let file_name = create_verified_backup(state, dir, timestamp, &label)
        .map_err(|_| "Не удалось создать и проверить резервную копию".to_string())?;
    // Ни одну старую копию не удаляем до успешного завершения новой.
    prune_backups(dir, max_count, &file_name)?;
    Ok(file_name)
}

pub fn create_backup_file(
    app: &AppHandle,
    max_count: Option<usize>,
    label: Option<String>,
) -> Result<String, String> {
    let _guard = lock_state_io()?;
    let dir = data_dir(app)?;
    let state = state_path(app)?;
    create_backup_at(
        &dir,
        &state,
        max_count.unwrap_or(10),
        label.as_deref().unwrap_or(""),
        unix_now(),
    )
}

#[tauri::command]
pub fn create_backup(
    app: AppHandle,
    max_count: Option<usize>,
    label: Option<String>,
) -> Result<String, String> {
    create_backup_file(&app, max_count, label)
}

fn create_migration_backup_with<F>(
    dir: &Path,
    state: &Path,
    expected_raw: &str,
    label: &str,
    timestamp: u64,
    mut make_backup: F,
) -> Result<String, String>
where
    F: FnMut(&Path, &Path, u64, &str) -> std::io::Result<String>,
{
    let parsed = serde_json::from_str::<serde_json::Value>(expected_raw)
        .map_err(|_| "Исходные данные некорректны; миграция остановлена".to_string())?;
    if !parsed.is_object() {
        return Err("Исходные данные некорректны; миграция остановлена".to_string());
    }
    match fs::symlink_metadata(state) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        _ => return Err("Исходные данные недоступны; миграция остановлена".to_string()),
    }
    let current = fs::read_to_string(state)
        .map_err(|_| "Не удалось проверить исходные данные; миграция остановлена".to_string())?;
    if current != expected_raw {
        return Err("Исходные данные изменились; миграция остановлена".to_string());
    }
    let safe_label = sanitize_label(label);
    let name = make_backup(state, dir, timestamp, &safe_label).map_err(|_| {
        "Не удалось создать и проверить резервную копию; миграция остановлена".to_string()
    })?;
    // Проверяем и копию, и текущее состояние после публикации. Ни одну из старых
    // копий не вращаем; даже при ошибке после публикации новую не удаляем вслепую.
    let backup = dir.join(&name);
    let regular = fs::symlink_metadata(&backup)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false);
    let current_regular = fs::symlink_metadata(state)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false);
    if !regular
        || !current_regular
        || fs::read(&backup).ok().as_deref() != Some(expected_raw.as_bytes())
        || fs::read(state).ok().as_deref() != Some(expected_raw.as_bytes())
    {
        return Err(
            "Не удалось подтвердить резервную копию или данные изменились; миграция остановлена"
                .to_string(),
        );
    }
    Ok(name)
}

fn create_migration_backup_at(
    dir: &Path,
    state: &Path,
    expected_raw: &str,
    label: &str,
    timestamp: u64,
) -> Result<String, String> {
    create_migration_backup_with(
        dir,
        state,
        expected_raw,
        label,
        timestamp,
        create_verified_backup,
    )
}

#[tauri::command]
pub fn create_migration_backup(
    app: AppHandle,
    expected_raw: String,
    label: Option<String>,
) -> Result<String, String> {
    let _guard = lock_state_io()?;
    create_migration_backup_at(
        &data_dir(&app)?,
        &state_path(&app)?,
        &expected_raw,
        label.as_deref().unwrap_or("pre-migration"),
        unix_now(),
    )
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let _guard = lock_state_io()?;
    let dir = data_dir(&app)?;
    Ok(list_backup_files(&dir)?
        .into_iter()
        .filter_map(|(path, created_at, size)| {
            let name = path.file_name()?.to_str()?.to_string();
            Some(BackupInfo {
                name,
                created_at,
                size,
            })
        })
        .collect())
}

// Reads are bounded and reject a symlink or non-file. As elsewhere in this module,
// the metadata check does not provide a cross-process no-follow/open transaction.
fn read_regular_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            if metadata.len() > MAX_RESTORE_FILE_BYTES {
                return Err("Файл слишком велик для проверки восстановления".to_string());
            }
        }
        Ok(_) => return Err("Некорректный файл восстановления".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Не удалось проверить файл восстановления".to_string()),
    }
    let file =
        File::open(path).map_err(|_| "Не удалось прочитать файл восстановления".to_string())?;
    if !file
        .metadata()
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        return Err("Некорректный файл восстановления".to_string());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RESTORE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Не удалось прочитать файл восстановления".to_string())?;
    if bytes.len() as u64 > MAX_RESTORE_FILE_BYTES {
        return Err("Файл слишком велик для проверки восстановления".to_string());
    }
    Ok(Some(bytes))
}

fn validated_backup(dir: &Path, file_name: &str) -> Result<(PathBuf, Vec<u8>, Value), String> {
    if !is_valid_backup_name(file_name) {
        return Err("Некорректное имя резервной копии".to_string());
    }
    let path = dir.join(file_name);
    let bytes =
        read_regular_bytes(&path)?.ok_or_else(|| "Резервная копия не найдена".to_string())?;
    let parsed = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| "Резервная копия повреждена".to_string())?;
    if !parsed.is_object() {
        return Err("Резервная копия не содержит состояние приложения".to_string());
    }
    Ok((path, bytes, parsed))
}

fn fingerprint(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        // Formatting to String cannot fail.
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn version_for_review(parsed: &Value) -> Option<u64> {
    let value = parsed
        .get("schemaVersion")
        .filter(|value| !value.is_null())
        .or_else(|| parsed.get("version"));
    let number = match value {
        None | Some(Value::Null) => return Some(1),
        Some(Value::Number(number)) => number.as_f64(),
        // Reject rather than misclassify strings with JSON/JS numeric syntax
        // that Rust's parser does not recognize (e.g. "0x20").
        Some(Value::String(text)) => match text.parse::<f64>() {
            Ok(number) => Some(number),
            Err(_) => return None,
        },
        // Non-scalar versions are not confidently described by this preview.
        _ => return None,
    };
    match number {
        Some(number) if number.is_finite() && number > 0.0 => {
            Some(number.floor().min(MAX_SAFE_JS_INTEGER as f64) as u64)
        }
        _ => Some(1),
    }
}

fn inspect_backup_at(
    dir: &Path,
    state: &Path,
    file_name: &str,
) -> Result<BackupInspection, String> {
    let (_, backup, parsed) = validated_backup(dir, file_name)?;
    let current = read_regular_bytes(state)?;
    let current_state = match current.as_deref() {
        None => "missing",
        Some(bytes)
            if serde_json::from_slice::<Value>(bytes)
                .map(|v| v.is_object())
                .unwrap_or(false) =>
        {
            "readable"
        }
        Some(_) => "damaged",
    };
    let vault_reference = match parsed.get("secretsInVault") {
        Some(Value::Bool(true)) => "os-referenced",
        None | Some(Value::Bool(false)) => "not-marked",
        _ => "unknown",
    };
    let count = |key: &str| parsed.get(key).and_then(Value::as_array).map(Vec::len);
    Ok(BackupInspection {
        witness: RestoreWitness {
            backup_sha256: fingerprint(&backup),
            current_sha256: current.as_deref().map(fingerprint),
        },
        schema_version: version_for_review(&parsed),
        characters: count("characters"),
        archived_characters: count("archivedCharacters"),
        planner_entries: count("plannerEntries"),
        vault_reference,
        current_state,
    })
}

/// Only metadata and temporary SHA-256 witnesses cross IPC. The raw backup and
/// current state may contain contacts/passwords and are never returned or logged.
#[tauri::command]
pub async fn inspect_backup(app: AppHandle, file_name: String) -> Result<BackupInspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_state_io()?;
        inspect_backup_at(&data_dir(&app)?, &state_path(&app)?, &file_name)
    })
    .await
    .map_err(|_| "Не удалось проверить резервную копию".to_string())?
}

fn restore_backup_checked_with<F>(
    dir: &Path,
    state: &Path,
    file_name: &str,
    timestamp: u64,
    witness: Option<&RestoreWitness>,
    mut make_backup: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path, u64, &str) -> std::io::Result<String>,
{
    let (backup_path, raw, _) = validated_backup(dir, file_name)?;
    let previous = read_regular_bytes(state)?;
    if let Some(expected) = witness {
        if !valid_fingerprint(&expected.backup_sha256)
            || expected
                .current_sha256
                .as_deref()
                .is_some_and(|hash| !valid_fingerprint(hash))
            || fingerprint(&raw) != expected.backup_sha256
            || previous.as_deref().map(fingerprint) != expected.current_sha256
        {
            return Err(
                "Данные или выбранная копия изменились после просмотра; восстановление остановлено"
                    .to_string(),
            );
        }
    }
    // Preserve even corrupt current bytes, without pruning. A lost result or an
    // unverifiable new copy never authorizes replacement or removal of old copies.
    if let Some(before) = previous.as_deref() {
        let name = make_backup(state, dir, timestamp, "pre-restore").map_err(|_| {
            "Не удалось сохранить текущие данные; восстановление остановлено".to_string()
        })?;
        if !is_valid_backup_name(&name)
            || name == file_name
            || read_regular_bytes(&dir.join(name))?.as_deref() != Some(before)
        {
            return Err(
                "Не удалось проверить копию текущих данных; восстановление остановлено".to_string(),
            );
        }
    }
    // Check both sources again after creating the pre-restore copy. The final
    // check runs once more after the temporary replacement is ready. Neither
    // check is a CAS against non-cooperating processes or an ABA detector.
    if read_regular_bytes(state)? != previous
        || read_regular_bytes(&backup_path)?.as_deref() != Some(raw.as_slice())
    {
        return Err(
            "Данные или выбранная копия изменились; восстановление остановлено".to_string(),
        );
    }
    replace_state_for_restore(state, &raw, previous.as_deref(), &backup_path, &raw)
}

#[cfg(test)]
fn restore_backup_with<F>(
    dir: &Path,
    state: &Path,
    file_name: &str,
    timestamp: u64,
    make_backup: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path, u64, &str) -> std::io::Result<String>,
{
    restore_backup_checked_with(dir, state, file_name, timestamp, None, make_backup)
}

#[cfg(test)]
fn restore_backup_at(
    dir: &Path,
    state: &Path,
    file_name: &str,
    timestamp: u64,
) -> Result<(), String> {
    restore_backup_with(dir, state, file_name, timestamp, create_verified_backup)
}

#[tauri::command]
pub fn restore_backup(
    app: AppHandle,
    file_name: String,
    witness: Option<RestoreWitness>,
) -> Result<(), String> {
    (|| {
        let _guard = lock_state_io()?;
        restore_backup_checked_with(
            &data_dir(&app)?,
            &state_path(&app)?,
            &file_name,
            unix_now(),
            witness.as_ref(),
            create_verified_backup,
        )
    })()
    .map_err(classify_write_error)
}

#[tauri::command]
pub fn delete_backup(app: AppHandle, file_name: String) -> Result<(), String> {
    let _guard = lock_state_io()?;
    if !is_valid_backup_name(&file_name) {
        return Err("Invalid backup name".to_string());
    }
    let backup_path = data_dir(&app)?.join(file_name);
    if backup_path.exists() {
        fs::remove_file(backup_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_backup_names() {
        assert!(is_valid_backup_name("state.backup-1700000000.json"));
        assert!(is_valid_backup_name(
            "state.backup-1700000000-pre-migration.json"
        ));
        assert!(is_valid_backup_name("backup-2026-10-01T10-00-00-000Z.json"));
        assert!(!is_valid_backup_name("state.json"));
        assert!(!is_valid_backup_name("../state.backup-1.json"));
        assert!(!is_valid_backup_name("state.backup-1.txt"));
    }

    #[test]
    fn sanitizes_labels() {
        assert_eq!(sanitize_label("pre-migration v3!"), "pre-migrationv3");
    }

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let path = std::env::temp_dir().join(format!(
                "tf-backup-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn checked_copy_survives_rotation_even_with_equal_timestamps() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(&state, br#"{"v":1}"#).unwrap();
        for _ in 0..12 {
            let newest = create_backup_at(&dir.0, &state, 1, "manual", 123).unwrap();
            assert!(dir.0.join(&newest).is_file());
            assert_eq!(fs::read(dir.0.join(newest)).unwrap(), br#"{"v":1}"#);
            assert_eq!(list_backup_files(&dir.0).unwrap().len(), 1);
        }
    }

    #[test]
    fn migration_backup_matches_loaded_raw_and_never_rotates_old_copies() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let before = "{ \"schemaVersion\": 9, \"name\": \"Герой\" }";
        fs::write(&state, before).unwrap();
        for n in 0..12 {
            fs::write(dir.0.join(format!("state.backup-old-{}.json", n)), b"{}").unwrap();
        }
        let name =
            create_migration_backup_at(&dir.0, &state, before, "pre-migration-v9", 123).unwrap();
        assert_eq!(fs::read_to_string(dir.0.join(name)).unwrap(), before);
        assert_eq!(fs::read_to_string(&state).unwrap(), before);
        assert_eq!(list_backup_files(&dir.0).unwrap().len(), 13);
    }

    #[test]
    fn migration_backup_rejects_changed_or_unreadable_state_without_deleting_old_copies() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let before = "{ \"schemaVersion\": 9 }";
        let changed = "{\"schemaVersion\":9}";
        fs::write(&state, changed).unwrap();
        fs::write(dir.0.join("state.backup-old.json"), b"old").unwrap();
        assert!(create_migration_backup_at(&dir.0, &state, before, "test", 123).is_err());
        assert_eq!(fs::read_to_string(&state).unwrap(), changed);
        assert_eq!(list_backup_files(&dir.0).unwrap().len(), 1);
        fs::remove_file(&state).unwrap();
        assert!(create_migration_backup_at(&dir.0, &state, before, "test", 123).is_err());
        assert_eq!(
            fs::read(dir.0.join("state.backup-old.json")).unwrap(),
            b"old"
        );
    }

    #[test]
    fn migration_backup_failure_or_source_change_never_replaces_state() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let before = "{\"schemaVersion\":9}";
        let changed = "{\"schemaVersion\":9,\"external\":true}";
        fs::write(&state, before).unwrap();
        fs::write(dir.0.join("state.backup-old.json"), b"old").unwrap();
        let denied =
            create_migration_backup_with(&dir.0, &state, before, "test", 123, |_, _, _, _| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected",
                ))
            });
        assert!(denied.is_err());
        assert_eq!(fs::read_to_string(&state).unwrap(), before);
        let changed_during_backup = create_migration_backup_with(
            &dir.0,
            &state,
            before,
            "test",
            124,
            |source, dir, timestamp, label| {
                let name = create_verified_backup(source, dir, timestamp, label)?;
                fs::write(source, changed)?;
                Ok(name)
            },
        );
        assert!(changed_during_backup.is_err());
        assert_eq!(fs::read_to_string(&state).unwrap(), changed);
        assert_eq!(
            fs::read(dir.0.join("state.backup-old.json")).unwrap(),
            b"old"
        );
        let backups = list_backup_files(&dir.0).unwrap();
        assert_eq!(backups.len(), 2);
        assert!(backups
            .iter()
            .any(|(path, _, _)| fs::read_to_string(path).ok().as_deref() == Some(before)));
    }

    #[test]
    fn migration_backup_rejects_copy_changed_after_publication_without_pruning() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let before = "{\"schemaVersion\":9}";
        fs::write(&state, before).unwrap();
        fs::write(dir.0.join("state.backup-old.json"), b"old").unwrap();
        let result = create_migration_backup_with(
            &dir.0,
            &state,
            before,
            "test",
            123,
            |source, dir, timestamp, label| {
                let name = create_verified_backup(source, dir, timestamp, label)?;
                fs::write(dir.join(&name), b"tampered")?;
                Ok(name)
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&state).unwrap(), before);
        assert_eq!(
            fs::read(dir.0.join("state.backup-old.json")).unwrap(),
            b"old"
        );
        assert_eq!(list_backup_files(&dir.0).unwrap().len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn migration_backup_rejects_symlink_source() {
        use std::os::unix::fs::symlink;
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(dir.0.join("real.json"), b"{}").unwrap();
        symlink("real.json", &state).unwrap();
        assert!(create_migration_backup_at(&dir.0, &state, "{}", "test", 123).is_err());
        assert_eq!(fs::read(dir.0.join("real.json")).unwrap(), b"{}");
        assert!(list_backup_files(&dir.0).unwrap().is_empty());
    }

    #[test]
    fn restore_checks_and_preserves_old_state_without_pruning_any_backup() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let previous = br#"{"characters":[{"nick":"local"}]}"#;
        let requested = br#"{"characters":[{"nick":"backup"}]}"#;
        fs::write(&state, previous).unwrap();
        fs::write(dir.0.join("state.backup-selected.json"), requested).unwrap();
        for n in 0..52 {
            fs::write(dir.0.join(format!("state.backup-old-{}.json", n)), b"{}").unwrap();
        }
        restore_backup_at(&dir.0, &state, "state.backup-selected.json", 123).unwrap();
        assert_eq!(fs::read(&state).unwrap(), requested);
        assert_eq!(
            fs::read(dir.0.join("state.backup-selected.json")).unwrap(),
            requested
        );
        let all = list_backup_files(&dir.0).unwrap();
        assert_eq!(all.len(), 54);
        let pre = all
            .into_iter()
            .find(|(path, _, _)| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains("pre-restore")
            })
            .unwrap()
            .0;
        assert_eq!(fs::read(pre).unwrap(), previous);
    }

    #[test]
    fn failure_to_backup_stops_restore_before_state_changes() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(&state, br#"{"v":"old"}"#).unwrap();
        fs::write(dir.0.join("state.backup-selected.json"), br#"{"v":"new"}"#).unwrap();
        let mut called = false;
        let result = restore_backup_with(
            &dir.0,
            &state,
            "state.backup-selected.json",
            123,
            |_, _, _, _| {
                called = true;
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected",
                ))
            },
        );
        assert!(called);
        assert!(result.unwrap_err().contains("восстановление остановлено"));
        assert_eq!(fs::read(&state).unwrap(), br#"{"v":"old"}"#);
        assert_eq!(list_backup_files(&dir.0).unwrap().len(), 1);
    }

    #[test]
    fn review_only_exposes_summary_and_temporary_hashes() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let name = "state.backup-selected.json";
        fs::write(&state, b"not valid JSON\x80").unwrap();
        fs::write(
            dir.0.join(name),
            br#"{"schemaVersion":10,"characters":[{"nick":"PRIVATE"}],"archivedCharacters":[],"plannerEntries":[{},{}],"secretsInVault":true}"#,
        )
        .unwrap();
        let inspected = inspect_backup_at(&dir.0, &state, name).unwrap();
        assert_eq!(inspected.schema_version, Some(10));
        assert_eq!(inspected.characters, Some(1));
        assert_eq!(inspected.archived_characters, Some(0));
        assert_eq!(inspected.planner_entries, Some(2));
        assert_eq!(inspected.vault_reference, "os-referenced");
        assert_eq!(inspected.current_state, "damaged");
        assert!(valid_fingerprint(&inspected.witness.backup_sha256));
        assert!(valid_fingerprint(
            inspected.witness.current_sha256.as_deref().unwrap()
        ));
        assert!(!inspected.witness.backup_sha256.contains("PRIVATE"));
        let response = serde_json::to_string(&inspected).unwrap();
        assert!(!response.contains("PRIVATE"));
        assert!(response.contains("\"backupSha256\""));
        assert!(response.contains("\"currentState\":\"damaged\""));
        assert!(serde_json::from_str::<RestoreWitness>(
            r#"{"backupSha256":"ignored","currentSha256":null,"extra":"forbidden"}"#
        )
        .is_err());
        assert_eq!(
            fingerprint(b"{}"),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }

    #[test]
    fn review_distinguishes_absent_false_and_invalid_vault_markers() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let selected = "state.backup-selected.json";
        for (body, expected) in [
            (r#"{}"#, "not-marked"),
            (r#"{"secretsInVault":false}"#, "not-marked"),
            (r#"{"secretsInVault":true}"#, "os-referenced"),
            (r#"{"secretsInVault":null}"#, "unknown"),
            (r#"{"secretsInVault":"yes"}"#, "unknown"),
        ] {
            fs::write(dir.0.join(selected), body).unwrap();
            assert_eq!(
                inspect_backup_at(&dir.0, &state, selected)
                    .unwrap()
                    .vault_reference,
                expected
            );
        }
        fs::write(
            dir.0.join(selected),
            r#"{"schemaVersion":null,"version":99}"#,
        )
        .unwrap();
        assert_eq!(
            inspect_backup_at(&dir.0, &state, selected)
                .unwrap()
                .schema_version,
            Some(99)
        );
    }

    #[test]
    fn review_detects_changed_current_backup_or_new_current_before_any_copy() {
        for changed in ["current", "backup", "appearance"] {
            let dir = TestDir::new();
            let state = dir.0.join("state.json");
            let name = "state.backup-selected.json";
            let selected = dir.0.join(name);
            fs::write(&selected, br#"{"value":"reviewed"}"#).unwrap();
            if changed != "appearance" {
                fs::write(&state, br#"{"value":"before"}"#).unwrap();
            }
            let reviewed = inspect_backup_at(&dir.0, &state, name).unwrap().witness;
            if changed == "backup" {
                fs::write(&selected, br#"{"value":"other backup"}"#).unwrap();
            } else {
                fs::write(&state, br#"{"value":"external"}"#).unwrap();
            }
            let before_state = fs::read(&state).unwrap();
            let before_backup = fs::read(&selected).unwrap();
            let mut invoked = false;
            let result = restore_backup_checked_with(
                &dir.0,
                &state,
                name,
                123,
                Some(&reviewed),
                |_, _, _, _| {
                    invoked = true;
                    unreachable!("a stale review must stop before backup")
                },
            );
            assert!(result.is_err());
            assert!(!invoked);
            assert_eq!(fs::read(&state).unwrap(), before_state);
            assert_eq!(fs::read(&selected).unwrap(), before_backup);
            assert_eq!(list_backup_files(&dir.0).unwrap().len(), 1);
        }
    }

    #[test]
    fn review_success_preserves_pre_restore_bytes_without_pruning() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let selected = "state.backup-selected.json";
        let previous = b"damaged bytes\x80";
        let incoming = br#"{"characters":[],"secretsInVault":true}"#;
        fs::write(&state, previous).unwrap();
        fs::write(dir.0.join(selected), incoming).unwrap();
        fs::write(dir.0.join("state.backup-older.json"), b"old").unwrap();
        let reviewed = inspect_backup_at(&dir.0, &state, selected).unwrap().witness;
        restore_backup_checked_with(
            &dir.0,
            &state,
            selected,
            123,
            Some(&reviewed),
            create_verified_backup,
        )
        .unwrap();
        assert_eq!(fs::read(&state).unwrap(), incoming);
        let all = list_backup_files(&dir.0).unwrap();
        assert_eq!(all.len(), 3);
        let pre = all
            .into_iter()
            .find(|(path, _, _)| path.to_string_lossy().contains("pre-restore"))
            .unwrap()
            .0;
        assert_eq!(fs::read(pre).unwrap(), previous);
        assert_eq!(
            fs::read(dir.0.join("state.backup-older.json")).unwrap(),
            b"old"
        );
    }

    #[test]
    fn change_or_copy_tampering_during_pre_restore_never_replaces_state() {
        for changed in ["current", "selected", "pre-copy"] {
            let dir = TestDir::new();
            let state = dir.0.join("state.json");
            let selected = "state.backup-selected.json";
            let previous = br#"{"value":"before"}"#;
            fs::write(&state, previous).unwrap();
            fs::write(dir.0.join(selected), br#"{"value":"incoming"}"#).unwrap();
            let reviewed = inspect_backup_at(&dir.0, &state, selected).unwrap().witness;
            let result = restore_backup_checked_with(
                &dir.0,
                &state,
                selected,
                123,
                Some(&reviewed),
                |src, dir, time, label| {
                    let made = create_verified_backup(src, dir, time, label)?;
                    match changed {
                        "current" => fs::write(src, br#"{"value":"external"}"#)?,
                        "selected" => fs::write(dir.join(selected), br#"{"value":"different"}"#)?,
                        _ => fs::write(dir.join(&made), b"tampered")?,
                    }
                    Ok(made)
                },
            );
            assert!(result.is_err());
            assert_eq!(
                fs::read(&state).unwrap(),
                if changed == "current" {
                    br#"{"value":"external"}"#.as_slice()
                } else {
                    previous
                }
            );
            assert_eq!(list_backup_files(&dir.0).unwrap().len(), 2);
        }
    }

    #[test]
    fn oversized_current_or_backup_cannot_be_read_or_restored() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let selected = "state.backup-selected.json";
        fs::write(&state, b"{}").unwrap();
        let huge_backup = File::create(dir.0.join(selected)).unwrap();
        huge_backup.set_len(MAX_RESTORE_FILE_BYTES + 1).unwrap();
        assert!(inspect_backup_at(&dir.0, &state, selected).is_err());
        assert!(restore_backup_at(&dir.0, &state, selected, 123).is_err());
        assert_eq!(fs::read(&state).unwrap(), b"{}");
        drop(huge_backup);
        fs::write(dir.0.join(selected), b"{}").unwrap();
        let huge_state = File::create(&state).unwrap();
        huge_state.set_len(MAX_RESTORE_FILE_BYTES + 1).unwrap();
        assert!(inspect_backup_at(&dir.0, &state, selected).is_err());
        assert!(restore_backup_at(&dir.0, &state, selected, 123).is_err());
        assert_eq!(
            fs::metadata(&state).unwrap().len(),
            MAX_RESTORE_FILE_BYTES + 1
        );
        assert_eq!(list_backup_files(&dir.0).unwrap().len(), 1);
    }

    #[test]
    fn review_rejects_invalid_witness_and_suspicious_schema_without_secret_errors() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let selected = "state.backup-selected.json";
        fs::write(&state, b"{}").unwrap();
        fs::write(
            dir.0.join(selected),
            br#"{"schemaVersion":"0x20","password":"PRIVATE"}"#,
        )
        .unwrap();
        let review = inspect_backup_at(&dir.0, &state, selected).unwrap();
        assert_eq!(review.schema_version, None);
        let forged = RestoreWitness {
            backup_sha256: "PRIVATE".into(),
            current_sha256: review.witness.current_sha256,
        };
        let error = restore_backup_checked_with(
            &dir.0,
            &state,
            selected,
            123,
            Some(&forged),
            create_verified_backup,
        )
        .unwrap_err();
        assert!(!error.contains("PRIVATE"));
        assert_eq!(fs::read(&state).unwrap(), b"{}");
        assert_eq!(list_backup_files(&dir.0).unwrap().len(), 1);
    }

    #[test]
    fn invalid_backup_does_not_replace_state_or_create_a_pre_restore_copy() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(&state, br#"{"v":"old"}"#).unwrap();
        for (name, data) in [
            ("state.backup-broken.json", "{"),
            ("state.backup-array.json", "[]"),
        ] {
            fs::write(dir.0.join(name), data).unwrap();
            assert!(restore_backup_at(&dir.0, &state, name, 123).is_err());
            assert_eq!(fs::read(&state).unwrap(), br#"{"v":"old"}"#);
        }
        assert!(list_backup_files(&dir.0)
            .unwrap()
            .iter()
            .all(|(path, _, _)| !path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains("pre-restore")));
    }

    #[test]
    fn restores_when_the_current_state_file_is_missing() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(dir.0.join("state.backup-selected.json"), b"{}").unwrap();
        restore_backup_at(&dir.0, &state, "state.backup-selected.json", 123).unwrap();
        assert_eq!(fs::read(&state).unwrap(), b"{}");
        assert_eq!(list_backup_files(&dir.0).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_instead_of_following_them() {
        use std::os::unix::fs::symlink;
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(dir.0.join("actual.json"), b"{}").unwrap();
        symlink("actual.json", &state).unwrap();
        fs::write(dir.0.join("state.backup-selected.json"), br#"{"v":2}"#).unwrap();
        assert!(restore_backup_at(&dir.0, &state, "state.backup-selected.json", 123).is_err());
        assert_eq!(fs::read(dir.0.join("actual.json")).unwrap(), b"{}");
        fs::remove_file(&state).unwrap();
        symlink("actual.json", dir.0.join("state.backup-link.json")).unwrap();
        assert!(restore_backup_at(&dir.0, &state, "state.backup-link.json", 123).is_err());
        assert!(!state.exists());
    }
}

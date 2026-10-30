use super::{data_dir, state_files, state_path};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use tauri::AppHandle;

// Сериализует команды state, копий, контактов и сброса в ЭТОМ процессе.
// Это не транзакция между вызовами IPC; другие процессы, внешние редакторы,
// отложенные записи JS, команды лаунчера и банка кук не охватываются.
static STATE_IO_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn lock_state_io() -> Result<MutexGuard<'static, ()>, String> {
    STATE_IO_LOCK
        .lock()
        .map_err(|_| "Хранилище состояния недоступно после внутренней ошибки".to_string())
}

/// Подготавливает и проверяет отдельный временный файл до замены state.json.
/// Вызывающий обязан удерживать lock_state_io. При ошибке после rename результат
/// считается неизвестным; Windows и сбой питания требуют отдельной проверки.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    state_files::replace_state(path, contents.as_bytes())
}

fn read_state_at(
    path: &Path,
    dir: &Path,
    timestamp: u64,
) -> Result<Option<(Value, String)>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err("Некорректный файл сохранённых данных".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Не удалось проверить сохранённые данные".to_string()),
    }
    let raw = fs::read_to_string(path)
        .map_err(|_| "Не удалось прочитать сохранённые данные".to_string())?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) if value.is_object() => Ok(Some((value, raw))),
        _ => {
            // Сохраняем повреждённые байты без ротации и без перезаписи другой копии.
            // Если копирование не удалось, не обещаем, что резервная копия создана.
            let notice =
                match state_files::create_verified_backup(path, dir, timestamp, "corrupt-load") {
                    Ok(name) => format!("Создана проверенная копия: {}", name),
                    Err(_) => "Не удалось подтвердить резервную копию; исходный файл не заменён"
                        .to_string(),
                };
            Err(format!(
                "Сохранённое состояние повреждено или имеет неверный формат. {}",
                notice
            ))
        }
    }
}

fn load_state_at(path: &Path, dir: &Path, timestamp: u64) -> Result<Option<Value>, String> {
    Ok(read_state_at(path, dir, timestamp)?.map(|(value, _)| value))
}

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Option<Value>, String> {
    let _guard = lock_state_io()?;
    let path = state_path(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "Не удалось определить папку данных".to_string())?;
    load_state_at(&path, dir, super::backup::unix_now())
}

/// Точный JSON остаётся внутри локального процесса/IPC. Его нельзя логировать или
/// отправлять в облако: в старых состояниях он может содержать открытые контакты.
#[tauri::command]
pub fn load_state_raw(app: AppHandle) -> Result<Option<String>, String> {
    let _guard = lock_state_io()?;
    let path = state_path(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "Не удалось определить папку данных".to_string())?;
    Ok(read_state_at(&path, dir, super::backup::unix_now())?.map(|(_, raw)| raw))
}

#[tauri::command]
pub async fn save_state(app: AppHandle, payload: Value) -> Result<(), String> {
    let path = state_path(&app).map_err(state_files::classify_write_error)?;
    let raw = serde_json::to_string_pretty(&payload)
        .map_err(|e| state_files::classify_write_error(e.to_string()))?;
    match tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_state_io()?;
        write_atomic(&path, &raw)
    })
    .await
    {
        Ok(result) => result.map_err(state_files::classify_write_error),
        // The worker may have finished the replacement before its result was lost.
        Err(_) => Err(state_files::uncertain_write_error()),
    }
}

fn save_if_unchanged_at(path: &Path, expected_raw: &str, contents: &str) -> Result<(), String> {
    let expected = serde_json::from_str::<Value>(expected_raw)
        .map_err(|_| "Исходные данные некорректны; миграция остановлена".to_string())?;
    if !expected.is_object() {
        return Err("Исходные данные некорректны; миграция остановлена".to_string());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        _ => return Err("Исходные данные недоступны; миграция остановлена".to_string()),
    }
    let current = fs::read_to_string(path)
        .map_err(|_| "Не удалось проверить исходные данные; миграция остановлена".to_string())?;
    if current != expected_raw {
        return Err("Исходные данные изменились; миграция остановлена".to_string());
    }
    // Lock удерживается вызывающим в пределах этого процесса. Это не атомарный CAS
    // относительно других процессов или внешних редакторов, которые его не соблюдают.
    state_files::replace_state_if_unchanged(path, contents.as_bytes(), expected_raw.as_bytes())
}

#[tauri::command]
pub async fn save_state_if_unchanged(
    app: AppHandle,
    expected_raw: String,
    payload: Value,
) -> Result<(), String> {
    if !payload.is_object() {
        return Err(state_files::classify_write_error(
            "Некорректное новое состояние; миграция остановлена".to_string(),
        ));
    }
    let path = state_path(&app).map_err(state_files::classify_write_error)?;
    let raw = serde_json::to_string_pretty(&payload)
        .map_err(|e| state_files::classify_write_error(e.to_string()))?;
    match tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_state_io()?;
        save_if_unchanged_at(&path, &expected_raw, &raw)
    })
    .await
    {
        Ok(result) => result.map_err(state_files::classify_write_error),
        // Потерянный ответ worker не доказывает, что файл не был заменён.
        Err(_) => Err(state_files::uncertain_write_error()),
    }
}

#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::{load_state_at, read_state_at, save_if_unchanged_at, write_atomic};
    use std::fs;
    use std::path::PathBuf;

    fn test_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tf-load-test-{}-{}", std::process::id(), label));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn invalid_state_is_preserved_and_backed_up_without_rotation() {
        let dir = test_dir("corrupt");
        let path = dir.join("state.json");
        fs::write(&path, b"{broken").unwrap();
        let first = load_state_at(&path, &dir, 42).unwrap_err();
        assert!(first.contains("Создана проверенная копия"));
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        let second = load_state_at(&path, &dir, 42).unwrap_err();
        assert!(second.contains("Создана проверенная копия"));
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|item| item.unwrap().path())
            .filter(|entry| {
                entry
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("state.backup-")
            })
            .collect();
        assert_eq!(backups.len(), 2);
        for backup in backups {
            assert_eq!(fs::read(backup).unwrap(), b"{broken");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_rejects_non_object_json_but_allows_missing_or_object_state() {
        let dir = test_dir("format");
        let path = dir.join("state.json");
        assert!(load_state_at(&path, &dir, 43).unwrap().is_none());
        for raw in ["null", "[]", "17", "\"str\""] {
            fs::write(&path, raw).unwrap();
            assert!(load_state_at(&path, &dir, 43).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), raw);
        }
        fs::write(&path, "{\"characters\":[]}").unwrap();
        assert!(load_state_at(&path, &dir, 43).unwrap().unwrap().is_object());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_does_not_claim_backup_success_when_copy_cannot_be_created() {
        let dir = test_dir("copy-failed");
        let path = dir.join("state.json");
        fs::write(&path, b"invalid").unwrap();
        let error = load_state_at(&path, &dir.join("missing"), 44).unwrap_err();
        assert!(error.contains("Не удалось подтвердить резервную копию"));
        assert_eq!(fs::read(&path).unwrap(), b"invalid");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn load_does_not_follow_state_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = test_dir("symlink");
        let target = dir.join("target.json");
        let path = dir.join("state.json");
        fs::write(&target, "{}").unwrap();
        symlink(&target, &path).unwrap();
        assert!(load_state_at(&path, &dir, 45).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "{}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn raw_load_preserves_exact_bytes_for_migration() {
        let dir = test_dir("raw");
        let path = dir.join("state.json");
        let source = "{\n  \"schemaVersion\": 9, \"name\": \"Герой\"\n}";
        fs::write(&path, source).unwrap();
        let (parsed, raw) = read_state_at(&path, &dir, 46).unwrap().unwrap();
        assert!(parsed.is_object());
        assert_eq!(raw, source);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migration_save_rejects_stale_missing_or_non_object_source() {
        let dir = test_dir("conditional");
        let path = dir.join("state.json");
        let before = "{ \"schemaVersion\": 9 }";
        let changed = "{\"schemaVersion\":9}";
        fs::write(&path, changed).unwrap();
        assert!(save_if_unchanged_at(&path, before, "{\"schemaVersion\":10}").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), changed);
        assert!(save_if_unchanged_at(&path, "[]", "{}").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), changed);
        save_if_unchanged_at(&path, changed, "{\"schemaVersion\":10}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"schemaVersion\":10}");
        fs::remove_file(&path).unwrap();
        assert!(save_if_unchanged_at(&path, changed, "{}").is_err());
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_write_replaces_file() {
        let dir = std::env::temp_dir().join(format!("tf-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        write_atomic(&path, "{\"a\":1}").unwrap();
        write_atomic(&path, "{\"a\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}

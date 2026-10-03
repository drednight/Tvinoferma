use super::state::write_atomic;
use super::{data_dir, state_path};
use serde::Serialize;
use std::fs;
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
    files.sort_by(|a, b| b.1.cmp(&a.1)); // новые сверху
    Ok(files)
}

fn prune_backups(dir: &Path, max_count: usize) -> Result<(), String> {
    for (path, _, _) in list_backup_files(dir)?.into_iter().skip(max_count.max(1)) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

pub fn create_backup_file(
    app: &AppHandle,
    max_count: Option<usize>,
    label: Option<String>,
) -> Result<String, String> {
    let dir = data_dir(app)?;
    let state = state_path(app)?;
    if !state.exists() {
        return Err("state.json not found".to_string());
    }
    let suffix = label
        .map(|l| sanitize_label(&l))
        .filter(|l| !l.is_empty())
        .map(|l| format!("-{}", l))
        .unwrap_or_default();
    let mut file_name = format!("state.backup-{}{}.json", unix_now(), suffix);
    let mut n = 1;
    while dir.join(&file_name).exists() {
        file_name = format!("state.backup-{}{}-{}.json", unix_now(), suffix, n);
        n += 1;
    }
    fs::copy(&state, dir.join(&file_name)).map_err(|e| e.to_string())?;
    prune_backups(&dir, max_count.unwrap_or(10))?;
    Ok(file_name)
}

#[tauri::command]
pub fn create_backup(
    app: AppHandle,
    max_count: Option<usize>,
    label: Option<String>,
) -> Result<String, String> {
    create_backup_file(&app, max_count, label)
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
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

#[tauri::command]
pub fn restore_backup(app: AppHandle, file_name: String) -> Result<(), String> {
    if !is_valid_backup_name(&file_name) {
        return Err("Invalid backup name".to_string());
    }
    let backup_path = data_dir(&app)?.join(&file_name);
    if !backup_path.exists() {
        return Err("Backup not found".to_string());
    }
    let raw = fs::read_to_string(&backup_path).map_err(|e| e.to_string())?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("Бэкап повреждён: {}", e))?;
    // Текущее состояние тоже сохраняем — восстановление можно откатить
    let _ = create_backup_file(&app, Some(50), Some("pre-restore".into()));
    write_atomic(&state_path(&app)?, &raw)
}

#[tauri::command]
pub fn delete_backup(app: AppHandle, file_name: String) -> Result<(), String> {
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
}

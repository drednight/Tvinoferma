use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("state.json"))
}

fn is_valid_backup_name(name: &str) -> bool {
    !name.contains('/')
        && !name.contains('\\')
        && name.starts_with("state.backup-")
        && name.ends_with(".json")
}

fn list_backup_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();

    if !dir.exists() {
        return Ok(files);
    }

    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };

        if is_valid_backup_name(file_name) {
            files.push(path);
        }
    }

    files.sort_by(|a, b| {
        let a_name = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let b_name = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
        b_name.cmp(a_name)
    });

    Ok(files)
}

fn prune_backups(dir: &Path, max_count: usize) -> Result<(), String> {
    let files = list_backup_files(dir)?;

    if files.len() <= max_count {
        return Ok(());
    }

    for path in files.iter().skip(max_count) {
        let _ = fs::remove_file(path);
    }

    Ok(())
}

#[tauri::command]
pub fn create_backup(app: AppHandle) -> Result<String, String> {
    let dir = data_dir(&app)?;
    let state = state_path(&app)?;

    if !state.exists() {
        return Err("state.json not found".to_string());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();

    let file_name = format!("state.backup-{}.json", timestamp);
    let backup_path = dir.join(&file_name);

    fs::copy(&state, &backup_path).map_err(|e| e.to_string())?;
    prune_backups(&dir, 10)?;

    Ok(file_name)
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = data_dir(&app)?;
    let files = list_backup_files(&dir)?;

    Ok(files
        .into_iter()
        .filter_map(|path| path.file_name().and_then(|n| n.to_str()).map(String::from))
        .collect())
}

#[tauri::command]
pub fn restore_backup(app: AppHandle, file_name: String) -> Result<(), String> {
    if !is_valid_backup_name(&file_name) {
        return Err("Invalid backup name".to_string());
    }

    let dir = data_dir(&app)?;
    let backup_path = dir.join(&file_name);
    let state = state_path(&app)?;

    if !backup_path.exists() {
        return Err("Backup not found".to_string());
    }

    fs::copy(&backup_path, &state).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_backup(app: AppHandle, file_name: String) -> Result<(), String> {
    if !is_valid_backup_name(&file_name) {
        return Err("Invalid backup name".to_string());
    }

    let dir = data_dir(&app)?;
    let backup_path = dir.join(&file_name);

    if backup_path.exists() {
        fs::remove_file(backup_path).map_err(|e| e.to_string())?;
    }

    Ok(())
}
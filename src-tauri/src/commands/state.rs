use serde_json::Value;
use std::fs;
use std::path::PathBuf;
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

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Option<Value>, String> {
    let path = state_path(&app)?;

    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    Ok(Some(value))
}

#[tauri::command]
pub fn save_state(app: AppHandle, payload: Value) -> Result<(), String> {
    let path = state_path(&app)?;
    let raw = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> Result<String, String> {
    let dir = data_dir(&app)?;
    Ok(dir.display().to_string())
}
use super::{data_dir, state_path};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::Path;
use tauri::AppHandle;

/// Атомарная запись: пишем во временный файл, сбрасываем на диск и переименовываем.
/// Падение приложения во время записи больше не может оставить «обрезанный» state.json.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Option<Value>, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match serde_json::from_str(&raw) {
        Ok(value) => Ok(Some(value)),
        Err(e) => {
            // Повреждённый файл не перезаписываем молча — откладываем в сторону для ручного восстановления
            let broken = path.with_extension(format!("broken-{}.json", super::backup::unix_now()));
            let _ = fs::copy(&path, &broken);
            Err(format!("state.json повреждён ({}). Копия: {}", e, broken.display()))
        }
    }
}

#[tauri::command]
pub async fn save_state(app: AppHandle, payload: Value) -> Result<(), String> {
    let path = state_path(&app)?;
    let raw = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || write_atomic(&path, &raw))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::write_atomic;

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

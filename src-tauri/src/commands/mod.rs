//! Команды хранилища: state.json, резервные копии, учётные данные в keychain ОС.

pub mod backup;
pub mod factory_reset;
pub mod secrets;
pub mod state;

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Папка данных приложения: `<AppData>/com.tvinoferma.desktop/tvinoferma_data`
/// (та же, что раньше использовал фронтенд через plugin-fs, — данные не теряются).
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tvinoferma_data");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("state.json"))
}

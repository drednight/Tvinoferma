//! Команды модуля «Layout»: выбор папки и файла, просмотр списка, копирование образца, снятие «только для чтения».
//! Работа с файлами — в `crate::layout_sync`.

use super::data_dir;
use crate::layout_sync::{self, ApplyReport, ScanReport};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[cfg(windows)]
const PICK_FOLDER_SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Укажите папку Layout'
$dlg.ShowNewFolderButton = $false
if ($env:TF_INITIAL -and (Test-Path -LiteralPath $env:TF_INITIAL -PathType Container)) { $dlg.SelectedPath = $env:TF_INITIAL }
if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }
$owner.Dispose()
"#;

#[cfg(windows)]
const PICK_FILE_SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = 'Выберите свой файл layout'
$dlg.Filter = 'Файлы layout (*.ini)|*.ini'
$dlg.CheckFileExists = $true
if ($env:TF_INITIAL -and (Test-Path -LiteralPath $env:TF_INITIAL -PathType Container)) { $dlg.InitialDirectory = $env:TF_INITIAL }
if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }
$owner.Dispose()
"#;

#[cfg(windows)]
async fn run_picker(
    script: &'static str,
    initial: Option<String>,
) -> Result<Option<String>, String> {
    use std::process::Command;
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
        if let Some(dir) = initial {
            cmd.env("TF_INITIAL", dir);
        }
        crate::launcher::hidden(&mut cmd)
            .output()
            .map_err(|e| format!("powershell: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    let text = String::from_utf8_lossy(&out.stdout);
    let path = text.trim_matches(|c: char| c == '\u{feff}' || c.is_whitespace());
    Ok((!path.is_empty()).then(|| path.to_string()))
}

/// Проводник: выбор папки Layout. `None` — окно закрыли без выбора.
#[tauri::command]
pub async fn layout_pick_folder(initial: Option<String>) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        run_picker(PICK_FOLDER_SCRIPT, initial).await
    }
    #[cfg(not(windows))]
    {
        let _ = initial;
        Err("Выбор папки доступен только в Windows".to_string())
    }
}

/// Проводник: выбор своего файла layout (`.ini`). `initial` — папка, с которой начать.
#[tauri::command]
pub async fn layout_pick_file(initial: Option<String>) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        run_picker(PICK_FILE_SCRIPT, initial).await
    }
    #[cfg(not(windows))]
    {
        let _ = initial;
        Err("Выбор файла доступен только в Windows".to_string())
    }
}

fn opt_path(s: &Option<String>) -> Option<PathBuf> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Что будет заменено в папке. Ничего не меняет.
#[tauri::command]
pub async fn layout_scan(dir: String, template: Option<String>) -> Result<ScanReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        layout_sync::scan(Path::new(dir.trim()), opt_path(&template).as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Копирует образец поверх остальных `.ini` в папке и ставит «только для чтения».
/// Прежние файлы сохраняются в `<данные приложения>/layout_backups/<время>/`.
#[tauri::command]
pub async fn layout_apply(
    app: AppHandle,
    dir: String,
    template: String,
) -> Result<ApplyReport, String> {
    let backups = data_dir(&app)?.join("layout_backups");
    tauri::async_runtime::spawn_blocking(move || {
        layout_sync::apply(
            Path::new(dir.trim()),
            Path::new(template.trim()),
            Some(&backups),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Снимает «только для чтения» с файлов layout (чтобы игра снова могла сохранять свою раскладку).
#[tauri::command]
pub async fn layout_unlock(dir: String, template: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        layout_sync::unlock(Path::new(dir.trim()), opt_path(&template).as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

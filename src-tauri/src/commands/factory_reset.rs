//! «Вернуть к заводским настройкам»: полное удаление данных приложения.
//!
//! Что удаляется:
//! - `state.json` вместе со всеми резервными копиями;
//! - банк кук (сессии персонажей на pwonline.ru) и его ключ шифрования в хранилище ОС;
//! - профили браузера персонажей (`pw-sync-profiles`) — там куки входа;
//! - записи в хранилище учётных данных ОС: контакты персонажей, запомненные входы GameCenter
//!   и известные локальные части экспериментального облачного подключения.
//!
//! Облачные файлы и разрешение OAuth у провайдера не удаляются и не отзываются.
//!
//! Имена ключей контактов и входов приходят из интерфейса раздельно. Неизвестные
//! или забытые записи в хранилище ОС могут остаться: перечислить их здесь нельзя.
//! Отдельные журналы WebView эта команда не удаляет.

use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Manager};

/// Служба хранилища учётных данных ОС (та же, что у контактов персонажей).
const SERVICE: &str = "com.tvinoferma.desktop";
/// Записи контактов и входов лаунчера находятся в разных пространствах имён.
const CONTACTS_PREFIX: &str = "contacts";
const ACCOUNT_PREFIX: &str = "gc-magic";
/// Ключ шифрования банка кук (см. `cookie_bank.rs`).
const COOKIE_BANK_KEY: &str = "cookie-bank-key";

/// Что удалось удалить. Используется в итоговом сообщении.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FactoryResetReport {
    /// Удалён ли state.json
    pub state_removed: bool,
    /// Сколько резервных копий удалено
    pub backups_removed: u32,
    /// Удалена ли папка с сессиями (банк кук)
    pub sessions_removed: bool,
    /// Удалена ли папка профилей браузера персонажей
    pub profiles_removed: bool,
    /// Сколько записей удалено из хранилища учётных данных ОС
    pub secrets_removed: u32,
    /// Что не удалось удалить (для сообщения пользователю)
    pub problems: Vec<String>,
    /// Готовый текст итога для интерфейса (чтобы формулировка была одна на обе стороны)
    pub message: String,
}

/// Удаляет каталог, но не следует по символической ссылке. Ошибки проверки не
/// маскируются как отсутствие каталога.
fn remove_dir(path: &std::path::Path, what: &str, problems: &mut Vec<String>) -> bool {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(e) => {
            problems.push(format!("{}: {}", what, e));
            return false;
        }
        Ok(meta) if !meta.file_type().is_dir() => {
            problems.push(format!("{}: неподходящий тип", what));
            return false;
        }
        Ok(_) => {}
    }
    match fs::remove_dir_all(path) {
        Ok(()) => true,
        Err(e) => {
            problems.push(format!("{}: {}", what, e));
            false
        }
    }
}

/// Составляем полный список до первого удаления. Ошибка обхода или ссылка с
/// именем копии не означает, что резервных файлов нет.
fn backup_files(dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    match fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Не удалось проверить папку данных перед сбросом".into()),
        Ok(meta) if !meta.file_type().is_dir() => {
            return Err("Некорректный тип папки данных; сброс остановлен".into());
        }
        Ok(_) => {}
    }
    let entries =
        fs::read_dir(dir).map_err(|_| "Не удалось проверить резервные копии".to_string())?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "Не удалось проверить резервные копии".to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !(name.starts_with("state.backup-") || name.starts_with("backup-"))
            || !name.ends_with(".json")
        {
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|_| "Не удалось проверить тип копии".to_string())?;
        if !kind.is_file() {
            return Err("Некорректный тип резервной копии; сброс остановлен".into());
        }
        result.push(entry.path());
    }
    Ok(result)
}

/// Проверяем тип state.json до удаления хотя бы одной резервной копии.
fn state_file(dir: &std::path::Path) -> Result<Option<std::path::PathBuf>, String> {
    let path = dir.join("state.json");
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Не удалось проверить сохранённые данные перед сбросом".into()),
        Ok(meta) if meta.file_type().is_file() => Ok(Some(path)),
        Ok(_) => Err("Некорректный тип state.json; сброс остановлен".into()),
    }
}

/// Сверка с точной строкой, прочитанной после ожидания очереди JS. Это не CAS
/// относительно других процессов и не доказывает, что память совпадает с файлом.
fn matches_witness(path: Option<&std::path::Path>, expected: Option<&str>) -> Result<(), String> {
    match (path, expected) {
        (None, None) => Ok(()),
        (Some(path), Some(expected)) => {
            let current = fs::read_to_string(path)
                .map_err(|_| "Не удалось проверить исходный файл; сброс остановлен".to_string())?;
            if current == expected {
                Ok(())
            } else {
                Err("Исходный файл изменился; сброс остановлен".into())
            }
        }
        _ => Err("Исходный файл изменился; сброс остановлен".into()),
    }
}

fn valid_keys(keys: &[String]) -> bool {
    keys.len() <= 100_000
        && keys
            .iter()
            .all(|key| !key.trim().is_empty() && key.len() <= 1024 && !key.contains('\0'))
}

fn remove_credentials(
    prefix: &str,
    mut keys: Vec<String>,
    report: &mut FactoryResetReport,
    problems: &mut Vec<String>,
) {
    keys.sort();
    keys.dedup();
    for key in keys {
        let entry = match keyring::Entry::new(SERVICE, &format!("{}:{}", prefix, key)) {
            Ok(entry) => entry,
            Err(_) => {
                problems.push(format!(
                    "хранилище ОС ({}): не удалось открыть запись",
                    prefix
                ));
                continue;
            }
        };
        match entry.delete_credential() {
            Ok(()) => report.secrets_removed += 1,
            Err(keyring::Error::NoEntry) => {}
            Err(_) => problems.push(format!(
                "хранилище ОС ({}): не удалось удалить запись",
                prefix
            )),
        }
    }
}

/// Полный сброс данных приложения.
///
/// `keys` — известные имена контактов, `account_keys` — имена входов GameCenter.
/// `expected_raw` — точный прочитанный state.json, не выводится в журнал.
/// Списки собираются до сброса; неизвестные и забытые ключи в ОС могут остаться.
#[tauri::command]
pub async fn factory_reset(
    app: AppHandle,
    keys: Vec<String>,
    account_keys: Vec<String>,
    expected_raw: Option<String>,
) -> Result<FactoryResetReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Только один процесс: это не блокировка других процессов и не транзакция
        // всей последовательности IPC, cookie-bank или команд лаунчера.
        let _guard = super::state::lock_state_io()?;
        if !valid_keys(&keys) || !valid_keys(&account_keys) {
            return Err("Не удалось проверить список ключей; сброс остановлен".into());
        }
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "Не удалось определить папку данных".to_string())?;
        let data_dir = app_dir.join("tvinoferma_data");
        let backups = backup_files(&data_dir)?;
        let state = state_file(&data_dir)?;
        matches_witness(state.as_deref(), expected_raw.as_deref())?;
        let mut report = FactoryResetReport::default();
        let mut problems = Vec::new();

        // 1. Резервные копии и state.json
        for path in backups {
            match fs::remove_file(&path) {
                Ok(()) => report.backups_removed += 1,
                Err(e) => problems.push(format!("резервная копия: {}", e)),
            }
        }
        if let Some(state) = state {
            match fs::remove_file(&state) {
                Ok(()) => report.state_removed = true,
                Err(e) => problems.push(format!("state.json: {}", e)),
            }
        }

        // 2. Сессии (банк кук) и профили браузера персонажей
        report.sessions_removed =
            remove_dir(&app_dir.join("cookie-bank"), "папка сессий", &mut problems);
        report.profiles_removed = remove_dir(
            &app_dir.join("pw-sync-profiles"),
            "профили браузера",
            &mut problems,
        );

        // 3. Контакты и входы GameCenter имеют разные префиксы. Удаляем только
        // известные имена; хранилище ОС не предоставляет полного списка записей.
        remove_credentials(CONTACTS_PREFIX, keys, &mut report, &mut problems);
        remove_credentials(ACCOUNT_PREFIX, account_keys, &mut report, &mut problems);

        // Известные части локальных облачных подключений имеют фиксированные
        // имена и собственный межпроцессный lock. Это не удаляет файлы в облаке
        // и не отзывает выданное провайдером разрешение.
        if super::cloud_credentials::cleanup_for_reset(&app_dir).is_err() {
            problems.push(
                "локальный доступ к облаку: не удалось проверить или удалить все записи".into(),
            );
        }
        if super::cloud_outbox::cleanup_for_reset(&app_dir).is_err() {
            problems
                .push("локальная очередь облака: не удалось удалить все известные части".into());
        }

        match keyring::Entry::new(SERVICE, COOKIE_BANK_KEY) {
            Ok(entry) => match entry.delete_credential() {
                Ok(()) => report.secrets_removed += 1,
                Err(keyring::Error::NoEntry) => {}
                Err(_) => problems.push("ключ банка кук: не удалось удалить".into()),
            },
            Err(_) => problems.push("ключ банка кук: не удалось открыть запись".into()),
        }

        report.problems = problems;
        report.message = factory_reset_text(&report);
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Текст итога сброса. Собирается здесь, чтобы формулировка была одна и та же и в приложении, и в тестах.
pub fn factory_reset_text(report: &FactoryResetReport) -> String {
    let mut parts = vec!["Удаление известных локальных данных завершено".to_string()];
    if report.backups_removed > 0 {
        parts.push(format!("удалено копий: {}", report.backups_removed));
    }
    if report.problems.is_empty() {
        return parts.join(", ");
    }
    parts.push(format!("не всё удалось: {}", report.problems.join("; ")));
    parts.join(". ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_backup_files_only() {
        let dir = std::env::temp_dir().join(format!("tf-reset-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("state.json"), "{}").unwrap();
        fs::write(dir.join("state.backup-1.json"), "{}").unwrap();
        fs::write(dir.join("backup-2026.json"), "{}").unwrap();
        fs::write(dir.join("notes.txt"), "x").unwrap();

        let found = backup_files(&dir).unwrap();
        assert_eq!(
            found.len(),
            2,
            "state.json и посторонние файлы копиями не считаются"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn suspicious_backup_and_state_types_are_rejected_before_deletion() {
        let dir = std::env::temp_dir().join(format!("tf-reset-bad-type-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("state.backup-directory.json")).unwrap();
        fs::write(dir.join("state.json"), "private").unwrap();
        assert!(backup_files(&dir).is_err());
        assert_eq!(
            fs::read_to_string(dir.join("state.json")).unwrap(),
            "private"
        );
        fs::remove_dir_all(dir.join("state.backup-directory.json")).unwrap();
        fs::remove_file(dir.join("state.json")).unwrap();
        fs::create_dir(dir.join("state.json")).unwrap();
        assert!(state_file(&dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn witness_detects_changed_disappeared_or_new_state() {
        let dir = std::env::temp_dir().join(format!("tf-reset-witness-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        fs::write(&path, "{\"secret\":\"PRIVATE\"}").unwrap();
        let found = state_file(&dir).unwrap();
        assert!(matches_witness(found.as_deref(), Some("{\"secret\":\"PRIVATE\"}")).is_ok());
        assert!(matches_witness(found.as_deref(), Some("{\"secret\":\"older\"}")).is_err());
        assert!(matches_witness(found.as_deref(), None).is_err());
        assert!(matches_witness(None, Some("before")).is_err());
        assert!(matches_witness(None, None).is_ok());
        fs::remove_file(&path).unwrap();
        assert!(matches_witness(found.as_deref(), Some("{\"secret\":\"PRIVATE\"}")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_key_names_are_rejected_before_deletion() {
        assert!(valid_keys(&["hero".into(), "hero@gc-1".into()]));
        assert!(!valid_keys(&[" ".into()]));
        assert!(!valid_keys(&["a\0b".into()]));
        assert!(!valid_keys(&["a".repeat(1025)]));
    }

    #[test]
    fn missing_dir_is_not_an_error() {
        let mut problems = Vec::new();
        let missing = std::env::temp_dir().join("tf-reset-нет-такой-папки");
        assert!(!remove_dir(&missing, "папка", &mut problems));
        assert!(problems.is_empty(), "отсутствие папки — не ошибка");
    }

    #[test]
    fn removes_directory_with_content() {
        let dir = std::env::temp_dir().join(format!("tf-reset-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("inner")).unwrap();
        fs::write(dir.join("inner").join("cookie.bin"), "x").unwrap();
        let mut problems = Vec::new();
        assert!(remove_dir(&dir, "папка", &mut problems));
        assert!(!dir.exists());
        assert!(problems.is_empty());
    }

    #[test]
    fn report_text_mentions_problems() {
        let ok = FactoryResetReport {
            backups_removed: 2,
            ..Default::default()
        };
        assert_eq!(
            factory_reset_text(&ok),
            "Удаление известных локальных данных завершено, удалено копий: 2"
        );
        let bad = FactoryResetReport {
            problems: vec!["state.json: доступ запрещён".into()],
            ..Default::default()
        };
        assert!(factory_reset_text(&bad).contains("не всё удалось"));
        assert!(factory_reset_text(&bad).contains("доступ запрещён"));
    }
}

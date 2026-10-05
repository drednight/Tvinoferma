//! «Вернуть к заводским настройкам»: полное удаление данных приложения.
//!
//! Что удаляется:
//! - `state.json` вместе со всеми резервными копиями;
//! - банк кук (сессии персонажей на pwonline.ru) и его ключ шифрования в хранилище ОС;
//! - профили браузера персонажей (`pw-sync-profiles`) — там куки входа;
//! - записи в хранилище учётных данных ОС: контакты персонажей и запомненные входы GameCenter.
//!
//! Ключи хранилища ОС перечисляются заранее (`keys` приходят из интерфейса) — прочитать их оттуда
//! без знания имён нельзя. Поэтому удаление идёт по списку, а не «очистить всё хранилище»:
//! чужие записи приложения не трогаются.
//!
//! Папка данных после сброса остаётся пустой: приложение при следующем запуске создаст её заново.

use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Manager};

/// Служба хранилища учётных данных ОС (та же, что у контактов персонажей).
const SERVICE: &str = "com.tvinoferma.desktop";
/// Префикс ключей контактов персонажа и входов GameCenter.
const CONTACTS_PREFIX: &str = "contacts";
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

/// Удаляет папку со всем содержимым. Отсутствие папки ошибкой не считается.
fn remove_dir(path: &std::path::Path, what: &str, problems: &mut Vec<String>) -> bool {
    if !path.exists() {
        return false;
    }
    match fs::remove_dir_all(path) {
        Ok(()) => true,
        Err(e) => {
            problems.push(format!("{}: {}", what, e));
            false
        }
    }
}

/// Сколько файлов резервных копий лежит в папке данных.
fn backup_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| {
                        (n.starts_with("state.backup-") || n.starts_with("backup-"))
                            && n.ends_with(".json")
                    })
                    .unwrap_or(false)
        })
        .collect()
}

/// Полный сброс данных приложения.
///
/// `keys` — ключи хранилища учётных данных ОС, которые нужно удалить (контакты персонажей и входы GameCenter).
/// Интерфейс собирает их из `state.json` до сброса: после удаления файла узнать имена уже нельзя.
#[tauri::command]
pub async fn factory_reset(
    app: AppHandle,
    keys: Vec<String>,
) -> Result<FactoryResetReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = FactoryResetReport::default();
        let mut problems = Vec::new();

        let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let data_dir = app_dir.join("tvinoferma_data");

        // 1. Резервные копии и state.json
        for path in backup_files(&data_dir) {
            match fs::remove_file(&path) {
                Ok(()) => report.backups_removed += 1,
                Err(e) => problems.push(format!("резервная копия: {}", e)),
            }
        }
        let state = data_dir.join("state.json");
        if state.exists() {
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

        // 3. Записи хранилища ОС. Контакты персонажей и входы GameCenter лежат под префиксом «contacts:»,
        //    а ключ шифрования банка кук — под отдельным именем (см. cookie_bank.rs), поэтому он удаляется ниже.
        let mut all_keys = keys;
        all_keys.sort();
        all_keys.dedup();
        for key in all_keys {
            if key.trim().is_empty() {
                continue;
            }
            let entry = match keyring::Entry::new(SERVICE, &format!("{}:{}", CONTACTS_PREFIX, key))
            {
                Ok(e) => e,
                Err(e) => {
                    problems.push(format!("хранилище ОС ({}): {}", key, e));
                    continue;
                }
            };
            match entry.delete_credential() {
                Ok(()) => report.secrets_removed += 1,
                Err(keyring::Error::NoEntry) => {}
                Err(e) => problems.push(format!("хранилище ОС ({}): {}", key, e)),
            }
        }

        // Ключ банка кук: без него оставшиеся файлы сессий бесполезны, но сброс должен быть полным
        if let Ok(e) = keyring::Entry::new(SERVICE, COOKIE_BANK_KEY) {
            match e.delete_credential() {
                Ok(()) => report.secrets_removed += 1,
                Err(keyring::Error::NoEntry) => {}
                Err(err) => problems.push(format!("ключ банка кук: {}", err)),
            }
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
    let mut parts = vec!["Приложение возвращено к заводским настройкам".to_string()];
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

        let found = backup_files(&dir);
        assert_eq!(
            found.len(),
            2,
            "state.json и посторонние файлы копиями не считаются"
        );
        let _ = fs::remove_dir_all(&dir);
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
            "Приложение возвращено к заводским настройкам, удалено копий: 2"
        );
        let bad = FactoryResetReport {
            problems: vec!["state.json: доступ запрещён".into()],
            ..Default::default()
        };
        assert!(factory_reset_text(&bad).contains("не всё удалось"));
        assert!(factory_reset_text(&bad).contains("доступ запрещён"));
    }
}

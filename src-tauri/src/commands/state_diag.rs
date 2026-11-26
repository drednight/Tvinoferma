//! Диагностика потери данных в state.json: счётчики без значений и журнал «падений».
//!
//! В журнал попадают только числа (сколько персонажей, у скольких заполнены email, пароль и
//! запомненный вход GameCenter) и время. Логины, пароли, ники и ссылки сюда не попадают.
//! Строка в журнале означает лишь «счётчик стал меньше, чем был»: удаление персонажа или
//! очистка пароля тоже дадут строку. Ошибка записи журнала никогда не мешает сохранению state.
//!
//! Базовая линия хранится в двух местах: в памяти процесса (быстрый путь) и в файле
//! `state-diag-baseline.json` рядом со state.json (только счётчики) — чтобы падение,
//! случившееся, пока приложение было закрыто (внешняя перезапись файла), тоже дало строку
//! при следующей загрузке. Удалите файл, чтобы «начать историю заново».
//! Известные ложные строки: восстановление из резервной копии и применение состояния из
//! облачного outbox могут уменьшить счётчики — это не порча, чтение строки требует контекста.

use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

const DIAG_FILE: &str = "state-diag.log";
const DIAG_ROTATED: &str = "state-diag.log.1";
const DIAG_MAX_BYTES: u64 = 64 * 1024;
const DIAG_BASELINE: &str = "state-diag-baseline.json";

/// Сводка состояния: только количества, без самих значений.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StateSummary {
    pub characters: u32,
    pub with_email: u32,
    pub with_password: u32,
    pub with_gc_accounts: u32,
}

impl StateSummary {
    fn describe(&self) -> String {
        format!(
            "characters={} email={} password={} gcAccounts={}",
            self.characters, self.with_email, self.with_password, self.with_gc_accounts
        )
    }
}

// Последняя известная сводка в ЭТОМ процессе: прочитанная с диска или записанная приложением.
static LAST_SUMMARY: Mutex<Option<StateSummary>> = Mutex::new(None);

fn filled(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
}

/// Считает персонажей и заполненные поля. Неожиданная форма данных не вызывает ошибку.
pub fn summarize(state: &Value) -> StateSummary {
    let mut summary = StateSummary::default();
    let Some(list) = state.get("characters").and_then(Value::as_array) else {
        return summary;
    };
    for character in list {
        summary.characters += 1;
        let contacts = character.get("contacts");
        if filled(contacts.and_then(|value| value.get("email"))) {
            summary.with_email += 1;
        }
        if filled(contacts.and_then(|value| value.get("password"))) {
            summary.with_password += 1;
        }
        let has_gc_accounts = character
            .get("launch")
            .and_then(|value| value.get("gcAccounts"))
            .and_then(Value::as_object)
            .is_some_and(|map| !map.is_empty());
        if has_gc_accounts {
            summary.with_gc_accounts += 1;
        }
    }
    summary
}

/// Какие счётчики стали меньше, чем были.
pub fn dropped_fields(before: StateSummary, after: StateSummary) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if after.characters < before.characters {
        fields.push("characters");
    }
    if after.with_email < before.with_email {
        fields.push("email");
    }
    if after.with_password < before.with_password {
        fields.push("password");
    }
    if after.with_gc_accounts < before.with_gc_accounts {
        fields.push("gcAccounts");
    }
    fields
}

/// Читает базовую линию прошлого сеанса. Любая ошибка формата — "линии нет".
fn load_baseline(dir: &Path) -> Option<StateSummary> {
    let raw = fs::read_to_string(dir.join(DIAG_BASELINE)).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    Some(StateSummary {
        characters: value.get("characters")?.as_u64()?.min(u64::from(u32::MAX)) as u32,
        with_email: value.get("withEmail")?.as_u64()?.min(u64::from(u32::MAX)) as u32,
        with_password: value
            .get("withPassword")?
            .as_u64()?
            .min(u64::from(u32::MAX)) as u32,
        with_gc_accounts: value
            .get("withGcAccounts")?
            .as_u64()?
            .min(u64::from(u32::MAX)) as u32,
    })
}

/// Перезаписывает базовую линию текущей сводкой. Ошибка записи ничего не ломает.
fn store_baseline(dir: &Path, summary: &StateSummary) {
    let line = serde_json::json!({
        "characters": summary.characters,
        "withEmail": summary.with_email,
        "withPassword": summary.with_password,
        "withGcAccounts": summary.with_gc_accounts,
    });
    let _ = fs::write(dir.join(DIAG_BASELINE), line.to_string());
}

/// Добавляет строку в журнал; при превышении размера старый журнал уходит в `.1`.
fn append_line(dir: &Path, line: &str) {
    let path = dir.join(DIAG_FILE);
    let too_big = fs::metadata(&path)
        .map(|meta| meta.len() > DIAG_MAX_BYTES)
        .unwrap_or(false);
    if too_big {
        let _ = fs::rename(&path, dir.join(DIAG_ROTATED));
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{}", line);
    }
}

/// Запоминает сводку и, если какой-то счётчик упал относительно прошлой, пишет строку в журнал.
/// `event`: `save` — запись из приложения; `load` — чтение файла. Падение между последней
/// записью и новым чтением значит, что файл изменили не через сохранение приложения.
/// Вызывающий держит `lock_state_io`, поэтому порядок записей и чтений не перемешивается.
pub fn record(dir: &Path, event: &str, timestamp: u64, state: &Value) {
    let after = summarize(state);
    let before = match LAST_SUMMARY.lock() {
        Ok(mut slot) => slot.replace(after).or_else(|| load_baseline(dir)),
        Err(_) => return,
    };
    let Some(before) = before else {
        store_baseline(dir, &after);
        return;
    };
    let dropped = dropped_fields(before, after);
    if !dropped.is_empty() {
        let line = format!(
            "{} {} dropped=[{}] before=({}) after=({})",
            timestamp,
            event,
            dropped.join(","),
            before.describe(),
            after.describe()
        );
        append_line(dir, &line);
    }
    store_baseline(dir, &after);
}

#[cfg(test)]
fn reset_memory_for_tests() {
    if let Ok(mut slot) = LAST_SUMMARY.lock() {
        *slot = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_line, dropped_fields, record, reset_memory_for_tests, summarize, StateSummary,
        DIAG_BASELINE, DIAG_FILE, DIAG_MAX_BYTES, DIAG_ROTATED,
    };
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;

    // Оба теста, трогающие общую «последнюю сводку» процесса, выполняются по очереди.
    static RECORD_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn test_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tf-diag-test-{}-{}", std::process::id(), label));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn summarize_counts_filled_fields_only() {
        let state = json!({
            "characters": [
                {
                    "contacts": { "email": "a@example.test", "password": "secret" },
                    "launch": { "gcAccounts": { "1": { "nick": "Nick" } } }
                },
                { "contacts": { "email": "  ", "password": "" }, "launch": { "gcAccounts": {} } },
                {}
            ]
        });
        assert_eq!(
            summarize(&state),
            StateSummary {
                characters: 3,
                with_email: 1,
                with_password: 1,
                with_gc_accounts: 1,
            }
        );
    }

    #[test]
    fn summarize_tolerates_unexpected_shapes() {
        assert_eq!(summarize(&json!({})), StateSummary::default());
        assert_eq!(
            summarize(&json!({ "characters": 5 })),
            StateSummary::default()
        );
        assert_eq!(summarize(&json!([1, 2])), StateSummary::default());
    }

    #[test]
    fn dropped_fields_lists_only_decreases() {
        let before = StateSummary {
            characters: 4,
            with_email: 4,
            with_password: 3,
            with_gc_accounts: 2,
        };
        let after = StateSummary {
            characters: 4,
            with_email: 2,
            with_password: 3,
            with_gc_accounts: 0,
        };
        assert_eq!(dropped_fields(before, after), vec!["email", "gcAccounts"]);
        assert!(dropped_fields(after, before).is_empty());
    }

    #[test]
    fn append_line_rotates_a_large_log() {
        let dir = test_dir("rotate");
        let path = dir.join(DIAG_FILE);
        fs::write(&path, vec![b'x'; DIAG_MAX_BYTES as usize + 1]).unwrap();
        append_line(&dir, "fresh");
        assert_eq!(fs::read_to_string(&path).unwrap(), "fresh\n");
        assert_eq!(
            fs::metadata(dir.join(DIAG_ROTATED)).unwrap().len(),
            DIAG_MAX_BYTES + 1
        );
        let _ = fs::remove_dir_all(dir);
    }

    // Тесты, трогающие общую «последнюю сводку» процесса, сбрасывают её в начале.
    #[test]
    fn record_logs_drops_without_any_values() {
        let _guard = RECORD_TEST_LOCK.lock().unwrap();
        reset_memory_for_tests();
        let dir = test_dir("record");
        let full = json!({
            "characters": [{
                "contacts": { "email": "private@example.test", "password": "hunter2" },
                "launch": { "gcAccounts": { "7": { "nick": "PrivateNick" } } }
            }]
        });
        let emptied = json!({
            "characters": [{
                "contacts": { "email": "", "password": "" },
                "launch": { "gcAccounts": {} }
            }]
        });
        record(&dir, "load", 1, &full);
        record(&dir, "save", 2, &full);
        assert!(!dir.join(DIAG_FILE).exists());
        record(&dir, "save", 3, &emptied);
        let log = fs::read_to_string(dir.join(DIAG_FILE)).unwrap();
        assert!(log.contains("3 save dropped=[email,password,gcAccounts]"));
        assert!(log.contains("before=(characters=1 email=1 password=1 gcAccounts=1)"));
        assert!(!log.contains("private@example.test"));
        assert!(!log.contains("hunter2"));
        assert!(!log.contains("PrivateNick"));
        reset_memory_for_tests();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn record_detects_drop_across_restart() {
        let _guard = RECORD_TEST_LOCK.lock().unwrap();
        reset_memory_for_tests();
        let dir = test_dir("restart");
        let full = json!({
            "characters": [{
                "contacts": { "email": "private@example.test", "password": "hunter2" },
                "launch": { "gcAccounts": { "7": { "nick": "PrivateNick" } } }
            }]
        });
        let emptied = json!({
            "characters": [{
                "contacts": { "email": "", "password": "" },
                "launch": { "gcAccounts": {} }
            }]
        });
        record(&dir, "save", 10, &full); // первое сохранение: логируемая линия создаётся
        assert!(dir.join(DIAG_BASELINE).exists());
        assert!(!dir.join(DIAG_FILE).exists());
        reset_memory_for_tests(); // имитируем перезапуск: память процесса пуста
        record(&dir, "load", 11, &emptied); // файл сжался, пока приложение было закрыто
        let log = fs::read_to_string(dir.join(DIAG_FILE)).unwrap();
        assert!(log.contains("11 load dropped=[email,password,gcAccounts]"));
        assert!(!log.contains("private@example.test"));
        assert!(!log.contains("hunter2"));
        reset_memory_for_tests();
        let _ = fs::remove_dir_all(dir);
    }
}

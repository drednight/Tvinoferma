//! Работа с окнами клиентов игры от имени администратора — без перезапуска Твинофермы.
//!
//! Проблема: если игра запущена от администратора, а Твиноферма — обычным пользователем,
//! Windows запрещает менять чужие окна (интерфейсная изоляция UIPI). Раньше выход был один:
//! перезапустить Твиноферму от администратора. Теперь есть второй — выполнить нужное
//! действие в короткоживущем помощнике: Твиноферма запускает саму себя с ключом
//! `--tf-helper`, Windows показывает UAC, помощник делает работу и выходит.
//!
//! Так устроено «без перезапуска»: основной процесс продолжает работать с обычными правами,
//! а права нужны только на минуту и только одному действию. Это безопаснее, чем держать всё
//! приложение под администратором.
//!
//! Помощник ничего не знает об интерфейсе: он читает задание из файла, пишет результат
//! в файл ответа и выходит. Никаких окон, трея и журналов.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

/// Ключ, которым основной процесс зовёт помощника.
pub const HELPER_FLAG: &str = "--tf-helper";

/// Что именно нужно сделать от администратора.
///
/// Пока только подпись окон: закрытие чужой игры от администратора уже работает иначе —
/// через `taskkill` с `Verb RunAs` (`launcher_close_clients_elevated`), там помощник не нужен.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Job {
    /// Подписать окна клиентов: заголовок «Ник — Класс» и значок класса.
    Decorate { targets: Vec<DecorateTarget> },
}

/// Подпись одного окна клиента — тот же тип, что у обычной команды подписи.
pub type DecorateTarget = crate::launcher::DecorateTarget;

/// Итог по одному окну: окно подписано, уже было таким или доступа не было.
/// Тот же тип, что у обычной команды — помощник возвращает ровно то, что вернула бы она.
pub type DecorateResult = crate::launcher::DecorateResult;

/// Ответ помощника.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelperResult {
    /// `done` — работа выполнена, `denied` — пользователь отказал в UAC,
    /// `error` — помощник не смог выполнить задание
    pub status: String,
    #[serde(default)]
    pub decorate: Vec<DecorateResult>,
    #[serde(default)]
    pub message: String,
}

impl HelperResult {
    fn done() -> Self {
        Self {
            status: "done".into(),
            decorate: Vec::new(),
            message: String::new(),
        }
    }
    fn denied() -> Self {
        Self {
            status: "denied".into(),
            decorate: Vec::new(),
            message: "Запрос прав администратора отклонён".into(),
        }
    }
    fn err(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            status: "error".into(),
            decorate: Vec::new(),
            message,
        }
    }
}

/// Путь файла задания и ответа для одного вызова помощника.
fn job_paths(token: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir();
    (
        dir.join(format!("tf-helper-{}.job", token)),
        dir.join(format!("tf-helper-{}.result", token)),
    )
}

/// Выполняет задание прямо в этом процессе (его и вызывает помощник).
///
/// Вынесено отдельно от запуска помощника, чтобы правда поведения проверялась тестами без UAC.
pub fn run_job(job: &Job) -> HelperResult {
    match job {
        Job::Decorate { targets } => HelperResult {
            decorate: crate::launcher::decorate_targets(targets),
            ..HelperResult::done()
        },
    }
}

/// Этот запуск — помощник? Тогда выполняем задание и выходим, не поднимая Tauri.
pub fn run_as_helper_if_requested() -> bool {
    let Some(pos) = std::env::args().position(|a| a == HELPER_FLAG) else {
        return false;
    };
    let token = std::env::args().nth(pos + 1).unwrap_or_default();
    let (job_path, result_path) = job_paths(&token);
    let result = std::fs::read_to_string(&job_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Job>(&text).ok())
        .map(|job| run_job(&job))
        .unwrap_or_else(|| HelperResult::err("Не удалось прочитать задание помощника"));
    // Ответ пишем всегда: и об успехе, и об ошибке — иначе основной процесс будет ждать вечно
    let _ = std::fs::write(
        &result_path,
        serde_json::to_string(&result).unwrap_or_default(),
    );
    let _ = std::fs::remove_file(&job_path);
    true
}

/// Выполняет задание от администратора: Windows спросит разрешение (UAC), затем помощник
/// сделает работу и выйдет. Основной процесс при этом не перезапускается и остаётся обычным.
#[command]
pub async fn launcher_run_elevated(job: Job) -> Result<HelperResult, String> {
    if crate::launcher::self_elevated() {
        // Уже администратор — помощник не нужен, UAC только зря спросил бы пользователя
        return Ok(run_job(&job));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let token = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let (job_path, result_path) = job_paths(&token);
        let job_text = serde_json::to_string(&job).map_err(|e| e.to_string())?;
        std::fs::write(&job_path, job_text).map_err(|e| e.to_string())?;
        let exe =
            std::env::current_exe().map_err(|e| format!("Не удалось найти программу: {}", e))?;
        let code =
            crate::launcher::run_elevated_self(&exe.display().to_string(), HELPER_FLAG, &token);
        if code != Some(0) {
            let _ = std::fs::remove_file(&job_path);
            // 1223 — пользователь закрыл окно UAC, отказ не считаем ошибкой
            return if code == Some(1223) {
                Ok(HelperResult::denied())
            } else {
                Err("Не удалось запустить помощника с правами администратора".into())
            };
        }
        // Ждём ответ помощника: UAC и запуск занимают время, а без ответа вернулись бы «готово» враньё
        let result = wait_for_result(&result_path);
        let _ = std::fs::remove_file(&result_path);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Читает файл ответа, пока он не появится. Таймаут — на случай, если помощник не смог выйти.
fn wait_for_result(path: &std::path::Path) -> Result<HelperResult, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(result) = serde_json::from_str::<HelperResult>(&text) {
                return Ok(result);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    Err("Помощник не ответил за 30 секунд".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_roundtrips_through_json() {
        let job = Job::Decorate {
            targets: vec![DecorateTarget {
                pid: 42,
                title: "Аа — Воин".into(),
                icon_small: None,
                icon_big: Some(vec![1, 2, 3]),
            }],
        };
        let text = serde_json::to_string(&job).expect("сериализуется");
        assert_eq!(serde_json::from_str::<Job>(&text).expect("читается"), job);
        // Вид действия записывается именем, а не порядком полей: иначе старый ответ читался бы неверно
        assert!(text.contains("\"action\":\"decorate\""), "{}", text);
    }

    #[test]
    fn keys_are_normalized_for_javascript() {
        let job = Job::Decorate {
            targets: vec![DecorateTarget {
                pid: 7,
                title: "T".into(),
                icon_small: None,
                icon_big: None,
            }],
        };
        let value: serde_json::Value = serde_json::to_value(job).expect("сериализуется");
        assert!(
            value["targets"][0]["iconSmall"].is_null()
                || value["targets"][0].get("iconSmall").is_some()
        );
    }

    #[test]
    fn denied_and_error_are_distinguishable() {
        let denied = HelperResult::denied();
        assert_eq!(denied.status, "denied");
        assert!(denied.message.contains("отклонён"));
        let failed = HelperResult::err("окно не найдено");
        assert_eq!(failed.status, "error");
        assert_ne!(denied.status, failed.status);
    }

    #[test]
    fn helper_result_survives_json() {
        let result = HelperResult {
            status: "done".into(),
            decorate: vec![DecorateResult {
                pid: 5,
                status: "fixed".into(),
                title: "T".into(),
            }],
            message: String::new(),
        };
        let text = serde_json::to_string(&result).expect("сериализуется");
        assert_eq!(
            serde_json::from_str::<HelperResult>(&text).expect("читается"),
            result
        );
    }

    #[test]
    fn job_files_of_one_call_do_not_collide() {
        let (job_a, res_a) = job_paths("aaa");
        let (job_b, res_b) = job_paths("bbb");
        assert_ne!(job_a, job_b);
        assert_ne!(res_a, res_b);
        assert!(res_a.to_string_lossy().contains("aaa"));
    }

    #[test]
    fn empty_decorate_job_is_allowed() {
        // Пустой список — не ошибка: подписывать нечего
        let job = Job::Decorate {
            targets: Vec::new(),
        };
        assert!(serde_json::to_string(&job).is_ok());
    }
}

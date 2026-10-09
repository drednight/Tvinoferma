//! Общая инфраструктура парсеров: журнал шагов, ожидание ответа скрипта в hash,
//! обработка «Проверки безопасности» сайта.

use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewWindow};

/// Общий слой скриптов (`window.__TF`): поиск по списку селекторов с запасными вариантами, тексты, регулярные выражения.
const COMMON_JS: &str = include_str!("scripts/common.js");
/// Все селекторы, тексты и регулярные выражения парсеров. Правится здесь, а не в самих скриптах.
const SELECTORS_JSON: &str = include_str!("scripts/selectors.json");
/// Маркер в `common.js`, вместо которого подставляется `selectors.json`.
const SELECTORS_MARKER: &str = "{} /*TF_SELECTORS*/";

/// Собирает скрипт для выполнения на странице: `common.js` с подставленным `selectors.json` + сам скрипт.
pub fn with_common(script: &str) -> String {
    let common = COMMON_JS.replace(SELECTORS_MARKER, SELECTORS_JSON.trim());
    format!("{}\n{}", common, script)
}

/// Область «без журнала»: сообщения в неё не пишутся ни в консоль, ни в журнал задач (например, чтение «Статуса серверов»).
pub const QUIET_SCOPE: &str = "quiet";

/// Шаг для журнала задач в интерфейсе (событие `tf-task-log`, scope = `char:<id>` | `scan` | `detail` | `news`).
pub fn tf_log(app: &AppHandle, scope: &str, level: &str, message: impl Into<String>) {
    if scope == QUIET_SCOPE {
        return;
    }
    let message: String = message.into();
    println!("[{}] {}: {}", scope, level, message);
    let _ = app.emit(
        "tf-task-log",
        serde_json::json!({ "scope": scope, "level": level, "message": message }),
    );
}

/// Метка готовности страницы в hash (пишется через `replaceState`, как и остальные ответы парсеров)
const READY_PREFIX: &str = "#TF_READY_";

/// Дом готов к разбору: в hash после метки лежит `document.readyState`.
///
/// Ждём не `complete`, а `interactive` (DOM разобран). Парсерам нужны текст и элементы,
/// а не картинки и шрифты: страница с двумя десятками ресурсов до `complete` не доходит
/// никогда (особенно страница входа с баннерами), и ждать её бессмысленно.
/// Недорисованные страницы парсер и так узнаёт по `pending`/`challenge` и повторяет скрипт.
fn is_ready(url_str: &str) -> bool {
    match url_str.find(READY_PREFIX) {
        Some(pos) => !url_str[pos + READY_PREFIX.len()..].starts_with("loading"),
        None => false,
    }
}

/// Убирает hash прошлого ответа и переходит на страницу. Возвращает, сколько мс ждали готовности.
///
/// Раньше здесь была слепая пауза `sleep(1500ms)`: она одинаково и для быстрой страницы,
/// и для медленной, поэтому в замерах «переход» всегда был ровно 1.5 с и ничего не говорил.
/// Теперь ждём разбора DOM (`readyState` не `loading`), но не дольше тех же 1.5 с —
/// медленная страница не должна висеть вечно.
pub async fn navigate_clean(window: &WebviewWindow, url: &str) -> Result<u64, String> {
    let started = Instant::now();
    let _ = window.eval("history.replaceState(null, '', location.pathname + location.search);");
    let target = Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    window.navigate(target).map_err(|e| e.to_string())?;
    let deadline = started + Duration::from_millis(1500);
    let probe = format!(
        "try{{history.replaceState(null,'',location.pathname+location.search+'{READY_PREFIX}'+document.readyState)}}catch(e){{}}"
    );
    loop {
        let _ = window.eval(&probe);
        // DOM разобран — читаем; «loading» ждём дальше, но не дольше потолка
        if window.url().map(|u| is_ready(u.as_str())).unwrap_or(false) {
            return Ok(started.elapsed().as_millis() as u64);
        }
        if Instant::now() >= deadline {
            return Ok(started.elapsed().as_millis() as u64);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Читает результат парсера из hash вида `#PREFIX<encodeURIComponent(JSON)>`,
/// где JSON = { "data": ..., "error": string|null }.
pub fn read_hash_payload(
    url_str: &str,
    prefix: &str,
) -> Option<(Option<String>, serde_json::Value)> {
    let pos = url_str.find(prefix)?;
    let encoded = &url_str[pos + prefix.len()..];
    let decoded = urlencoding::decode(encoded).ok()?;
    let value: serde_json::Value = serde_json::from_str(&decoded).ok()?;
    let error = value
        .get("error")
        .and_then(|e| e.as_str())
        .map(|s| s.to_string());
    let data = value
        .get("data")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Some((error, data))
}

/// Что вернуть, если время вышло, а последним ответом скрипта был «мягкий» (`challenge` / `pending`).
/// Страница при этом отвечала, поэтому это не «сайт не ответил» (`None`):
/// - `challenge` со значением `"page"` — сайт так и не пропустил дальше «Проверки безопасности»;
/// - `pending` со значением `"complete"` — страница полностью загрузилась, но признаков входа
///   или нужного блока в ней нет (возможно, сайт изменил вёрстку).
///
/// Недогруженная страница (значение `"loading"` или его нет) остаётся таймаутом.
pub fn soft_timeout_result(
    error: &str,
    data: &serde_json::Value,
) -> Option<(Option<String>, serde_json::Value)> {
    match error {
        "challenge" if data.as_str() == Some("page") => {
            Some((Some("challenge".to_string()), serde_json::Value::Null))
        }
        "pending" if data.as_str() == Some("complete") => {
            Some((Some("pending".to_string()), serde_json::Value::Null))
        }
        _ => None,
    }
}

/// Выполняет скрипт парсера и ждёт ответ в hash (`#PREFIX<json>`).
/// Пока сайт показывает «Проверку безопасности» (error = "challenge"), страница
/// ещё не дорисована (error = "pending") или перезагружается — повторяет скрипт.
/// Возвращает None по таймауту; если страница всё это время отвечала «мягким» ответом —
/// `Some` с его кодом (см. `soft_timeout_result`).
pub async fn eval_and_wait(
    window: &WebviewWindow,
    script: &str,
    prefix: &str,
    timeout_secs: u64,
    scope: &str,
) -> Option<(Option<String>, serde_json::Value)> {
    let app = window.app_handle().clone();
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_eval: Option<Instant> = None;
    let mut challenge_logged = false;
    let mut last_soft: Option<(String, serde_json::Value)> = None;
    let full_script = with_common(script);
    tf_log(
        &app,
        scope,
        "info",
        format!(
            "Жду загрузки страницы и ответа парсера (до {} с)…",
            timeout_secs
        ),
    );

    while Instant::now() < deadline {
        let need_eval = last_eval
            .map(|t| t.elapsed() >= Duration::from_millis(1500))
            .unwrap_or(true);
        if need_eval {
            let _ = window.eval(&full_script);
            last_eval = Some(Instant::now());
        }
        // Пауза между опросами url: чем она меньше, тем точнее виден реальный разбор.
        // Раньше здесь было 400 мс, и быстрый ответ парсера читался только на втором-третьем
        // круге — в замерах это выглядело как «разбор 0.4 с» при фактическом 0.05 с.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let Ok(url) = window.url() else { continue };
        let Some((error, data)) = read_hash_payload(url.as_str(), prefix) else {
            continue;
        };
        match error.as_deref() {
            Some("challenge") => {
                last_soft = Some(("challenge".to_string(), data));
                if !challenge_logged {
                    tf_log(
                        &app,
                        scope,
                        "warn",
                        "Сайт показывает «Проверку безопасности» — жду, пока она пройдёт…",
                    );
                    challenge_logged = true;
                }
            }
            Some("pending") => last_soft = Some(("pending".to_string(), data)),
            _ => return Some((error, data)),
        }
        // Убираем hash, чтобы не прочитать его повторно, и ждём
        let _ = window.eval("history.replaceState(null, '', location.pathname + location.search);");
    }
    if let Some(result) = last_soft
        .as_ref()
        .and_then(|(error, data)| soft_timeout_result(error, data))
    {
        tf_log(
            &app,
            scope,
            "error",
            format!(
                "За {} с получен только промежуточный ответ парсера ({})",
                timeout_secs,
                result.0.as_deref().unwrap_or("?")
            ),
        );
        return Some(result);
    }
    tf_log(
        &app,
        scope,
        "error",
        format!("Страница не ответила за {} с", timeout_secs),
    );
    None
}

#[cfg(test)]
mod tests {
    use super::{
        is_ready, read_hash_payload, soft_timeout_result, with_common, SELECTORS_JSON,
        SELECTORS_MARKER,
    };

    #[test]
    fn ready_state_read_from_hash() {
        // DOM разобран — можно читать. Ждём не картинки: парсерам они не нужны
        assert!(is_ready("https://pwonline.ru/usercp.php#TF_READY_complete"));
        assert!(is_ready(
            "https://pwonline.ru/usercp.php#TF_READY_interactive"
        ));
        // Страница ещё грузится — ждём дальше
        assert!(!is_ready("https://pwonline.ru/usercp.php#TF_READY_loading"));
        // Метки нет вовсе: скрипт не успел записать (или это старый hash другого парсера)
        assert!(!is_ready("https://pwonline.ru/usercp.php"));
        assert!(!is_ready(
            "https://pwonline.ru/usercp.php#TF_AUTH_V2_online"
        ));
    }

    #[test]
    fn reads_payload_from_hash() {
        let url = "https://pwonline.ru/x.php#TF_X_%7B%22data%22%3A5%2C%22error%22%3Anull%7D";
        let (err, data) = read_hash_payload(url, "#TF_X_").unwrap();
        assert!(err.is_none());
        assert_eq!(data, serde_json::json!(5));
    }

    #[test]
    fn reads_error_and_ignores_other_prefix() {
        let url = "https://pwonline.ru/x.php#TF_X_%7B%22data%22%3Anull%2C%22error%22%3A%22challenge%22%7D";
        assert_eq!(
            read_hash_payload(url, "#TF_X_").unwrap().0.as_deref(),
            Some("challenge")
        );
        assert!(read_hash_payload(url, "#TF_Y_").is_none());
    }

    #[test]
    fn soft_timeout_distinguishes_silence_from_wrong_page() {
        use serde_json::json;
        // «Проверка безопасности» не пройдена — это ответ сайта, а не тишина
        assert_eq!(
            soft_timeout_result("challenge", &json!("page")),
            Some((Some("challenge".to_string()), json!(null)))
        );
        assert_eq!(soft_timeout_result("challenge", &json!("loading")), None);
        assert_eq!(soft_timeout_result("challenge", &json!(null)), None);
        // страница загрузилась целиком, но нужных признаков нет
        assert_eq!(
            soft_timeout_result("pending", &json!("complete")),
            Some((Some("pending".to_string()), json!(null)))
        );
        // страница ещё грузилась или скрипт не сообщил состояние — остаётся таймаутом
        assert_eq!(soft_timeout_result("pending", &json!("loading")), None);
        assert_eq!(soft_timeout_result("pending", &json!(null)), None);
        assert_eq!(soft_timeout_result("timeout", &json!("complete")), None);
    }

    #[test]
    fn selectors_json_is_valid() {
        let cfg: serde_json::Value =
            serde_json::from_str(SELECTORS_JSON).expect("selectors.json — не JSON");
        assert!(
            cfg["version"].as_u64().unwrap_or(0) >= 1,
            "нужна версия конфига"
        );
        for section in ["selectors", "texts", "regex"] {
            let map = cfg[section]
                .as_object()
                .unwrap_or_else(|| panic!("нет раздела {section}"));
            for (name, list) in map {
                let list = list
                    .as_array()
                    .unwrap_or_else(|| panic!("{name}: ожидался список"));
                assert!(!list.is_empty(), "{name}: пустой список");
                assert!(
                    list.iter()
                        .all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty())),
                    "{name}: пустое значение"
                );
            }
        }
    }

    #[test]
    fn with_common_embeds_selectors_before_script() {
        let full = with_common("(function(){ /* парсер */ })();");
        assert!(
            full.contains("\"balance.container\""),
            "селекторы не подставлены"
        );
        assert!(!full.contains(SELECTORS_MARKER), "маркер остался в тексте");
        assert!(full.contains("window.__TF = "), "нет общего слоя");
        assert!(
            full.ends_with("(function(){ /* парсер */ })();"),
            "скрипт должен идти после общего слоя"
        );
    }
}

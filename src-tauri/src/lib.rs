use tauri::{command, AppHandle, Manager, Url};
use tauri_utils::config::WebviewUrl;
use std::str::FromStr;
use tauri::WindowEvent; 
use tauri::Emitter; 

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        
        // Глобальный обработчик событий окон (закрытие)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let label = window.label();
                if label.starts_with("sync-win-") || label.starts_with("popup-sync-win-") {
                    println!("[RUST EVENT] Browser window closed: {}", label);
                    let _ = window.app_handle().emit_to(
                        "main", 
                        "browser-window-closed", 
                        serde_json::json!({ "label": label })
                    );
                }
            }
        })
        
        .invoke_handler(tauri::generate_handler![
            open_sync_window, 
            close_sync_window,
            check_window_exists,
            execute_script_in_window,
            fetch_and_parse_balance_v4,
            check_login_status_http,
            fetch_marathon_progress_v1,
            get_available_marathon_titles,
            parse_specific_marathon_page,
            fetch_marathon_news
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Открывает ВИДИМОЕ окно браузера (для ручного входа/действия)
#[command]
async fn open_sync_window(
    app: AppHandle, 
    char_id: String, 
    url: String,
    char_nick: Option<String>
) -> Result<String, String> {
    let label = format!("sync-win-{}", char_id);
    
    let window_title = match &char_nick {
        Some(nick) => format!("PW Sync: {}", nick),
        None => format!("PW Sync: {}", char_id),
    };

    if let Some(win) = app.get_webview_window(&label) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        let _ = win.set_title(&window_title);
        return Ok(label);
    }

    let parsed_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let profiles_dir = app_data_dir.join("pw-sync-profiles").join(&char_id);
    std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

    let _window = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .title(window_title)
        .inner_size(1200.0, 800.0) 
        .resizable(true)
        .data_directory(profiles_dir) 
        .build()
        .map_err(|e| e.to_string())?;

    // Позиционирование окна
    if let Ok(Some(main_monitor)) = app.primary_monitor() {
        let scale_factor = main_monitor.scale_factor();
        let logical_width = main_monitor.size().width as f64;
        let logical_height = main_monitor.size().height as f64;
        
        let win_width = 1200.0_f64;
        let win_height = 800.0_f64;

        let x_pos = ((logical_width - win_width) / 2.0) + 50.0; 
        let y_pos = (logical_height - win_height) / 2.0;

        if let Some(win) = app.get_webview_window(&label) {
            let physical_x = (x_pos * scale_factor) as i32;
            let physical_y = (y_pos * scale_factor) as i32;
            let _ = win.set_position(tauri::PhysicalPosition::new(physical_x, physical_y));
        }
    }

    // Патч против попапов
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    
    if let Some(win) = app.get_webview_window(&label) {
        let patch_script = r#"
            (function() {
                const originalOpen = window.open;
                window.open = function(url, name, specs) {
                    if (url && typeof url === 'string') {
                        const lowerUrl = url.toLowerCase();
                        if (lowerUrl.includes('vkplay') || lowerUrl.includes('oauth') || lowerUrl.includes('passport') || lowerUrl.includes('/login')) {
                            window.location.href = url;
                            return null;
                        }
                    }
                    try { return originalOpen.call(this, url, name, specs); } catch(e) { return null; }
                };
            })();
        "#;
        win.eval(patch_script).ok();
    }

    Ok(label)
}

/// Закрывает окно браузера по ID персонажа
#[command]
async fn close_sync_window(app: AppHandle, char_id: String) -> Result<(), String> {
    let base_label = format!("sync-win-{}", char_id);
    
    if let Some(win) = app.get_webview_window(&base_label) {
        win.close().map_err(|e| e.to_string())?;
    }
    
    for (_, window) in app.webview_windows() {
        if window.label().starts_with(&format!("popup-{}", base_label)) {
            let _ = window.close();
        }
    }
    
    Ok(())
}

/// Проверяет существование окна по лейблу
#[command]
fn check_window_exists(app: AppHandle, label: String) -> bool {
    app.get_webview_window(&label).is_some()
}

/// Выполняет произвольный JS в указанном окне
#[command]
async fn execute_script_in_window(app: AppHandle, label: String, script: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.eval(&script).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Window {} not found", label))
    }
}

/// БЫСТРАЯ ПРОВЕРКА ЛОГИНА ЧЕРЕЗ СКРЫТОЕ ОКНО
#[command]
async fn check_login_status_http(
    app: AppHandle, 
    char_id: String,
    timeout_seconds: Option<u64>,
    close_after: Option<bool>
) -> Result<(), String> {
    let label = format!("sync-win-{}", char_id);
    let wait_time = std::time::Duration::from_secs(timeout_seconds.unwrap_or(5));
    
    println!("[HIDDEN CHECK] Starting status check for {} (Timeout: {:?})", char_id, wait_time);

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let profiles_dir = app_data_dir.join("pw-sync-profiles").join(&char_id);
    std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

    // Окно создано этой проверкой? Тогда его можно закрыть после неё (видимые окна пользователя не трогаем)
    let created_here = app.get_webview_window(&label).is_none();

    let window = match app.get_webview_window(&label) {
        Some(w) => w,
        None => {
            println!("[HIDDEN CHECK] Creating HIDDEN window...");
            let parsed_url = Url::from_str("https://pwonline.ru/usercp.php").map_err(|e| format!("Invalid URL: {}", e))?;
            
            let _win = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
                .title(format!("Hidden Sync: {}", char_id))
                .inner_size(800.0, 600.0)
                .resizable(false)
                .visible(false) 
                .data_directory(profiles_dir.clone()) 
                .build()
                .map_err(|e| e.to_string())?;
            
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            app.get_webview_window(&label).ok_or("Window creation failed")?
        }
    };

    let target_url = Url::from_str("https://pwonline.ru/usercp.php").unwrap();
    window.navigate(target_url).map_err(|e| e.to_string())?;
    
    tokio::time::sleep(wait_time / 2).await; 

    let checker_script = r#"
        (function() {
            function getResult() {
                const nicknameSpan = document.querySelector('.info__forumname');
                const welcomeText = document.body.innerText.includes("Добро пожаловать");
                if (nicknameSpan && welcomeText) return 'ONLINE';
                const bodyText = document.body.innerText || "";
                if (bodyText.includes("Вы не авторизованы")) return 'OFFLINE';
                return 'UNKNOWN'; 
            }
            let status = getResult();
            if (status === 'UNKNOWN') {
                setTimeout(() => { status = getResult(); finalize(status); }, 1000);
            } else { finalize(status); }
            function finalize(finalStatus) {
                if (finalStatus === 'ONLINE') window.location.hash = 'TF_STATUS_ONLINE';
                else window.location.hash = 'TF_STATUS_OFFLINE';
            }
        })();
    "#;

    window.eval(checker_script).map_err(|e| e.to_string())?;

    let max_attempts = (timeout_seconds.unwrap_or(5) as usize) * 2;
    let mut status = "offline";
    let mut resolved = false;

    for _ in 0..max_attempts {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(url) = window.url() {
            let url_str = url.as_str();
            if url_str.contains("#TF_STATUS_ONLINE") { status = "online"; resolved = true; break; }
            if url_str.contains("#TF_STATUS_OFFLINE") { status = "offline"; resolved = true; break; }
        }
    }

    if resolved {
        println!("[HIDDEN CHECK] Result for {}: {}", char_id, status);
    } else {
        println!("[HIDDEN CHECK] Timeout after {:?}, assuming OFFLINE", wait_time);
    }

    // destroy() вместо close(): не генерирует CloseRequested, чтобы фронтенд
    // не принял закрытие служебного окна за выход пользователя
    if created_here && close_after.unwrap_or(false) {
        let _ = window.destroy();
    }

    if let Err(e) = app.emit("login-status-result-global", serde_json::json!({ "charId": char_id, "status": status })) {
        println!("[HIDDEN CHECK] Emit Error: {:?}", e);
    }

    Ok(())
}

/// V4 FIX: Парсинг баланса с умной обработкой нуля и проверкой авторизации
#[command]
async fn fetch_and_parse_balance_v4(app: AppHandle, char_id: String) -> Result<(), String> {
    let label = format!("sync-win-{}", char_id);
    println!("==================================================");
    println!("[V4-FIX START] Checking balance for CharID: {}", char_id);

    let window = match app.get_webview_window(&label) {
        Some(w) => w,
        None => {
            println!("[V4-FIX WARN] Creating new window...");
            let _ = open_sync_window(app.clone(), char_id.clone(), "https://pwonline.ru/chests2.php".to_string(), None).await?;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            app.get_webview_window(&label).ok_or("Window creation failed")?
        }
    };

    println!("[V4-FIX ACTION] Navigating to chests2.php...");
    let target_url = Url::from_str("https://pwonline.ru/chests2.php").unwrap();
    window.navigate(target_url).map_err(|e| e.to_string())?;

    println!("[V4-FIX WAIT] Waiting 5 seconds for page load...");
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    let parser_script = r#"
        (function() {
            console.log('[PARSER-V4-SMART] Starting smart parse on chests2.php...');
            function reportResult(balance, errorType) {
                const errStr = errorType ? errorType.toString().replace(/[^a-zA-Z0-9_-]/g, '_') : "null";
                const balStr = (typeof balance === 'number' && !isNaN(balance)) ? balance.toString() : "-1";
                window.location.hash = `TF_BAL_${balStr}_${errStr}`;
            }
            try {
                const pointsInfo = document.querySelector('.points_info');
                const bodyText = document.body.innerText || "";
                const isNotLoggedIn = bodyText.includes("Вы не авторизованы") || bodyText.includes("Для доступа к разделу необходимо войти") || bodyText.includes("Ошибка авторизации") || window.location.href.includes("login.php") || window.location.href.includes("vkplay");
                if (isNotLoggedIn) { reportResult(null, 'not_logged_in'); return; }
                if (!pointsInfo) { reportResult(null, 'container_missing'); return; }
                const strongTag = pointsInfo.querySelector('strong');
                if (!strongTag) { reportResult(null, 'no_value_tag'); return; }
                const text = strongTag.innerText.trim();
                const cleanedText = text.replace(/[^0-9]/g, '');
                const numericValue = parseInt(cleanedText, 10);
                if (isNaN(numericValue)) { reportResult(null, 'parse_nan'); return; }
                if (numericValue === 0) {
                    const userNickElement = document.querySelector('.user-nick, .header-user-name, [class*="username"]');
                    if (!userNickElement) { reportResult(null, 'zero_no_user_session_expired'); } 
                    else { reportResult(0, null); }
                } else { reportResult(numericValue, null); }
            } catch (e) { reportResult(null, 'exception_' + e.message.substring(0, 20)); }
        })();
    "#;

    println!("[V4-FIX INJECT] Injecting smart parser...");
    window.eval(parser_script).map_err(|e| { println!("[V4-FIX ERROR] Eval inject failed: {}", e); e.to_string() })?;

    println!("[V4-FIX LOOP] Polling for results...");
    let mut found_data = false;
    let max_attempts = 20; 
    
    for i in 0..max_attempts {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let current_url_res = window.url(); 
        match current_url_res {
            Ok(current_url) => {
                let url_str = current_url.as_str();
                if url_str.contains("#TF_BAL_") {
                    println!("[V4-FIX SUCCESS] Found data in URL at attempt {}: {}", i+1, url_str);
                    if let Some(pos) = url_str.find("#TF_BAL_") {
                        let content_start = pos + 8; 
                        let content_end = url_str.len();
                        let content = &url_str[content_start..content_end];
                        let parts: Vec<&str> = content.splitn(2, '_').collect();
                        if parts.len() >= 2 {
                            let balance_str = parts[0];
                            let error_raw = parts[1];
                            let balance_opt: Option<i64> = balance_str.parse::<i64>().ok();
                            let final_balance = if balance_opt == Some(-1) { None } else { balance_opt };
                            let error: Option<String> = if error_raw == "null" { None } else { Some(error_raw.to_string()) };
                            println!("[V4-FIX PARSED] Balance: {:?}, Error: {:?}", final_balance, error);
                            let emit_result = app.emit("pw-balance-result-global", serde_json::json!({ "charId": char_id, "balance": final_balance, "error": error }));
                            match emit_result { Ok(_) => println!("[V4-FIX EMIT] Successfully emitted event."), Err(e) => println!("[V4-FIX EMIT] ERROR: {:?}", e) }
                            found_data = true;
                            break;
                        }
                    }
                }
            },
            Err(e) => { println!("[V4-FIX WARN] Could not read URL: {:?}", e); }
        }
    }

    if !found_data {
        println!("[V4-FIX TIMEOUT] Could not find valid data after {} attempts.", max_attempts);
        let emit_result = app.emit("pw-balance-result-global", serde_json::json!({ "charId": char_id, "balance": null, "error": "timeout_polling_smart" }));
        match emit_result { Ok(_) => {}, Err(e) => println!("[V4-FIX EMIT] ERROR: {:?}", e) }
    }

    println!("[V4-FIX END] Process finished.");
    println!("==================================================");
    
    Ok(())
}


// src-tauri/src/lib.rs

/// Возвращает окно `sync-win-{key}` (профиль персонажа), создавая СКРЫТОЕ при необходимости.
/// Второе значение = true, если окно создано сейчас (его можно уничтожить после работы).
async fn get_or_create_hidden_window(app: &AppHandle, key: &str, url: &str) -> Result<(tauri::WebviewWindow, bool), String> {
    let label = format!("sync-win-{}", key);
    if let Some(w) = app.get_webview_window(&label) {
        return Ok((w, false));
    }
    let parsed_url = Url::from_str(url).map_err(|e| format!("Invalid URL: {}", e))?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let profiles_dir = app_data_dir.join("pw-sync-profiles").join(key);
    std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

    tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed_url))
        .title(format!("Hidden Sync: {}", key))
        .inner_size(1000.0, 700.0)
        .resizable(false)
        .visible(false)
        .data_directory(profiles_dir)
        .build()
        .map_err(|e| e.to_string())?;

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let w = app.get_webview_window(&label).ok_or("Window creation failed")?;
    Ok((w, true))
}

/// Окно для сканирования марафонов: профиль указанного (авторизованного) персонажа,
/// иначе любое открытое окно персонажа, иначе отдельный профиль сканера (без входа).
async fn pick_scan_window(app: &AppHandle, char_id: Option<String>, url: &str, fallback_key: &str) -> Result<(tauri::WebviewWindow, bool), String> {
    if let Some(id) = char_id.filter(|s| !s.is_empty()) {
        return get_or_create_hidden_window(app, &id, url).await;
    }
    for (_, window) in app.webview_windows() {
        if window.label().starts_with("sync-win-") {
            return Ok((window, false));
        }
    }
    get_or_create_hidden_window(app, fallback_key, url).await
}

/// Выполняет скрипт парсера и ждёт ответ в hash (`#PREFIX<json>`).
/// Пока сайт показывает «Проверку безопасности» (ответ error = "challenge") или страница
/// перезагружается — повторяет скрипт. Возвращает None по таймауту.
async fn eval_and_wait(
    window: &tauri::WebviewWindow,
    script: &str,
    prefix: &str,
    timeout_secs: u64,
    scope: &str,
) -> Option<(Option<String>, serde_json::Value)> {
    use std::time::{Duration, Instant};
    let app = window.app_handle().clone();
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_eval: Option<Instant> = None;
    let mut challenge_logged = false;
    tf_log(&app, scope, "info", format!("Жду загрузки страницы и ответа парсера (до {} с)…", timeout_secs));

    while Instant::now() < deadline {
        let need_eval = last_eval.map(|t| t.elapsed() >= Duration::from_millis(1500)).unwrap_or(true);
        if need_eval {
            let _ = window.eval(script);
            last_eval = Some(Instant::now());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;

        let Ok(url) = window.url() else { continue };
        let Some((error, data)) = read_hash_payload(url.as_str(), prefix) else { continue };
        if error.as_deref() == Some("challenge") {
            if !challenge_logged {
                tf_log(&app, scope, "warn", "Сайт показывает «Проверку безопасности» — жду, пока она пройдёт…");
                challenge_logged = true;
            }
            // Убираем hash, чтобы не прочитать его повторно, и ждём прохождения проверки
            let _ = window.eval("history.replaceState(null, '', location.pathname + location.search);");
            continue;
        }
        return Some((error, data));
    }
    tf_log(&app, scope, "error", format!("Страница не ответила за {} с", timeout_secs));
    None
}

/// Шаг для журнала задач в интерфейсе (событие `tf-task-log`, scope = `char:<id>` | `scan` | `detail`).
fn tf_log(app: &AppHandle, scope: &str, level: &str, message: impl Into<String>) {
    let message: String = message.into();
    println!("[{}] {}: {}", scope, level, message);
    let _ = app.emit(
        "tf-task-log",
        serde_json::json!({ "scope": scope, "level": level, "message": message }),
    );
}

/// ПАРСЕР МАРАФОНА v2: прогресс персонажа по всем заданиям страницы марафона
#[command]
async fn fetch_marathon_progress_v1(
    app: AppHandle,
    char_id: String,
    marathon_url: Option<String>,
    close_after: Option<bool>
) -> Result<(), String> {
    let target_str = marathon_url.unwrap_or_else(|| "https://pwonline.ru/supermarathon.php".to_string());
    let scope = format!("char:{}", char_id);
    let (window, created_here) = get_or_create_hidden_window(&app, &char_id, &target_str).await?;
    tf_log(&app, &scope, "info", if created_here { "Открыт скрытый профиль персонажа" } else { "Использую уже открытое окно персонажа" });

    // Всегда переходим на страницу марафона: окно могло остаться на другой странице
    let target_url = Url::from_str(&target_str).map_err(|e| format!("Invalid URL: {}", e))?;
    window.navigate(target_url).map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let parser_script = r#"
        (function() {
            console.log('[MARATHON-JS] Starting marathon parsing...');
            function reportResult(data, error) {
                const payload = { data: data, error: error ? String(error) : null };
                window.location.hash = 'TF_MARATHON_DATA_' + encodeURIComponent(JSON.stringify(payload));
            }
            try {
                // Сайт показывает «Проверку безопасности» (anti-bot) — просим Rust подождать и повторить
                if (document.readyState === 'loading' ||
                    (document.title || '').includes('Проверка безопасности') ||
                    document.querySelector('script[src*="bp_chl"]')) {
                    reportResult(null, 'challenge');
                    return;
                }
                const bodyText = document.body.innerText || "";
                if (bodyText.includes("Вы не авторизованы") || bodyText.includes("не имеете доступа")) {
                    reportResult(null, 'not_logged_in');
                    return;
                }
                const marathonContainer = document.querySelector('.season_marathon');
                if (!marathonContainer) {
                    reportResult([], 'container_not_found');
                    return;
                }
                const questBlocks = marathonContainer.querySelectorAll(':scope > div');
                const results = [];
                questBlocks.forEach(block => {
                    const titleEl = block.querySelector('b');
                    const title = titleEl ? titleEl.innerText.trim() : "Unknown Quest";
                    const progressEl = block.querySelector('.progress span');
                    let completed = 0;
                    let total = 0;
                    if (progressEl) {
                        const text = progressEl.innerText.trim();
                        const parts = text.split('/');
                        if (parts.length === 2) {
                            completed = parseInt(parts[0], 10) || 0;
                            total = parseInt(parts[1], 10) || 0;
                        }
                    }
                    if (total > 0 || completed > 0) {
                        results.push({ title: title, completed: completed, total: total, percentage: total > 0 ? Math.round((completed / total) * 100) : 0 });
                    }
                });
                reportResult(results, null);
            } catch (e) {
                reportResult(null, 'exception_' + e.message.substring(0, 20));
            }
        })();
    "#;

    let result = eval_and_wait(&window, parser_script, "#TF_MARATHON_DATA_", 25, &scope).await;

    if created_here && close_after.unwrap_or(false) {
        let _ = window.destroy();
    }

    let payload = match result {
        Some((error, data)) => serde_json::json!({ "charId": char_id, "quests": data, "error": error }),
        None => serde_json::json!({ "charId": char_id, "quests": [], "error": "timeout_parsing_marathon" }),
    };
    println!("[MARATHON-PARSER] {} -> error: {:?}", char_id, payload["error"]);
    if let Err(e) = app.emit("marathon-progress-result-global", payload) {
        println!("[MARATHON-PARSER EMIT] ERROR: {:?}", e);
    }
    Ok(())
}

/// СКАН НАЗВАНИЙ МАРАФОНОВ (v5): использует профиль авторизованного персонажа (char_id)
#[command]
async fn get_available_marathon_titles(
    app: AppHandle,
    char_id: Option<String>,
    extra_urls: Option<Vec<String>>,
) -> Result<(), String> {
    let mut urls_to_check: Vec<String> = vec![
        "https://pwonline.ru/supermarathon.php".to_string(),
        "https://pwonline.ru/supermarathon2.php".to_string(),
    ];
    for u in extra_urls.unwrap_or_default() {
        if u.starts_with("http") && !urls_to_check.contains(&u) {
            urls_to_check.push(u);
        }
    }
    println!("[TITLE SCANNER v5] Scanning (char: {:?})...", char_id);
    let _ = app.emit("scan-progress-update", serde_json::json!({ "percent": 0, "message": "Подготовка..." }));

    let (base_window, created_here) = pick_scan_window(&app, char_id, &urls_to_check[0], "_title_scanner_v4_").await?;
    tf_log(&app, "scan", "info", if created_here { "Открыт скрытый профиль для поиска" } else { "Использую уже открытое окно" });

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let parser_script = r#"
            (function() {
                function report(data, error) {
                    const payload = { data: data, error: error ? String(error) : null };
                    window.location.hash = 'TF_TITLE_V4_' + encodeURIComponent(JSON.stringify(payload));
                }
                try {
                // Сайт показывает «Проверку безопасности» (anti-bot) — просим Rust подождать и повторить
                if (document.readyState === 'loading' ||
                    (document.title || '').includes('Проверка безопасности') ||
                    document.querySelector('script[src*="bp_chl"]')) {
                    report(null, 'challenge');
                    return;
                }
                    const bodyText = document.body.innerText || "";
                    if (bodyText.includes("Вы не авторизованы")) {
                         report(null, 'not_logged_in');
                         return;
                    }
                    const headers = document.querySelectorAll('h2');
                    let marathonName = null;
                    for (let h of headers) {
                        const text = h.innerText.trim();
                        if (text && text.length > 3 && !text.includes('Новости')) {
                            marathonName = text;
                            break;
                        }
                    }
                    if (!marathonName) {
                        report(null, 'no_title_found');
                        return;
                    }
                    report({ name: marathonName, url: window.location.href }, null);
                } catch (e) {
                    report(null, 'exception_' + e.message.substring(0, 20));
                }
            })();
        "#;

    for (index, url_str) in urls_to_check.iter().enumerate() {
        let percent = ((index as f64 / urls_to_check.len() as f64) * 100.0) as u8;
        let _ = app.emit("scan-progress-update", serde_json::json!({
            "percent": percent,
            "message": format!("Проверка: {}", url_str.split('/').last().unwrap_or(""))
        }));
        tf_log(&app, "scan", "step", format!("Открываю {}", url_str));

        let Ok(target_url) = Url::from_str(url_str) else {
            errors.push(format!("bad_url: {}", url_str));
            continue;
        };
        base_window.navigate(target_url).map_err(|e| e.to_string())?;
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        match eval_and_wait(&base_window, parser_script, "#TF_TITLE_V4_", 20, "scan").await {
            Some((None, data_val)) => {
                println!("[TITLE SCANNER v5] Found: {}", data_val["name"].as_str().unwrap_or("?"));
                results.push(data_val);
            }
            Some((Some(err), _)) => {
                println!("[TITLE SCANNER v5] {} -> {}", url_str, err);
                errors.push(err);
            }
            None => {
                println!("[TITLE SCANNER v5] Timeout on {}", url_str);
                errors.push("timeout".to_string());
            }
        }
    }

    let _ = app.emit("scan-progress-update", serde_json::json!({ "percent": 100, "message": "Готово" }));
    if created_here {
        let _ = base_window.destroy();
    }

    let _ = app.emit("marathon-titles-scanned-global", serde_json::json!({
        "titles": results,
        "count": results.len(),
        "errors": errors
    }));
    Ok(())
}

/// ДЕТАЛЬНЫЙ ПАРСИНГ СТРАНИЦЫ МАРАФОНА (v5): этапы + задания
#[command]
async fn parse_specific_marathon_page(app: AppHandle, url: String, char_id: Option<String>) -> Result<(), String> {
    let (base_window, created_here) = pick_scan_window(&app, char_id, &url, "_detail_parser_v4_").await?;
    tf_log(&app, "detail", "info", if created_here { "Открыт скрытый профиль" } else { "Использую уже открытое окно" });

    let target_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    base_window.navigate(target_url).map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let parser_script = r#"
        (function() {
            console.log('[DETAIL-PARSER-JS-v4] Starting deep parse with robust stages...');
            
            function reportResult(data, error) {
                const payload = { data: data, error: error ? String(error) : null };
                window.location.hash = 'TF_DETAIL_V4_' + encodeURIComponent(JSON.stringify(payload));
            }

            try {
                // Сайт показывает «Проверку безопасности» (anti-bot) — просим Rust подождать и повторить
                if (document.readyState === 'loading' ||
                    (document.title || '').includes('Проверка безопасности') ||
                    document.querySelector('script[src*="bp_chl"]')) {
                    reportResult(null, 'challenge');
                    return;
                }
                const bodyText = document.body.innerText || "";
                if (bodyText.includes("Вы не авторизованы")) {
                     reportResult(null, 'not_logged_in');
                     return;
                }

                // 1. Название основного марафона
                const headerEl = document.querySelector('h2');
                const marathonName = headerEl ? headerEl.innerText.trim() : "Неизвестный Марафон";

                // 2. Парсинг этапов. Формат сайта:
                // «Сроки проведения первого этапа марафона (июнь): с 00:01 мск 30 мая до 23:59 мск 28 июня.»
                // Разбираем весь текст легенды (этапы могут быть в одном абзаце, через <br>),
                // время и «мск» — необязательны, «до»/«по» — оба варианта.
                const debug = [];
                const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
                const MONTH_GEN = { 'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6,
                    'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12 };
                const MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август',
                    'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
                const stageKeyOf = (inner) => {
                    const low = norm(inner).toLowerCase();
                    return MONTH_NOM.find(m => low.includes(m)) || low;
                };
                const G = Object.keys(MONTH_GEN).join('|');
                const T = '(?:\\d{1,2}[:.]\\d{2}\\s*(?:мск|msk)?\\s*)?';
                const reStage = new RegExp(
                    '\\(([^()]{2,40})\\)[^()]{0,160}?(?:^|[\\s:,.—-])с\\s+' + T + '(\\d{1,2})\\s+(' + G + ')(?:\\s+(\\d{4}))?' +
                    '[^()]{0,80}?(?:до|по)\\s+' + T + '(\\d{1,2})\\s+(' + G + ')(?:\\s+(\\d{4}))?', 'gi');
                const now = new Date();
                const curMonth = now.getMonth() + 1;
                const yearFor = (mon) => {
                    let y = now.getFullYear();
                    if (mon < curMonth - 6) y += 1; else if (mon > curMonth + 6) y -= 1;
                    return y;
                };
                const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

                function parseStages(text) {
                    const found = [];
                    for (const mt of text.matchAll(reStage)) {
                        const key = stageKeyOf(mt[1]);
                        if (found.some(s => s.key === key)) continue;
                        const sMon = MONTH_GEN[mt[3].toLowerCase()], eMon = MONTH_GEN[mt[6].toLowerCase()];
                        const sYear = mt[4] ? parseInt(mt[4], 10) : yearFor(sMon);
                        const eYear = mt[7] ? parseInt(mt[7], 10) : (eMon < sMon ? sYear + 1 : sYear);
                        found.push({
                            name: key.charAt(0).toUpperCase() + key.slice(1),
                            key: key,
                            startDate: iso(sYear, sMon, parseInt(mt[2], 10)),
                            endDate: iso(eYear, eMon, parseInt(mt[5], 10))
                        });
                    }
                    return found;
                }

                const legendBlock = document.querySelector('.status_legend');
                const legendText = norm(legendBlock ? legendBlock.innerText : '');
                let stages = parseStages(legendText);
                debug.push(legendBlock ? `Блок сроков найден (${legendText.length} симв.), этапов: ${stages.length}` : 'Блок сроков (.status_legend) не найден на странице');
                if (!stages.length) {
                    stages = parseStages(norm(document.body.innerText));
                    debug.push(`Поиск сроков по всей странице: этапов ${stages.length}`);
                }
                // Абзацы со скобками, из которых не удалось достать даты — в лог, для диагностики
                (legendText.match(/[^\n]*\([^()]{2,40}\)[^\n]*/g) || []).forEach(line => {
                    const keyM = line.match(/\(([^()]{2,40})\)/);
                    if (keyM && MONTH_NOM.some(m => keyM[1].toLowerCase().includes(m)) && !stages.some(s => s.key === stageKeyOf(keyM[1]))) {
                        debug.push(`Не распознаны сроки этапа: «${line.slice(0, 200)}»`);
                    }
                });

                // 3. Парсинг заданий
                const container = document.querySelector('.season_marathon');
                const quests = [];

                if (container) {
                    const questBlocks = container.querySelectorAll(':scope > div');
                    questBlocks.forEach(block => {
                        const titleEl = block.querySelector('b');
                        const descEl = block.querySelector('p'); 
                        const progressSpan = block.querySelector('.progress span');
                        
                        let totalGoal = 0;
                        if (progressSpan) {
                            const text = progressSpan.innerText.trim(); 
                            const parts = text.split('/');
                            if (parts.length === 2) {
                                totalGoal = parseInt(parts[1], 10) || 0;
                            }
                        }

                        if (titleEl && totalGoal > 0) {
                            const rawTitle = titleEl.innerText.trim();
                            // Извлекаем месяц из заголовка для привязки к этапу
                            // Пример: "Испытание снов (июль)" -> ключ "июль"
                            const monthInTitle = rawTitle.match(/\(([^()]*)\)\s*$/) || rawTitle.match(/\(([^()]*)\)/);
                            const associatedStageKey = monthInTitle ? stageKeyOf(monthInTitle[1]) : null;

                            // Чистое описание без префикса [месяц], если он был добавлен ранее
                            let cleanDescription = descEl ? descEl.innerText.trim() : "";
                            
                            quests.push({
                                id: crypto.randomUUID(), 
                                title: rawTitle,
                                description: cleanDescription,
                                goal: totalGoal,
                                stageKey: associatedStageKey 
                            });
                        }
                    });
                }

                const resultData = {
                    name: marathonName,
                    sourceUrl: window.location.href,
                    detectedAt: new Date().toISOString(),
                    stages: stages,
                    quests: quests,
                    debug: debug
                };

                console.log('[DETAIL-PARSER-JS-v4] Success:', marathonName, 'Stages:', stages.length, 'Quests:', quests.length);
                reportResult(resultData, null);

            } catch (e) {
                console.error('[DETAIL-PARSER-JS-v4] Exception:', e);
                reportResult(null, 'exception_' + e.message.substring(0, 20));
            }
        })();
    "#;

    let result = eval_and_wait(&base_window, parser_script, "#TF_DETAIL_V4_", 25, "detail").await;
    if created_here {
        let _ = base_window.destroy();
    }

    let payload = match result {
        Some((None, data)) => serde_json::json!({ "marathon": data, "error": null }),
        Some((Some(err), _)) => serde_json::json!({ "marathon": null, "error": err }),
        None => serde_json::json!({ "marathon": null, "error": "timeout_parsing_details" }),
    };
    if let Err(e) = app.emit("single-marathon-parsed-global", payload) {
        println!("[DETAIL PARSER v5] Emit Error: {:?}", e);
    }
    Ok(())
}

/// НОВОСТЬ О МАРАФОНЕ: возвращает очищенный HTML статьи (news.php?article=…),
/// разбор этапов, заданий и наград выполняется в интерфейсе (js/marathons/newsParser.js).
#[command]
async fn fetch_marathon_news(app: AppHandle, url: String, char_id: Option<String>) -> Result<(), String> {
    tf_log(&app, "news", "step", format!("Открываю новость {}", url));
    let (window, created_here) = pick_scan_window(&app, char_id, &url, "_news_reader_").await?;
    let target_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    window.navigate(target_url).map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let script = r#"
        (function() {
            function report(data, error) {
                const payload = { data: data, error: error ? String(error) : null };
                window.location.hash = 'TF_NEWS_V1_' + encodeURIComponent(JSON.stringify(payload));
            }
            try {
                if (document.readyState === 'loading' ||
                    (document.title || '').includes('Проверка безопасности') ||
                    document.querySelector('script[src*="bp_chl"]')) {
                    report(null, 'challenge');
                    return;
                }
                const art = document.querySelector('.js-mediator-article') || document.querySelector('#content_body');
                if (!art) { report(null, 'no_article'); return; }
                const clone = art.cloneNode(true);
                clone.querySelectorAll('img, script, style, iframe, .img_item_small_cont > span').forEach(e => e.remove());
                clone.querySelectorAll('*').forEach(e => ['style', 'width', 'height', 'border', 'class'].forEach(a => {
                    if (a !== 'class' || !e.classList.contains('click_spoiler')) e.removeAttribute(a);
                }));
                const h1 = document.querySelector('#content_top h1') || document.querySelector('h1');
                const text = document.body.innerText || '';
                const dm = text.match(/Обсудить\s+(\d{2}\.\d{2}\.\d{4})/) || text.match(/(\d{2}\.\d{2}\.\d{4})/);
                report({
                    title: h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : document.title.split(' - ')[0],
                    publishedAt: dm ? dm[1] : null,
                    url: location.href.split('#')[0],
                    html: clone.innerHTML
                }, null);
            } catch (e) {
                report(null, 'exception_' + e.message.substring(0, 30));
            }
        })();
    "#;

    let result = eval_and_wait(&window, script, "#TF_NEWS_V1_", 25, "news").await;
    if created_here {
        let _ = window.destroy();
    }
    let payload = match result {
        Some((None, data)) => serde_json::json!({ "news": data, "error": null }),
        Some((Some(err), _)) => serde_json::json!({ "news": null, "error": err }),
        None => serde_json::json!({ "news": null, "error": "timeout" }),
    };
    let _ = app.emit("marathon-news-parsed-global", payload);
    Ok(())
}

/// Читает результат парсера из hash вида `#PREFIX<encodeURIComponent(JSON)>`,
/// где JSON = { "data": ..., "error": string|null }.
fn read_hash_payload(url_str: &str, prefix: &str) -> Option<(Option<String>, serde_json::Value)> {
    let pos = url_str.find(prefix)?;
    let encoded = &url_str[pos + prefix.len()..];
    let decoded = urlencoding::decode(encoded).ok()?;
    let value: serde_json::Value = serde_json::from_str(&decoded).ok()?;
    let error = value.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
    let data = value.get("data").cloned().unwrap_or(serde_json::Value::Null);
    Some((error, data))
}
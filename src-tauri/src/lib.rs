// src-tauri/src/lib.rs

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
            check_login_status_http
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
    char_nick: Option<String> // НОВЫЙ ПАРАМЕТР
) -> Result<String, String> {
    let label = format!("sync-win-{}", char_id);
    
    // Определяем заголовок окна
    let window_title = match &char_nick {
        Some(nick) => format!("PW Sync: {}", nick),
        None => format!("PW Sync: {}", char_id),
    };

    // Если окно уже есть, фокусируем его и ОБНОВЛЯЕМ ЗАГОЛОВОК
    if let Some(win) = app.get_webview_window(&label) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        
        // Обновляем title, если он изменился или был пуст
        let _ = win.set_title(&window_title);
        
        return Ok(label);
    }

    let parsed_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let profiles_dir = app_data_dir.join("pw-sync-profiles").join(&char_id);
    std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

    let _window = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .title(window_title) // <-- ИСПОЛЬЗУЕМ НИК В ЗАГОЛОВКЕ
        .inner_size(1200.0, 800.0) 
        .resizable(true)
        .data_directory(profiles_dir) 
        .build()
        .map_err(|e| e.to_string())?;

    // Позиционируем окно чуть правее центра
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

    // --- ИНЖЕКТИРУЕМ JS-ПАТЧ ДЛЯ БОРЬБЫ С ПОПАПАМИ ---
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    
    if let Some(win) = app.get_webview_window(&label) {
        let patch_script = r#"
            (function() {
                console.log('[PATCH] Installing Popup Killer...');
                
                const originalOpen = window.open;
                
                window.open = function(url, name, specs) {
                    if (url && typeof url === 'string') {
                        const lowerUrl = url.toLowerCase();
                        
                        if (lowerUrl.includes('vkplay') || 
                            lowerUrl.includes('oauth') || 
                            lowerUrl.includes('passport') ||
                            lowerUrl.includes('/login')) {
                            
                            console.log('[PATCH] Intercepted auth popup:', url);
                            window.location.href = url;
                            return null;
                        }
                    }
                    
                    try {
                        return originalOpen.call(this, url, name, specs);
                    } catch(e) {
                        console.warn('[PATCH] Standard open failed:', e);
                        return null;
                    }
                };

                document.addEventListener('click', function(e) {
                    const target = e.target.closest('.js-login, .login-button, a[href*="login"], button[onclick*="login"]');
                    if (target) {
                        let authUrl = target.getAttribute('href');
                        
                        if (!authUrl && target.onclick) {
                             const onclickStr = target.onclick.toString();
                             const match = onclickStr.match(/['"](https?:\/\/[^'"]+)['"]/);
                             if(match) authUrl = match[1];
                        }
                        
                        if (authUrl && (authUrl.includes('vkplay') || authUrl.includes('oauth') || authUrl.includes('passport'))) {
                             e.preventDefault();
                             e.stopPropagation();
                             console.log('[CLICK PATCH] Forcing navigation to:', authUrl);
                             window.location.href = authUrl;
                        }
                    }
                }, true);
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

// src-tauri/src/lib.rs

/// БЫСТРАЯ ПРОВЕРКА ЛОГИНА ЧЕРЕЗ СКРЫТОЕ ОКНО
#[command]
async fn check_login_status_http(
    app: AppHandle, 
    char_id: String,
    timeout_seconds: Option<u64> // НОВЫЙ ПАРАМЕТР: Таймаут в секундах
) -> Result<(), String> {
    let label = format!("sync-win-{}", char_id);
    
    // Дефолтный таймаут 5 секунд, если не передан
    let wait_time = std::time::Duration::from_secs(timeout_seconds.unwrap_or(5));
    
    println!("[HIDDEN CHECK] Starting status check for {} (Timeout: {:?})", char_id, wait_time);

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let profiles_dir = app_data_dir.join("pw-sync-profiles").join(&char_id);
    std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

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
            
            // Ждем инициализации окна
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            
            app.get_webview_window(&label).ok_or("Window creation failed")?
        }
    };

    // Принудительно навигируем на usercp.php
    let target_url = Url::from_str("https://pwonline.ru/usercp.php").unwrap();
    window.navigate(target_url).map_err(|e| e.to_string())?;
    
    // Ждем загрузки страницы (короче, чем раньше, чтобы ускорить первый проход)
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
                setTimeout(() => {
                    status = getResult();
                    finalize(status);
                }, 1000);
            } else {
                finalize(status);
            }

            function finalize(finalStatus) {
                if (finalStatus === 'ONLINE') {
                    window.location.hash = 'TF_STATUS_ONLINE';
                } else {
                    window.location.hash = 'TF_STATUS_OFFLINE';
                }
            }
        })();
    "#;

    window.eval(checker_script).map_err(|e| e.to_string())?;

    // Цикл опроса hash с учетом нового таймаута
    let max_attempts = (timeout_seconds.unwrap_or(5) as usize) * 2; // 2 попытки в секунду
    
    for _ in 0..max_attempts {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        
        if let Ok(url) = window.url() {
            let url_str = url.as_str();
            
            if url_str.contains("#TF_STATUS_ONLINE") {
                println!("[HIDDEN CHECK] Result: ONLINE");
                let _ = app.emit(
                    "login-status-result-global", 
                    serde_json::json!({ "charId": char_id, "status": "online" })
                );
                return Ok(());
            }
            
            if url_str.contains("#TF_STATUS_OFFLINE") {
                println!("[HIDDEN CHECK] Result: OFFLINE");
                let _ = app.emit(
                    "login-status-result-global", 
                    serde_json::json!({ "charId": char_id, "status": "offline" })
                );
                return Ok(());
            }
        }
    }

    println!("[HIDDEN CHECK] Timeout after {:?}, assuming OFFLINE", wait_time);
    let _ = app.emit(
        "login-status-result-global", 
        serde_json::json!({ "charId": char_id, "status": "offline" })
    );
    
    Ok(())
}

/// V4 FIX: Парсинг баланса с умной обработкой нуля и проверкой авторизации
#[command]
async fn fetch_and_parse_balance_v4(app: AppHandle, char_id: String) -> Result<(), String> {
    let label = format!("sync-win-{}", char_id);
    
    println!("==================================================");
    println!("[V4-FIX START] Checking balance for CharID: {}", char_id);

    // 1. Получаем или создаем окно
    let window = match app.get_webview_window(&label) {
        Some(w) => w,
        None => {
            println!("[V4-FIX WARN] Creating new window...");
            let _ = open_sync_window(app.clone(), char_id.clone(), "https://pwonline.ru/chests2.php".to_string(), None).await?;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            app.get_webview_window(&label).ok_or("Window creation failed")?
        }
    };

    // 2. ПРИНУДИТЕЛЬНАЯ НАВИГАЦИЯ
    println!("[V4-FIX ACTION] Navigating to chests2.php...");
    let target_url = Url::from_str("https://pwonline.ru/chests2.php").unwrap();
    window.navigate(target_url).map_err(|e| e.to_string())?;

    // 3. Ждем загрузки страницы
    println!("[V4-FIX WAIT] Waiting 5 seconds for page load...");
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    // 4. Инжектим УМНЫЙ скрипт парсинга
    let parser_script = r#"
        (function() {
            console.log('[PARSER-V4-SMART] Starting smart parse on chests2.php...');
            
            function reportResult(balance, errorType) {
                const errStr = errorType ? errorType.toString().replace(/[^a-zA-Z0-9_-]/g, '_') : "null";
                const balStr = (typeof balance === 'number' && !isNaN(balance)) ? balance.toString() : "-1";
                
                // Формат хэша: TF_BAL_{balance}_{error}
                // Если error != null, значит это проблема с доступом/авторизацией
                window.location.hash = `TF_BAL_${balStr}_${errStr}`;
                console.log('[PARSER-V4-SMART] Hash updated:', window.location.hash);
            }

            try {
                // Ищем основной контейнер баланса
                const pointsInfo = document.querySelector('.points_info');
                const bodyText = document.body.innerText || "";

                // ПРОВЕРКА 1: Явные признаки отсутствия авторизации
                // Эти тексты появляются, если куки истекли или вход не выполнен
                const isNotLoggedIn = bodyText.includes("Вы не авторизованы") || 
                                      bodyText.includes("Для доступа к разделу необходимо войти") ||
                                      bodyText.includes("Ошибка авторизации") ||
                                      window.location.href.includes("login.php") ||
                                      window.location.href.includes("vkplay");

                if (isNotLoggedIn) {
                    console.warn('[PARSER-V4-SMART] Detected NOT LOGGED IN markers.');
                    reportResult(null, 'not_logged_in');
                    return;
                }

                // ПРОВЕРКА 2: Наличие элемента баланса
                if (!pointsInfo) {
                    console.warn('[PARSER-V4-SMART] Container .points_info not found, but no explicit login error. Assuming offline/blocked.');
                    reportResult(null, 'container_missing');
                    return;
                }

                const strongTag = pointsInfo.querySelector('strong');
                
                if (!strongTag) {
                     console.warn('[PARSER-V4-SMART] Strong tag inside container missing.');
                     reportResult(null, 'no_value_tag');
                     return;
                }

                const text = strongTag.innerText.trim();
                const cleanedText = text.replace(/[^0-9]/g, '');
                const numericValue = parseInt(cleanedText, 10);
                
                if (isNaN(numericValue)) {
                    console.warn('[PARSER-V4-SMART] Could not parse number from text:', text);
                    reportResult(null, 'parse_nan');
                    return;
                }

                // ПРОВЕРКА 3: Обработка нуля
                if (numericValue === 0) {
                    console.info('[PARSER-V4-SMART] Balance is 0. Double-checking session validity...');
                    
                    // Дополнительная проверка: есть ли никнейм пользователя где-то на странице?
                    // На pwonline часто ник виден в шапке или футере
                    const userNickElement = document.querySelector('.user-nick, .header-user-name, [class*="username"]');
                    
                    if (!userNickElement) {
                        // Если баланс 0 и нигде нет имени пользователя - скорее всего, нас выкинуло
                        console.warn('[PARSER-V4-SMART] Zero balance AND no username found. Treating as OFFLINE.');
                        reportResult(null, 'zero_no_user_session_expired');
                    } else {
                        // Баланс 0, но пользователь явно залогинен (виден ник)
                        console.info('[PARSER-V4-SMART] Zero balance BUT user logged in. Recording 0 coins.');
                        reportResult(0, null);
                    }
                } else {
                    // Баланс больше 0 - точно онлайн
                    console.info('[PARSER-V4-SMART] Success! Balance:', numericValue);
                    reportResult(numericValue, null);
                }

            } catch (e) {
                console.error('[PARSER-V4-SMART] Exception:', e);
                reportResult(null, 'exception_' + e.message.substring(0, 20));
            }
        })();
    "#;

    println!("[V4-FIX INJECT] Injecting smart parser...");
    window.eval(parser_script).map_err(|e| {
        println!("[V4-FIX ERROR] Eval inject failed: {}", e);
        e.to_string()
    })?;

    // 5. ЦИКЛ ОПРОСА HASH
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
                            
                            // Парсим баланс (-1 означает ошибку по логике выше)
                            let balance_opt: Option<i64> = balance_str.parse::<i64>().ok();
                            let final_balance = if balance_opt == Some(-1) { None } else { balance_opt };
                            
                            let error: Option<String> = if error_raw == "null" {
                                None
                            } else {
                                Some(error_raw.to_string())
                            };

                            println!("[V4-FIX PARSED] Balance: {:?}, Error: {:?}", final_balance, error);

                            let emit_result = app.emit(
                                "pw-balance-result-global", 
                                serde_json::json!({
                                    "charId": char_id,
                                    "balance": final_balance,
                                    "error": error
                                })
                            );

                            match emit_result {
                                Ok(_) => println!("[V4-FIX EMIT] Successfully emitted event."),
                                Err(e) => println!("[V4-FIX EMIT] ERROR: {:?}", e),
                            }
                            
                            found_data = true;
                            break;
                        }
                    }
                }
            },
            Err(e) => {
                println!("[V4-FIX WARN] Could not read URL: {:?}", e);
            }
        }
    }

    if !found_data {
        println!("[V4-FIX TIMEOUT] Could not find valid data after {} attempts.", max_attempts);
        let _ = app.emit(
            "pw-balance-result-global", 
            serde_json::json!({
                "charId": char_id,
                "balance": null,
                "error": "timeout_polling_smart"
            })
        );
    }

    println!("[V4-FIX END] Process finished.");
    println!("==================================================");
    
    Ok(())
}
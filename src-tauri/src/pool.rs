//! Пул воркеров (AutomationEngine): несколько общих скрытых окон вместо окна на каждого персонажа.
//!
//! Как это работает:
//! - Задача (баланс, марафоны, поиск) берёт свободный воркер `pool-win-N`, ставит в него куки
//!   персонажа из банка (`cookie_bank`), выполняет скрипт и возвращает воркер в пул.
//! - Воркеров не больше `POOL_MAX`; если все заняты, задача ждёт (очередь уже ограничена в `queue.js`).
//! - После успешной задачи свежие куки пишутся обратно в банк, а куки персонажа из воркера удаляются.
//! - Воркер, простоявший `IDLE_DESTROY_SECS`, закрывается и освобождает память.
//! - Если в банке нет сессии персонажа, работает прежняя схема: скрытое окно его профиля.
//!
//! Проверку входа (`auth::check_login_status_http`) пул не использует: она по-прежнему работает
//! в профиле персонажа, именно она пополняет банк после ручного входа.

use crate::cookie_bank;
use crate::windows::{dispose, get_or_create_hidden_window, pick_scan_window};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{command, AppHandle, Manager, Url, WebviewUrl, WebviewWindow};

/// Верхний предел воркеров (одновременных окон пула).
const POOL_MAX: usize = 4;
/// Через сколько секунд простоя воркер закрывается. Задачи одной пачки идут встык (пауза в секундах),
/// поэтому 15 с хватает, чтобы воркеры переиспользовались, а память освобождалась быстро.
const IDLE_DESTROY_SECS: u64 = 15;
/// Сколько секунд задача ждёт свободный воркер.
const LEASE_WAIT_SECS: u64 = 120;

#[derive(Clone, Copy)]
struct Slot {
    busy: bool,
    last_used: Option<Instant>,
}

static SLOTS: Mutex<[Slot; POOL_MAX]> = Mutex::new([Slot { busy: false, last_used: None }; POOL_MAX]);

fn label(slot: usize) -> String {
    format!("pool-win-{}", slot)
}

/// Занимает свободный слот. Предпочитает тот, где окно уже открыто («тёплый» воркер).
fn try_take(app: &AppHandle) -> Option<usize> {
    let mut slots = SLOTS.lock().unwrap_or_else(|p| p.into_inner());
    let free: Vec<usize> = (0..POOL_MAX).filter(|i| !slots[*i].busy).collect();
    let pick = free
        .iter()
        .copied()
        .find(|i| app.get_webview_window(&label(*i)).is_some())
        .or_else(|| free.first().copied())?;
    slots[pick].busy = true;
    Some(pick)
}

async fn ensure_window(app: &AppHandle, slot: usize) -> Result<WebviewWindow, String> {
    let lbl = label(slot);
    if let Some(w) = app.get_webview_window(&lbl) {
        return Ok(w);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pw-sync-profiles")
        .join(format!("_pool_{}", slot));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create pool profile dir: {}", e))?;
    let url = Url::parse("about:blank").map_err(|e| e.to_string())?;
    tauri::WebviewWindowBuilder::new(app, &lbl, WebviewUrl::External(url))
        .title(format!("Pool worker {}", slot))
        .inner_size(1000.0, 700.0)
        .resizable(false)
        .visible(false)
        .data_directory(dir)
        .build()
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    app.get_webview_window(&lbl)
        .ok_or_else(|| "Не удалось создать окно воркера".to_string())
}

fn free_slot(app: &AppHandle, slot: usize) {
    {
        let mut slots = SLOTS.lock().unwrap_or_else(|p| p.into_inner());
        slots[slot].busy = false;
        slots[slot].last_used = Some(Instant::now());
    }
    schedule_idle_destroy(app, slot);
}

/// Через `IDLE_DESTROY_SECS` закрывает воркер, если им никто не пользовался.
fn schedule_idle_destroy(app: &AppHandle, slot: usize) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(IDLE_DESTROY_SECS)).await;
        // Слот резервируется на время закрытия окна, чтобы его не взяла другая задача
        let reserved = {
            let mut slots = SLOTS.lock().unwrap_or_else(|p| p.into_inner());
            let idle = !slots[slot].busy
                && slots[slot]
                    .last_used
                    .map(|t| t.elapsed() >= Duration::from_secs(IDLE_DESTROY_SECS))
                    .unwrap_or(false);
            if idle {
                slots[slot].busy = true;
            }
            idle
        };
        if !reserved {
            return;
        }
        let lbl = label(slot);
        if let Some(w) = app.get_webview_window(&lbl) {
            let _ = w.destroy();
        }
        for _ in 0..30 {
            if app.get_webview_window(&lbl).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut slots = SLOTS.lock().unwrap_or_else(|p| p.into_inner());
        slots[slot].busy = false;
        slots[slot].last_used = None;
    });
}

/// Ждёт свободный слот и возвращает (слот, окно воркера).
async fn lease(app: &AppHandle) -> Result<(usize, WebviewWindow), String> {
    let deadline = Instant::now() + Duration::from_secs(LEASE_WAIT_SECS);
    loop {
        if let Some(slot) = try_take(app) {
            return match ensure_window(app, slot).await {
                Ok(w) => Ok((slot, w)),
                Err(e) => {
                    free_slot(app, slot);
                    Err(e)
                }
            };
        }
        if Instant::now() > deadline {
            return Err("Нет свободного воркера пула".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

enum Kind {
    /// Воркер пула с куками персонажа из банка
    Pool { slot: usize },
    /// Окно профиля персонажа (прежняя схема)
    Profile { created_here: bool },
}

/// Окно для задачи. Воркер пула возвращается в пул автоматически при `finish` или при выходе из функции с ошибкой.
pub struct TaskWin {
    app: AppHandle,
    window: WebviewWindow,
    kind: Kind,
}

impl TaskWin {
    pub fn window(&self) -> &WebviewWindow {
        &self.window
    }

    /// Для журнала задач.
    pub fn describe(&self) -> &'static str {
        match &self.kind {
            Kind::Pool { .. } => "Воркер пула, сессия из банка кук",
            Kind::Profile { created_here: true } => "Открыт скрытый профиль персонажа",
            Kind::Profile { .. } => "Использую уже открытое окно персонажа",
        }
    }

    /// Завершает задачу.
    /// - `char_id`/`refresh_bank`: после успешной задачи свежие куки персонажа пишутся в банк (только для воркера пула);
    /// - `close_profile`: закрыть окно профиля, если оно создано для этой задачи (только для схемы с профилем).
    pub async fn finish(self, char_id: Option<&str>, close_profile: bool, refresh_bank: bool) {
        match &self.kind {
            Kind::Pool { .. } => {
                if refresh_bank {
                    if let Some(id) = char_id {
                        if let Err(e) = cookie_bank::save_from_window(&self.app, id, &self.window).await {
                            println!("[POOL] не удалось обновить банк для {}: {}", id, e);
                        }
                    }
                }
                // Куки персонажа не должны оставаться в профиле воркера
                cookie_bank::wipe_scope(&self.window).await;
            }
            Kind::Profile { created_here } => dispose(&self.window, *created_here, close_profile),
        }
        // Слот возвращается в пул в Drop
    }
}

impl Drop for TaskWin {
    fn drop(&mut self) {
        if let Kind::Pool { slot } = self.kind {
            free_slot(&self.app, slot);
        }
    }
}

/// Окно для задачи персонажа: воркер пула с его сессией из банка, а если сессии в банке нет, окно его профиля.
pub async fn acquire(app: &AppHandle, char_id: &str, url: &str) -> Result<TaskWin, String> {
    if cookie_bank::has_session(app, char_id) {
        match lease(app).await {
            Ok((slot, window)) => match cookie_bank::restore_into(app, char_id, &window).await {
                Ok(_) => {
                    return Ok(TaskWin {
                        app: app.clone(),
                        window,
                        kind: Kind::Pool { slot },
                    })
                }
                Err(e) => {
                    println!("[POOL] {}: сессия из банка не подставилась ({}), использую профиль", char_id, e);
                    free_slot(app, slot);
                }
            },
            Err(e) => println!("[POOL] {}: воркер недоступен ({}), использую профиль", char_id, e),
        }
    }
    let (window, created_here) = get_or_create_hidden_window(app, char_id, url).await?;
    Ok(TaskWin {
        app: app.clone(),
        window,
        kind: Kind::Profile { created_here },
    })
}

/// То же для сканирования страниц: если указан персонаж с сессией в банке, берётся воркер,
/// иначе прежний выбор окна (`windows::pick_scan_window`).
pub async fn acquire_for_scan(
    app: &AppHandle,
    char_id: Option<String>,
    url: &str,
    fallback_key: &str,
) -> Result<TaskWin, String> {
    match char_id.filter(|s| !s.is_empty()) {
        Some(id) if cookie_bank::has_session(app, &id) => acquire(app, &id, url).await,
        other => {
            let (window, created_here) = pick_scan_window(app, other, url, fallback_key).await?;
            Ok(TaskWin {
                app: app.clone(),
                window,
                kind: Kind::Profile { created_here },
            })
        }
    }
}

/// Состояние пула (для проверки из консоли): `await __TAURI_INTERNALS__.invoke('pool_status')`.
#[command]
pub fn pool_status(app: AppHandle) -> serde_json::Value {
    let slots = SLOTS.lock().unwrap_or_else(|p| p.into_inner());
    let list: Vec<serde_json::Value> = (0..POOL_MAX)
        .map(|i| {
            serde_json::json!({
                "slot": i,
                "busy": slots[i].busy,
                "windowOpen": app.get_webview_window(&label(i)).is_some(),
            })
        })
        .collect();
    serde_json::json!({ "max": POOL_MAX, "idleDestroySeconds": IDLE_DESTROY_SECS, "slots": list })
}

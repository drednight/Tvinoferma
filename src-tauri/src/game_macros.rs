//! User-triggered, bounded keyboard operations. Only main can execute, only verified game clients.
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the main window may control game windows".into())
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pid: u32,
    started_at: u64,
    #[serde(default)]
    hwnd: Option<u64>,
}
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundMethod {
    #[default]
    Post,
    SendTimeout,
    Notify,
    Activity,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InputTiming {
    switch_ms: u64,
    hold_ms: u64,
    background_method: BackgroundMethod,
    activity_foreground: Option<String>,
}
impl Default for InputTiming {
    fn default() -> Self {
        Self {
            switch_ms: 30,
            hold_ms: 30,
            background_method: BackgroundMethod::default(),
            activity_foreground: None,
        }
    }
}
#[tauri::command]
pub fn game_macro_input_idle(
    window: tauri::WebviewWindow,
    chord: Option<String>,
) -> Result<bool, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        win::input_idle(chord.as_deref())
    }
    #[cfg(not(windows))]
    {
        let _ = chord;
        Err("Windows-only".into())
    }
}
#[derive(Serialize)]
pub struct Geometry {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    dpi: u32,
}
#[derive(Clone, Deserialize)]
pub struct Binding {
    id: String,
    chord: String,
}

#[tauri::command]
pub async fn game_macro_overlay(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    topmost: bool,
    position: Option<ScreenPosition>,
    existing_only: bool,
) -> Result<(), String> {
    main_only(&window)?;
    if let Some(overlay) = app.get_webview_window("game-overlay") {
        overlay
            .set_always_on_top(topmost)
            .map_err(|_| "Cannot change overlay mode")?;
        if !existing_only {
            overlay.show().map_err(|_| "Cannot show overlay")?;
        }
        return Ok(());
    }
    if existing_only {
        return Ok(());
    }
    *OVERLAY_EXPANDED_SIZE
        .lock()
        .map_err(|_| "Overlay lock failed")? = None;
    let overlay = tauri::WebviewWindowBuilder::new(
        &app,
        "game-overlay",
        tauri::WebviewUrl::App("game-overlay.html".into()),
    )
    .title("Твиноферма — управление пати")
    .inner_size(430.0, 580.0)
    .min_inner_size(320.0, 52.0)
    .decorations(false)
    .shadow(false)
    .always_on_top(topmost)
    .skip_taskbar(true)
    .transparent(true)
    .build()
    .map_err(|_| "Cannot open overlay")?;
    if let Some(p) =
        position.filter(|p| (-100000..=100000).contains(&p.x) && (-100000..=100000).contains(&p.y))
    {
        if let Ok(monitors) = overlay.available_monitors() {
            if monitors.iter().any(|m| {
                let o = m.position();
                let s = m.size();
                p.x + 100 > o.x
                    && p.x < o.x + s.width as i32 - 60
                    && p.y >= o.y
                    && p.y < o.y + s.height as i32 - 40
            }) {
                let _ = overlay.set_position(tauri::PhysicalPosition::new(p.x, p.y));
            }
        }
    }
    let handle = app.clone();
    overlay.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(pos) = event {
            let _ = handle.emit_to(
                "main",
                "game-overlay-position",
                ScreenPosition { x: pos.x, y: pos.y },
            );
        }
    });
    Ok(())
}
#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct ScreenPosition {
    x: i32,
    y: i32,
}
static GUIDE_TARGET: std::sync::Mutex<Option<(String, Target)>> = std::sync::Mutex::new(None);

static OVERLAY_EXPANDED_SIZE: std::sync::Mutex<Option<tauri::PhysicalSize<u32>>> =
    std::sync::Mutex::new(None);
#[tauri::command]
pub fn game_macro_overlay_fold(
    window: tauri::WebviewWindow,
    collapsed: bool,
) -> Result<(), String> {
    if window.label() != "game-overlay" {
        return Err("Only the overlay can resize itself".into());
    }
    let mut saved = OVERLAY_EXPANDED_SIZE
        .lock()
        .map_err(|_| "Overlay lock failed")?;
    if collapsed {
        if saved.is_none() {
            *saved = Some(
                window
                    .inner_size()
                    .map_err(|_| "Cannot read overlay size")?,
            );
        }
        let size = window
            .inner_size()
            .map_err(|_| "Cannot read overlay size")?;
        window
            .set_resizable(false)
            .map_err(|_| "Cannot lock compact size")?;
        window
            .set_size(tauri::PhysicalSize::new(
                size.width,
                (52.0 * window.scale_factor().unwrap_or(1.0)).round() as u32,
            ))
            .map_err(|_| "Cannot collapse overlay")?;
    } else {
        if let Some(size) = saved.take() {
            window.set_size(size).map_err(|_| "Cannot expand overlay")?;
        }
        window
            .set_resizable(true)
            .map_err(|_| "Cannot unlock overlay size")?;
    }
    Ok(())
}
#[tauri::command]
pub fn game_macro_overlay_preferences(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    opacity: f64,
    topmost: bool,
    appearance: Option<serde_json::Value>,
) -> Result<(), String> {
    if window.label() != "game-overlay" || !opacity.is_finite() || !(0.1..=1.0).contains(&opacity) {
        return Err("Invalid overlay preferences".into());
    }
    window
        .set_always_on_top(topmost)
        .map_err(|_| "Cannot change topmost")?;
    app.emit_to(
        "main",
        "game-overlay-preferences",
        serde_json::json!({"opacity":opacity,"topmost":topmost,"appearance":appearance}),
    )
    .map_err(|_| "Cannot save overlay preferences".into())
}
#[tauri::command]
pub fn game_macro_navigate(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
    party_id: Option<String>,
) -> Result<(), String> {
    if !["main", "game-overlay"].contains(&window.label()) {
        return Err("Untrusted window".into());
    }
    match action.as_str() {
        "party-refresh" | "party-launch" => app
            .emit_to(
                "main",
                "game-overlay-party",
                serde_json::json!({"action":action,"partyId":party_id}),
            )
            .map_err(|_| "Cannot request party action".into()),
        "stop" | "clear-logs" => app
            .emit_to("main", "game-overlay-action", action)
            .map_err(|_| "Cannot send overlay action".into()),
        "settings" | "logs" | "overlay-settings" => {
            let main = app
                .get_webview_window("main")
                .ok_or("Main window unavailable")?;
            main.show().map_err(|_| "Cannot show main window")?;
            let _ = main.unminimize();
            main.set_focus().map_err(|_| "Cannot focus main window")?;
            app.emit_to("main", "game-macro-navigate", action)
                .map_err(|_| "Cannot navigate".into())
        }
        _ => Err("Unknown overlay action".into()),
    }
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn game_macro_guide(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    mode: String,
    width: u32,
    height: u32,
    target: Option<Target>,
    request_id: Option<String>,
    initial_point: Option<PointInput>,
) -> Result<(), String> {
    main_only(&window)?;
    if let Some(old) = app.get_webview_window("game-guide") {
        let _ = old.close();
    }
    let previous = GUIDE_TARGET.lock().map_err(|_| "Guide lock failed")?.take();
    if let Some((id, _)) = previous {
        let _ = app.emit_to(
            "main",
            "game-macro-picked",
            serde_json::json!({"requestId":id,"cancelled":true}),
        );
    }
    if mode == "close" {
        return Ok(());
    }
    if mode != "size" && mode != "point" {
        return Err("Unknown guide mode".into());
    }
    let mut origin: Option<(i32, i32)> = None;
    let request_id = request_id.unwrap_or_default();
    if mode == "point" {
        if request_id.is_empty() || request_id.len() > 80 {
            return Err("Invalid calibration request".into());
        }
        let target = target.ok_or("Select a client for calibration")?;
        let clients = crate::launcher::launcher_running_details().await?;
        let client = clients
            .into_iter()
            .find(|c| {
                c.pid == target.pid
                    && c.started_at == Some(target.started_at)
                    && compatible_integrity(c.elevated, crate::launcher::self_elevated())
            })
            .ok_or("Client identity changed or integrity level is unavailable")?;
        let target = Target {
            hwnd: client.hwnd,
            ..target
        };
        #[cfg(windows)]
        {
            let hwnd = client.hwnd.ok_or("No client window")?;
            win::action(
                hwnd,
                target.pid,
                "focus",
                None,
                None,
                None,
                InputTiming::default(),
            )?;
            origin = Some(
                initial_point
                    .and_then(|point| win::point_origin(hwnd, point).ok())
                    .unwrap_or(win::client_center(hwnd)?),
            );
        }
        #[cfg(not(windows))]
        {
            let _ = (client, initial_point);
        }
        *GUIDE_TARGET.lock().map_err(|_| "Guide lock failed")? = Some((request_id.clone(), target));
    } else if !(160..=8000).contains(&width) || !(160..=8000).contains(&height) {
        return Err("Invalid guide size".into());
    }
    let url =
        format!("game-guide.html?mode={mode}&width={width}&height={height}&requestId={request_id}");
    let guide =
        tauri::WebviewWindowBuilder::new(&app, "game-guide", tauri::WebviewUrl::App(url.into()))
            .title("Твиноферма — экранная рамка")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(mode == "size")
            .min_inner_size(160.0, 160.0)
            .inner_size(280.0, 240.0)
            .build()
            .map_err(|_| "Cannot open guide")?;
    if mode == "size" {
        if let Some(m) = window.current_monitor().ok().flatten() {
            let _ = guide.set_position(*m.position());
        }
        guide
            .set_size(tauri::PhysicalSize::new(width, height))
            .map_err(|_| "Cannot size guide")?;
    }
    if let Some((x, y)) = origin {
        let s = guide.inner_size().map_err(|_| "Cannot read guide size")?;
        let scale = guide.scale_factor().unwrap_or(1.0);
        let _ = guide.set_position(tauri::PhysicalPosition::new(
            x - s.width as i32 / 2,
            y - (44.0 * scale) as i32,
        ));
    }
    let handle = app.clone();
    guide.on_window_event(move |event| {
        if mode == "size" && matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = handle.emit_to(
                "main",
                "game-macro-size-picked",
                serde_json::json!({"requestId":request_id,"cancelled":true}),
            );
        }
        if mode == "point" && matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = handle.emit_to(
                "main",
                "game-macro-picked",
                serde_json::json!({"requestId":request_id,"cancelled":true}),
            );
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn game_macro_guide_result(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    save: bool,
) -> Result<(), String> {
    if window.label() != "game-guide" {
        return Err("Only the guide can confirm its position".into());
    }
    if !save {
        return window.close().map_err(|_| "Cannot close guide".into());
    }
    let url = window.url().map_err(|_| "Cannot read guide mode")?;
    if url
        .query_pairs()
        .any(|(key, value)| key == "mode" && value == "size")
    {
        let size = window.inner_size().map_err(|_| "Cannot read guide size")?;
        if !(160..=8000).contains(&size.width) || !(160..=8000).contains(&size.height) {
            return Err("Invalid guide size".into());
        }
        let id = url
            .query_pairs()
            .find(|(key, _)| key == "requestId")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default();
        app.emit_to(
            "main",
            "game-macro-size-picked",
            serde_json::json!({"requestId":id,"width":size.width,"height":size.height}),
        )
        .map_err(|_| "Cannot apply size")?;
        return window.close().map_err(|_| "Cannot close guide".into());
    }
    let (request_id, target) = GUIDE_TARGET
        .lock()
        .map_err(|_| "Guide lock failed")?
        .clone()
        .ok_or("No calibration in progress")?;
    let clients = crate::launcher::launcher_running_details().await?;
    let client = clients
        .into_iter()
        .find(|c| {
            c.pid == target.pid
                && c.started_at == Some(target.started_at)
                && compatible_integrity(c.elevated, crate::launcher::self_elevated())
        })
        .ok_or("Client identity changed or integrity level is unavailable")?;
    let pos = window
        .outer_position()
        .map_err(|_| "Cannot read marker position")?;
    let size = window.inner_size().map_err(|_| "Cannot read marker size")?;
    let scale = window
        .scale_factor()
        .map_err(|_| "Cannot read marker DPI")?;
    #[cfg(windows)]
    {
        let point = win::capture_at(
            client.hwnd.ok_or("No client window")?,
            pos.x + size.width as i32 / 2,
            pos.y + (44.0 * scale).round() as i32,
        )?;
        app.emit_to(
            "main",
            "game-macro-picked",
            serde_json::json!({"requestId":request_id,"geometry":point}),
        )
        .map_err(|_| "Cannot save calibration")?;
        window.close().map_err(|_| "Cannot close guide".into())
    }
    #[cfg(not(windows))]
    {
        let _ = (client, pos, size, scale, app, request_id);
        Err("Windows-only calibration".into())
    }
}
#[tauri::command]
pub async fn game_macro_action(
    window: tauri::WebviewWindow,
    target: Target,
    action: String,
    key: Option<String>,
    rect: Option<GeometryInput>,
    point: Option<PointInput>,
    timing: Option<InputTiming>,
) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let client =
                crate::launcher::macro_client_at(target.pid, target.started_at, target.hwnd)?;
            if !compatible_integrity(client.elevated, crate::launcher::self_elevated()) {
                return Err("Game client identity changed or access is unavailable".into());
            }
            let hwnd = client.hwnd.ok_or("No game window")?;
            if action == "key-background" {
                let mut report = win::background_key(
                    hwnd,
                    target.pid,
                    key.as_deref().ok_or("Missing key")?,
                    timing.unwrap_or_default(),
                )?;
                report["appElevated"] = serde_json::json!(crate::launcher::self_elevated());
                report["targetElevated"] = serde_json::json!(client.elevated);
                report["identityChecked"] = serde_json::json!(true);
                return Ok(report);
            }
            win::action(
                hwnd,
                target.pid,
                &action,
                key.as_deref(),
                rect,
                point,
                timing.unwrap_or_default(),
            )
            .map(|geometry| serde_json::json!(geometry))
        })
        .await
        .map_err(|_| "Window action failed")?
    }
    #[cfg(not(windows))]
    {
        let _ = (target, action, key, rect, point, timing);
        Err("Game control is Windows-only".into())
    }
}
// Explicit, bounded diagnostics. WM_NULL health probes do not contain keyboard input.
#[tauri::command]
pub async fn game_macro_background_probe(
    window: tauri::WebviewWindow,
    target: Target,
    key: String,
    activity_test: Option<bool>,
) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let client =
                crate::launcher::macro_client_at(target.pid, target.started_at, target.hwnd)?;
            if activity_test.unwrap_or(false)
                && !compatible_integrity(client.elevated, crate::launcher::self_elevated())
            {
                return Err("Game window has higher integrity".into());
            }
            let raw = client.hwnd.ok_or("No game window")?;
            let mut report = if activity_test.unwrap_or(false) {
                win::activity_probe(raw, target.pid)?
            } else {
                win::background_probe(raw, target.pid, &key, true)?
            };
            report["appElevated"] = serde_json::json!(crate::launcher::self_elevated());
            report["targetElevated"] = serde_json::json!(client.elevated);
            report["integrityAllowed"] = serde_json::json!(compatible_integrity(
                client.elevated,
                crate::launcher::self_elevated()
            ));
            report["identityChecked"] = serde_json::json!(true);
            Ok(report)
        })
        .await
        .map_err(|_| "Background probe failed".to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (target, key, activity_test);
        Err("Game control is Windows-only".into())
    }
}
#[derive(Deserialize)]
pub struct GeometryInput {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}
#[derive(Deserialize)]
pub struct PointInput {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    dpi: u32,
}
#[tauri::command]
pub async fn game_macro_bindings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    bindings: Vec<Binding>,
) -> Result<(), String> {
    main_only(&window)?;
    if bindings.len() > 65 {
        return Err("Too many hotkeys".into());
    }
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || win::bindings(app, bindings))
            .await
            .map_err(|_| "Hotkey worker failed")?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, bindings);
        Err("Global hotkeys are Windows-only".into())
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    };
    use std::time::Duration;
    use tauri::Emitter;
    use windows::Win32::Foundation::{
        GetLastError, SetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WIN32_ERROR, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, MonitorFromPoint, ScreenToClient, MONITOR_DEFAULTTONULL,
    };
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::*;
    #[link(name = "user32")]
    unsafe extern "system" {
        #[link_name = "SendNotifyMessageW"]
        fn background_notify(hwnd: *mut std::ffi::c_void, msg: u32, wp: usize, lp: isize) -> i32;
        #[link_name = "SendMessageTimeoutW"]
        fn background_send_timeout(
            hwnd: *mut std::ffi::c_void,
            msg: u32,
            wp: usize,
            lp: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }
    unsafe fn send_background(
        hwnd: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
        method: BackgroundMethod,
    ) -> Result<(), u32> {
        SetLastError(WIN32_ERROR(0));
        let accepted = match method {
            BackgroundMethod::Activity => return Err(87), // Must go through guarded activity_key.
            BackgroundMethod::Post => PostMessageW(Some(hwnd), msg, wp, lp).is_ok(),
            BackgroundMethod::Notify => background_notify(hwnd.0, msg, wp.0, lp.0) != 0,
            BackgroundMethod::SendTimeout => {
                let mut result = 0;
                // BLOCK | ABORTIFHUNG | ERRORONEXIT. Bounded wait; no activation API calls.
                background_send_timeout(hwnd.0, msg, wp.0, lp.0, 0x23, 25, &mut result) != 0
            }
        };
        if accepted {
            Ok(())
        } else {
            Err(GetLastError().0)
        }
    }

    fn verified_window(raw: u64, pid: u32) -> Result<HWND, String> {
        let hwnd = HWND(raw as usize as *mut _);
        let mut actual = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut actual));
            if actual != pid || !IsWindow(Some(hwnd)).as_bool() {
                return Err("Game window disappeared".into());
            }
        }
        Ok(hwnd)
    }
    pub fn background_probe(
        raw: u64,
        pid: u32,
        key: &str,
        health: bool,
    ) -> Result<serde_json::Value, String> {
        let hwnd = verified_window(raw, pid)?;
        let (mods, vk) = chord(key)?;
        unsafe {
            let thread = GetWindowThreadProcessId(hwnd, None);
            let layout = GetKeyboardLayout(thread);
            let sender_layout = GetKeyboardLayout(0);
            let mut class = [0u16; 128];
            let length = GetClassNameW(hwnd, &mut class);
            let mut gui = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            let gui_ok = GetGUIThreadInfo(thread, &mut gui).is_ok();
            let gui_error = if gui_ok { 0 } else { GetLastError().0 };
            let initial_foreground = GetForegroundWindow();
            let mut probes = Vec::new();
            if health {
                for timeout in [25, 100, 250] {
                    verified_window(raw, pid)?;
                    let mut result = 0;
                    SetLastError(WIN32_ERROR(0));
                    let start = std::time::Instant::now();
                    let ok =
                        background_send_timeout(hwnd.0, WM_NULL, 0, 0, 0x23, timeout, &mut result)
                            != 0;
                    let error = if ok { 0 } else { GetLastError().0 };
                    probes.push(serde_json::json!({"timeoutMs":timeout,"ok":ok,"error":error,"elapsedUs":start.elapsed().as_micros() as u64}));
                    // A short successful response makes longer health waits unnecessary.
                    if ok {
                        break;
                    }
                }
            }
            Ok(
                serde_json::json!({"schema":1,"pid":pid,"hwnd":format!("0x{raw:X}"),"threadId":thread,
                "class":String::from_utf16_lossy(&class[..length.max(0) as usize]),
                "visible":IsWindowVisible(hwnd).as_bool(),"minimized":IsIconic(hwnd).as_bool(),"hung":IsHungAppWindow(hwnd).as_bool(),
                "targetForeground":initial_foreground==hwnd,"foregroundChangedDuringProbe":GetForegroundWindow()!=initial_foreground,"capsLock":GetKeyState(0x14)&1!=0,
                "guiAvailable":gui_ok,"guiError":gui_error,"focusIsTarget":gui_ok&&gui.hwndFocus==hwnd,
                "childFocus":gui_ok&&!gui.hwndFocus.0.is_null()&&gui.hwndFocus!=hwnd,
                "captureIsTarget":gui_ok&&gui.hwndCapture==hwnd,
                "senderLayout":format!("0x{:X}",sender_layout.0 as usize),"targetLayout":format!("0x{:X}",layout.0 as usize),
                "vk":vk,"scanSender":MapVirtualKeyW(vk as u32,MAPVK_VK_TO_VSC),
                "scanTarget":MapVirtualKeyExW(vk as u32,MAPVK_VK_TO_VSC,Some(layout)),
                "modifiers":mods,"selectedKeyHeld":GetAsyncKeyState(vk as i32)<0,
                "modifierHeld":([0x10,0x11,0x12,0x5b,0x5c].iter().any(|v|GetAsyncKeyState(*v)<0)),
                "health":probes,"inputSent":false}),
            )
        }
    }
    pub fn background_key(
        raw: u64,
        pid: u32,
        key: &str,
        timing: InputTiming,
    ) -> Result<serde_json::Value, String> {
        if matches!(timing.background_method, BackgroundMethod::Activity) {
            return activity_key(
                raw,
                pid,
                key,
                timing.hold_ms,
                false,
                timing.activity_foreground.as_deref(),
            );
        }
        let hwnd = verified_window(raw, pid)?;
        let mut report = background_probe(raw, pid, key, false)?;
        let (mods, vk) = chord(key)?;
        let alt = mods.contains(&0x12);
        let original = unsafe { GetForegroundWindow() };
        let mut messages = Vec::new();
        let mut failure = None;
        let mut send = |key: u16, up: bool| {
            let scan = unsafe { MapVirtualKeyW(key as u32, MAPVK_VK_TO_VSC) };
            let flags = 1u32
                | ((scan & 0xff) << 16)
                | (u32::from(matches!(key, 0x21..=0x28 | 0x2d | 0x2e)) << 24)
                | (u32::from(alt) << 29)
                | if up { 0xc0000000 } else { 0 };
            let msg = match (alt, up) {
                (true, true) => WM_SYSKEYUP,
                (true, false) => WM_SYSKEYDOWN,
                (false, true) => WM_KEYUP,
                (false, false) => WM_KEYDOWN,
            };
            let start = std::time::Instant::now();
            let result = if verified_window(raw, pid).is_err() {
                Err(1400)
            } else {
                unsafe {
                    send_background(
                        hwnd,
                        msg,
                        WPARAM(key as usize),
                        LPARAM(flags as isize),
                        timing.background_method,
                    )
                }
            };
            messages.push(serde_json::json!({"phase":if up{"up"}else{"down"},"vk":key,"scan":scan,"message":format!("0x{msg:04X}"),"lparam":format!("0x{flags:08X}"),"ok":result.is_ok(),"error":result.err().unwrap_or(0),"elapsedUs":start.elapsed().as_micros() as u64}));
            result
        };
        let mut pressed = Vec::new();
        for key in mods.iter().copied().chain(std::iter::once(vk)) {
            pressed.push(key);
            if let Err(code) = send(key, false) {
                failure = Some(code);
                break;
            }
        }
        if failure.is_none() {
            std::thread::sleep(Duration::from_millis(timing.hold_ms.clamp(10, 200)));
        }
        for key in pressed.into_iter().rev() {
            if let Err(code) = send(key, true) {
                failure.get_or_insert(code);
            }
        }
        let foreground_changed = unsafe { GetForegroundWindow() != original };
        report["inputSent"] = serde_json::json!(true);
        report["messages"] = serde_json::json!(messages);
        report["method"] = serde_json::json!(match timing.background_method {
            BackgroundMethod::Post => "post",
            BackgroundMethod::SendTimeout => "send-timeout",
            BackgroundMethod::Notify => "notify",
            BackgroundMethod::Activity => "activity",
        });
        report["holdMs"] = serde_json::json!(timing.hold_ms.clamp(10, 200));
        report["foregroundChanged"] = serde_json::json!(foreground_changed);
        report["error"] = serde_json::json!(failure);
        report["ok"] = serde_json::json!(failure.is_none() && !foreground_changed);
        Ok(report)
    }
    // Shared guarded protocol: explicit diagnostic or opt-in single-key command, never repeat.
    pub fn activity_probe(raw: u64, pid: u32) -> Result<serde_json::Value, String> {
        activity_key(raw, pid, "B", 30, true, None)
    }
    fn activity_key(
        raw: u64,
        pid: u32,
        key: &str,
        hold_ms: u64,
        diagnostic: bool,
        expected: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let (mods, vk) = chord(key)?;
        static TEST: Mutex<()> = Mutex::new(());
        let _guard = TEST
            .try_lock()
            .map_err(|_| "Activity test already running")?;
        let hwnd = verified_window(raw, pid)?;
        let mut report = background_probe(raw, pid, key, false)?;
        report["activityTest"] = serde_json::json!(true);
        report["holdMs"] = serde_json::json!(hold_ms.clamp(10, 200));
        report["inputSent"] = serde_json::json!(false);
        let original = unsafe { GetForegroundWindow() };
        let mut original_pid = 0;
        let source_thread = unsafe { GetWindowThreadProcessId(original, Some(&mut original_pid)) };
        let foreground_mismatch =
            expected.is_some_and(|value| value != format!("0x{:X}", original.0 as usize));
        let refused = foreground_mismatch
            || !input_idle(None)?
            || original.0.is_null()
            || (original_pid == pid && (diagnostic || original != hwnd))
            || report["visible"] != true
            || report["minimized"] == true
            || report["hung"] == true
            || report["selectedKeyHeld"] == true
            || report["modifierHeld"] == true;
        if refused {
            report["ok"] = serde_json::json!(false);
            report["refused"] = serde_json::json!(true);
            report["foregroundChanged"] = serde_json::json!(foreground_mismatch);
            return Ok(report);
        }
        let changed = std::cell::Cell::new(false);
        let mut steps = Vec::new();
        let failure = std::cell::Cell::new(None);
        let mut send = |phase: &str, msg: u32, wp: usize, lp: isize| {
            let before = unsafe { GetForegroundWindow() };
            changed.set(changed.get() || before != original);
            // Once changed, only key release and restoration are allowed.
            let cleanup = phase.ends_with("-up") || phase.starts_with("restore");
            let valid = verified_window(raw, pid).is_ok();
            if !valid && failure.get().is_none() {
                failure.set(Some(1400));
            }
            if (!cleanup && changed.get()) || !valid {
                steps.push(serde_json::json!({"phase":phase,"skipped":true}));
                return false;
            }
            let result = unsafe {
                send_background(
                    hwnd,
                    msg,
                    WPARAM(wp),
                    LPARAM(lp),
                    BackgroundMethod::SendTimeout,
                )
            };
            failure.set(failure.get().or(result.err()));
            let after = unsafe { GetForegroundWindow() };
            changed.set(changed.get() || after != original);
            steps.push(serde_json::json!({"phase":phase,"wparam":wp,"message":format!("0x{msg:04X}"),"ok":result.is_ok(),"error":result.err().unwrap_or(0),"before":format!("0x{:X}",before.0 as usize),"after":format!("0x{:X}",after.0 as usize)}));
            result.is_ok() && (cleanup || !changed.get())
        };
        // No early return below: always attempt reverse notifications, including timeout paths.
        let notifications = original_pid != pid;
        report["notificationsSent"] = serde_json::json!(notifications);
        let app_ok =
            !notifications || send("activate-app", WM_ACTIVATEAPP, 1, source_thread as isize);
        let window_ok = app_ok
            && (!notifications || send("activate-window", WM_ACTIVATE, 1, original.0 as isize));
        if window_ok {
            // Keep a list even when DOWN times out: every attempted key gets an UP.
            let mut pressed = Vec::new();
            let alt = mods.contains(&0x12);
            let mut key_message = |key: u16, up: bool| {
                let scan = unsafe { MapVirtualKeyW(key as u32, MAPVK_VK_TO_VSC) };
                let flags = 1
                    | ((scan & 0xff) << 16)
                    | (u32::from(matches!(key, 0x21..=0x28 | 0x2d | 0x2e)) << 24)
                    | (u32::from(alt) << 29)
                    | if up { 0xc0000000 } else { 0 };
                let msg = match (alt, up) {
                    (true, true) => WM_SYSKEYUP,
                    (true, false) => WM_SYSKEYDOWN,
                    (false, true) => WM_KEYUP,
                    (false, false) => WM_KEYDOWN,
                };
                let phase = match (key == vk, up) {
                    (true, true) => "key-up",
                    (true, false) => "key-down",
                    (false, true) => "modifier-up",
                    (false, false) => "modifier-down",
                };
                send(phase, msg, key as usize, flags as isize)
            };
            report["inputSent"] = serde_json::json!(true);
            let mut down_ok = true;
            for key in mods.iter().copied().chain(std::iter::once(vk)) {
                pressed.push(key);
                if !key_message(key, false) {
                    down_ok = false;
                    break;
                }
            }
            if down_ok {
                let mut remaining = hold_ms.clamp(10, 200);
                while remaining > 0 {
                    let interval = remaining.min(10);
                    std::thread::sleep(Duration::from_millis(interval));
                    remaining -= interval;
                    if unsafe { GetForegroundWindow() } != original {
                        changed.set(true);
                        break;
                    }
                }
            }
            for key in pressed.into_iter().rev() {
                key_message(key, true);
            }
        }
        if notifications {
            let current = unsafe { GetForegroundWindow() };
            send(
                "restore-window",
                WM_ACTIVATE,
                usize::from(current == hwnd),
                if current == hwnd {
                    original.0 as isize
                } else {
                    current.0 as isize
                },
            );
            let current = unsafe { GetForegroundWindow() };
            let mut current_pid = 0;
            let current_thread =
                unsafe { GetWindowThreadProcessId(current, Some(&mut current_pid)) };
            send(
                "restore-app",
                WM_ACTIVATEAPP,
                usize::from(current_pid == pid),
                if current_pid == pid {
                    source_thread as isize
                } else {
                    current_thread as isize
                },
            );
        }
        changed.set(changed.get() || unsafe { GetForegroundWindow() } != original);
        report["error"] = serde_json::json!(failure.get());
        report["ok"] = serde_json::json!(failure.get().is_none() && !changed.get());
        report["foregroundChanged"] = serde_json::json!(changed.get());
        report["steps"] = serde_json::json!(steps);
        report["originalForeground"] = serde_json::json!(format!("0x{:X}", original.0 as usize));
        Ok(report)
    }
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    static THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
    pub(super) fn chord(text: &str) -> Result<(Vec<u16>, u16), String> {
        let text = text.to_ascii_uppercase();
        let mut parts: Vec<_> = text.split('+').collect();
        let last = parts.pop().ok_or("Empty key")?;
        let key = match last {
            "LEFT" => 0x25,
            "UP" => 0x26,
            "RIGHT" => 0x27,
            "DOWN" => 0x28,
            "SPACE" => 0x20,
            "ENTER" => 0x0d,
            "TAB" => 0x09,
            "PAUSE" => 0x13,
            "HOME" => 0x24,
            s if s.len() == 1 && s.as_bytes()[0].is_ascii_alphanumeric() => s.as_bytes()[0] as u16,
            s if s.starts_with('F') => {
                let n: u16 = s[1..].parse().map_err(|_| "Invalid key")?;
                if !(1..=12).contains(&n) {
                    return Err("Invalid function key".into());
                }
                0x70 + n - 1
            }
            _ => return Err("Key is not allowed".into()),
        };
        let mut mods = Vec::new();
        for p in parts {
            let code = match p {
                "CTRL" => 0x11,
                "ALT" => 0x12,
                "SHIFT" => 0x10,
                _ => return Err("Invalid modifier".into()),
            };
            if mods.contains(&code) {
                return Err("Duplicate modifier".into());
            }
            mods.push(code);
        }
        Ok((mods, key))
    }
    #[cfg(test)]
    mod background_key_tests {
        #[test]
        fn activity_mode_is_explicit_and_parses_modifier_order() {
            let timing: super::InputTiming = serde_json::from_str(
                r#"{"backgroundMethod":"activity","activityForeground":"0x123","holdMs":40}"#,
            )
            .unwrap();
            assert!(matches!(
                timing.background_method,
                super::BackgroundMethod::Activity
            ));
            assert_eq!(timing.activity_foreground.as_deref(), Some("0x123"));
            assert_eq!(super::chord("SHIFT+1").unwrap(), (vec![0x10], 0x31));
            assert!(super::chord("SHIFT+SHIFT+1").is_err());
            assert_eq!(super::chord("F8").unwrap(), (vec![], 0x77));
        }
        #[test]
        fn letter_case_is_a_virtual_key_not_shifted_text() {
            assert_eq!(super::chord("B").unwrap(), (vec![], 0x42));
            assert_eq!(super::chord("b").unwrap(), (vec![], 0x42));
            assert_eq!(super::chord("SHIFT+B").unwrap(), (vec![0x10], 0x42));
        }
    }
    pub fn point_origin(raw: u64, point: PointInput) -> Result<(i32, i32), String> {
        let hwnd = HWND(raw as usize as *mut _);
        let mut r = RECT::default();
        unsafe {
            GetClientRect(hwnd, &mut r).map_err(|_| "Cannot inspect client")?;
            if r.right - r.left != point.width
                || r.bottom - r.top != point.height
                || GetDpiForWindow(hwnd) != point.dpi
                || point.x < 0
                || point.y < 0
                || point.x >= point.width
                || point.y >= point.height
            {
                return Err("Client size or DPI differs from calibration".into());
            }
            let mut p = POINT {
                x: point.x,
                y: point.y,
            };
            if !ClientToScreen(hwnd, &mut p).as_bool() {
                return Err("Cannot convert pointer".into());
            }
            Ok((p.x, p.y))
        }
    }
    pub fn client_center(raw: u64) -> Result<(i32, i32), String> {
        unsafe {
            let hwnd = HWND(raw as usize as *mut _);
            let mut r = RECT::default();
            GetClientRect(hwnd, &mut r).map_err(|_| "Cannot read client")?;
            let mut p = POINT {
                x: (r.right - r.left) / 2,
                y: (r.bottom - r.top) / 2,
            };
            if !ClientToScreen(hwnd, &mut p).as_bool() {
                return Err("Cannot locate client".into());
            }
            Ok((p.x, p.y))
        }
    }
    pub fn capture_at(raw: u64, x: i32, y: i32) -> Result<Geometry, String> {
        unsafe {
            let hwnd = HWND(raw as usize as *mut _);
            let mut r = RECT::default();
            GetClientRect(hwnd, &mut r).map_err(|_| "Cannot read client")?;
            let mut p = POINT { x, y };
            if !ScreenToClient(hwnd, &mut p).as_bool() {
                return Err("Cannot convert point".into());
            }
            let width = r.right - r.left;
            let height = r.bottom - r.top;
            let dpi = GetDpiForWindow(hwnd);
            if !(160..=8000).contains(&width)
                || !(120..=8000).contains(&height)
                || !(48..=768).contains(&dpi)
                || p.x < 0
                || p.y < 0
                || p.x >= width
                || p.y >= height
            {
                return Err("Move the marker cross inside the selected game client".into());
            }
            Ok(Geometry {
                x: p.x,
                y: p.y,
                width,
                height,
                dpi,
            })
        }
    }
    pub(super) fn mouse_message(
        raw: u64,
        x: i32,
        y: i32,
        button: u8,
        up: bool,
        flags: u32,
        double: bool,
    ) -> Result<(), String> {
        let hwnd = HWND(raw as usize as *mut _);
        unsafe {
            let mut point = POINT { x, y };
            let mut r = RECT::default();
            GetClientRect(hwnd, &mut r).map_err(|_| "Cannot read client area")?;
            if !ScreenToClient(hwnd, &mut point).as_bool() {
                return Err("Cannot convert pointer".into());
            }
            let outside = point.x < 0
                || point.y < 0
                || point.x >= r.right
                || point.y >= r.bottom
                || point.x > 32767
                || point.y > 32767;
            if outside && !up {
                return Err("Point is outside client area".into());
            }
            if outside {
                point.x = point.x.clamp(0, r.right.saturating_sub(1).clamp(0, 32767));
                point.y = point.y.clamp(0, r.bottom.saturating_sub(1).clamp(0, 32767));
            }
            let (down, release, dbl, mask) = match button {
                0 => (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, 1),
                1 => (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, 2),
                2 => (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, 16),
                3 | 4 => (
                    WM_XBUTTONDOWN,
                    WM_XBUTTONUP,
                    WM_XBUTTONDBLCLK,
                    if button == 3 { 32 } else { 64 },
                ),
                _ => return Err("Invalid mouse button".into()),
            };
            let position = ((point.y as u32) << 16) | (point.x as u32 & 0xffff);
            let state = if up { flags & !mask } else { flags | mask };
            let state = if button >= 3 {
                state | ((button as u32 - 2) << 16)
            } else {
                state
            };
            PostMessageW(
                Some(hwnd),
                WM_MOUSEMOVE,
                WPARAM(flags as usize),
                LPARAM(position as isize),
            )
            .map_err(|_| "Cannot queue pointer position")?;
            PostMessageW(
                Some(hwnd),
                if up {
                    release
                } else if double {
                    dbl
                } else {
                    down
                },
                WPARAM(state as usize),
                LPARAM(position as isize),
            )
            .map_err(|_| "Cannot queue mouse input")?;
            if outside {
                return Err("Point is outside client area".into());
            }
            Ok(())
        }
    }
    pub(super) fn cursor() -> Result<super::ScreenPoint, String> {
        unsafe {
            let mut p = POINT::default();
            GetCursorPos(&mut p).map_err(|_| "Cannot read pointer")?;
            Ok(super::ScreenPoint { x: p.x, y: p.y })
        }
    }
    pub(super) fn pointer(
        raw: u64,
        pid: u32,
        input: super::PointerInput,
        calibration: Option<PointInput>,
    ) -> Result<Option<Geometry>, String> {
        let hwnd = HWND(raw as usize as *mut _);
        unsafe {
            let mut actual = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut actual));
            if actual != pid || !IsWindow(Some(hwnd)).as_bool() {
                return Err("Game window disappeared".into());
            }
            if !["left", "right", "middle", "x1", "x2"].contains(&input.button.as_str())
                || !(1..=2).contains(&input.count)
                || input
                    .modifiers
                    .iter()
                    .any(|m| !["CTRL", "SHIFT", "ALT"].contains(&m.as_str()))
                || input.modifiers.len() > 3
            {
                return Err("Invalid pointer action".into());
            }
            if input.background && input.modifiers.iter().any(|m| m == "ALT") {
                return Err("Alt-click needs foreground delivery".into());
            }
            let mut r = RECT::default();
            GetClientRect(hwnd, &mut r).map_err(|_| "Cannot read client area")?;
            let dpi = GetDpiForWindow(hwnd);
            let mut screen = POINT {
                x: input.x,
                y: input.y,
            };
            if let Some(p) = calibration {
                if p.width != r.right || p.height != r.bottom || p.dpi != dpi {
                    return Err("Client size or DPI differs from calibration".into());
                }
                screen = POINT { x: p.x, y: p.y };
                if !ClientToScreen(hwnd, &mut screen).as_bool() {
                    return Err("Cannot convert calibration".into());
                }
            }
            let mut local = screen;
            if !ScreenToClient(hwnd, &mut local).as_bool()
                || local.x < 0
                || local.y < 0
                || local.x >= r.right
                || local.y >= r.bottom
            {
                return Err("Point is outside client area".into());
            }
            let geometry = Geometry {
                x: local.x,
                y: local.y,
                width: r.right,
                height: r.bottom,
                dpi,
            };
            if input.check_only {
                return Ok(Some(geometry));
            }
            let button = match input.button.as_str() {
                "left" => 0,
                "right" => 1,
                "middle" => 2,
                "x1" => 3,
                _ => 4,
            };
            if input.background {
                if input.modifiers.iter().any(|m| m == "ALT") {
                    return Err("Alt-click needs foreground delivery".into());
                }
                let flags = if input.modifiers.iter().any(|m| m == "SHIFT") {
                    4
                } else {
                    0
                } | if input.modifiers.iter().any(|m| m == "CTRL") {
                    8
                } else {
                    0
                };
                for i in 0..input.count {
                    if let Err(error) =
                        mouse_message(raw, screen.x, screen.y, button, false, flags, i == 1)
                    {
                        let _ = mouse_message(raw, screen.x, screen.y, button, true, flags, false);
                        return Err(error);
                    }
                    let release =
                        mouse_message(raw, screen.x, screen.y, button, true, flags, false);
                    if let Err(error) = release {
                        let _ = mouse_message(raw, screen.x, screen.y, button, true, flags, false);
                        return Err(error);
                    }
                    if input.count == 2 && i == 0 {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            } else {
                if GetForegroundWindow() != hwnd
                    || [1, 2, 4, 0x10, 0x11, 0x12, 0x5b, 0x5c]
                        .iter()
                        .any(|k| GetAsyncKeyState(*k) < 0)
                {
                    return Err("Focus changed or physical input is held".into());
                }
                SetCursorPos(screen.x, screen.y).map_err(|_| "Cannot position pointer")?;
                let under = WindowFromPoint(screen);
                if GetForegroundWindow() != hwnd
                    || (under != hwnd && !IsChild(hwnd, under).as_bool())
                {
                    return Err("Another window covers the calibrated point".into());
                }
                let key = |vk: u16, up: bool| INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(vk),
                            dwFlags: if up {
                                KEYEVENTF_KEYUP
                            } else {
                                KEYBD_EVENT_FLAGS(0)
                            },
                            ..Default::default()
                        },
                    },
                };
                let mods: Vec<u16> = input
                    .modifiers
                    .iter()
                    .map(|m| match m.as_str() {
                        "SHIFT" => 0x10,
                        "CTRL" => 0x11,
                        _ => 0x12,
                    })
                    .collect();
                let mouse = |up: bool| INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dwFlags: match (button, up) {
                                (0, false) => MOUSEEVENTF_LEFTDOWN,
                                (0, true) => MOUSEEVENTF_LEFTUP,
                                (1, false) => MOUSEEVENTF_RIGHTDOWN,
                                (1, true) => MOUSEEVENTF_RIGHTUP,
                                (2, false) => MOUSEEVENTF_MIDDLEDOWN,
                                (2, true) => MOUSEEVENTF_MIDDLEUP,
                                (_, false) => MOUSEEVENTF_XDOWN,
                                (_, true) => MOUSEEVENTF_XUP,
                            },
                            mouseData: if button >= 3 { button as u32 - 2 } else { 0 },
                            ..Default::default()
                        },
                    },
                };
                let mut events: Vec<INPUT> = mods.iter().map(|vk| key(*vk, false)).collect();
                for _ in 0..input.count {
                    events.extend([mouse(false), mouse(true)]);
                }
                events.extend(mods.iter().rev().map(|vk| key(*vk, true)));
                let sent = SendInput(&events, std::mem::size_of::<INPUT>() as i32);
                if sent != events.len() as u32 {
                    let mut release = vec![mouse(true)];
                    release.extend(mods.iter().rev().map(|vk| key(*vk, true)));
                    let _ = SendInput(&release, std::mem::size_of::<INPUT>() as i32);
                    return Err("Windows did not accept the click".into());
                }
            }
            Ok(Some(geometry))
        }
    }
    pub(super) fn input_idle(raw: Option<&str>) -> Result<bool, String> {
        let mut keys = vec![
            0x01u16, 0x02, 0x04, 0x05, 0x06, 0x10, 0x11, 0x12, 0x5b, 0x5c,
        ];
        if let Some(raw) = raw.filter(|s| !s.is_empty() && !s.contains("WHEEL")) {
            let (mods, key) = chord(raw)?;
            keys.extend(mods);
            keys.push(key);
        }
        Ok(keys
            .into_iter()
            .all(|vk| unsafe { GetAsyncKeyState(vk as i32) } >= 0))
    }
    pub fn action(
        raw: u64,
        pid: u32,
        action: &str,
        key: Option<&str>,
        rect: Option<GeometryInput>,
        point: Option<PointInput>,
        timing: super::InputTiming,
    ) -> Result<Option<Geometry>, String> {
        let hwnd = HWND(raw as usize as *mut _);
        unsafe {
            let mut actual = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut actual));
            if actual != pid || !IsWindow(Some(hwnd)).as_bool() {
                return Err("Game window disappeared".into());
            }
            match action {
                "foreground" => {
                    if GetForegroundWindow() != hwnd {
                        return Err("Not the active game window".into());
                    }
                }
                "focus" => {
                    if IsIconic(hwnd).as_bool() {
                        let _ = ShowWindow(hwnd, SW_RESTORE);
                    }
                    if GetForegroundWindow() != hwnd {
                        let _ = SetForegroundWindow(hwnd);
                        for _ in 0..25 {
                            if GetForegroundWindow() == hwnd {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(10));
                        }
                    }
                    if GetForegroundWindow() != hwnd {
                        return Err("Windows refused game activation".into());
                    }
                    std::thread::sleep(Duration::from_millis(timing.switch_ms.min(500)));
                }
                "key-background" => return Err("Background input requires diagnostics".into()),
                "key" => {
                    if GetForegroundWindow() != hwnd {
                        return Err("Focus changed; command stopped".into());
                    }
                    // Never send through modifiers still physically held after a hotkey.
                    if [0x10, 0x11, 0x12, 0x5b, 0x5c]
                        .iter()
                        .any(|v| GetAsyncKeyState(*v) < 0)
                    {
                        return Err("Release modifier keys and retry".into());
                    }
                    let (mods, key) = chord(key.ok_or("Missing key")?)?;
                    let make = |vk: u16, up: bool| INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VIRTUAL_KEY(vk),
                                dwFlags: if up {
                                    KEYEVENTF_KEYUP
                                } else {
                                    KEYBD_EVENT_FLAGS(0)
                                },
                                ..Default::default()
                            },
                        },
                    };
                    let mut down: Vec<INPUT> = mods.iter().map(|v| make(*v, false)).collect();
                    down.push(make(key, false));
                    let mut up = vec![make(key, true)];
                    up.extend(mods.iter().rev().map(|v| make(*v, true)));
                    let accepted = SendInput(&down, std::mem::size_of::<INPUT>() as i32);
                    if accepted == down.len() as u32 {
                        std::thread::sleep(Duration::from_millis(timing.hold_ms.clamp(10, 200)));
                    }
                    // Always release every potentially pressed key, even after a focus change/partial send.
                    let released = SendInput(&up, std::mem::size_of::<INPUT>() as i32);
                    if released != up.len() as u32 {
                        let _ = SendInput(&up, std::mem::size_of::<INPUT>() as i32);
                    }
                    if accepted != down.len() as u32
                        || released != up.len() as u32
                        || GetForegroundWindow() != hwnd
                    {
                        return Err("Key input incomplete or focus changed".into());
                    }
                }
                "capture" | "preview" | "click" | "right-click" | "client-info" => {
                    let mut r = RECT::default();
                    GetClientRect(hwnd, &mut r).map_err(|_| "Cannot read client area")?;
                    let width = r.right - r.left;
                    let height = r.bottom - r.top;
                    let dpi = GetDpiForWindow(hwnd);
                    let mut pos = POINT::default();
                    if action == "capture" {
                        if GetForegroundWindow() != hwnd {
                            return Err("Activate the calibration game window".into());
                        }
                        GetCursorPos(&mut pos).map_err(|_| "Cannot read pointer")?;
                        if !ScreenToClient(hwnd, &mut pos).as_bool() {
                            return Err("Cannot convert pointer".into());
                        }
                    } else if action != "client-info" {
                        let p = point.ok_or("Missing calibration")?;
                        if width != p.width || height != p.height || dpi != p.dpi || dpi == 0 {
                            return Err("Client size or DPI differs from calibration".into());
                        }
                        pos = POINT { x: p.x, y: p.y };
                    }
                    if !(160..=8000).contains(&width)
                        || !(120..=8000).contains(&height)
                        || !(48..=768).contains(&dpi)
                        || pos.x < 0
                        || pos.y < 0
                        || pos.x >= width
                        || pos.y >= height
                    {
                        return Err("Point is outside client area".into());
                    }
                    if action == "click" || action == "right-click" {
                        if GetForegroundWindow() != hwnd
                            || [0x01, 0x02, 0x10, 0x11, 0x12, 0x5b, 0x5c]
                                .iter()
                                .any(|v| GetAsyncKeyState(*v) < 0)
                        {
                            return Err("Focus changed or physical input is held".into());
                        }
                        let mut screen = pos;
                        if !ClientToScreen(hwnd, &mut screen).as_bool() {
                            return Err("Cannot convert calibration".into());
                        }
                        SetCursorPos(screen.x, screen.y).map_err(|_| "Cannot position pointer")?;
                        let under = WindowFromPoint(screen);
                        if GetForegroundWindow() != hwnd
                            || (under != hwnd && !IsChild(hwnd, under).as_bool())
                        {
                            return Err("Another window covers the calibrated point".into());
                        }
                        let mouse = |up: bool| INPUT {
                            r#type: INPUT_MOUSE,
                            Anonymous: INPUT_0 {
                                mi: MOUSEINPUT {
                                    dwFlags: match (up, action == "right-click") {
                                        (true, true) => MOUSEEVENTF_RIGHTUP,
                                        (true, false) => MOUSEEVENTF_LEFTUP,
                                        (false, true) => MOUSEEVENTF_RIGHTDOWN,
                                        (false, false) => MOUSEEVENTF_LEFTDOWN,
                                    },
                                    ..Default::default()
                                },
                            },
                        };
                        let accepted =
                            SendInput(&[mouse(false)], std::mem::size_of::<INPUT>() as i32);
                        if accepted == 1 {
                            std::thread::sleep(Duration::from_millis(
                                timing.hold_ms.clamp(10, 200),
                            ));
                        }
                        // Separate down/up so polling games can observe the pressed button. Always release.
                        let released =
                            SendInput(&[mouse(true)], std::mem::size_of::<INPUT>() as i32);
                        if released != 1 {
                            let _ = SendInput(&[mouse(true)], std::mem::size_of::<INPUT>() as i32);
                        }
                        if accepted != 1 || released != 1 {
                            return Err("Windows did not accept the click".into());
                        }
                        if GetForegroundWindow() != hwnd {
                            return Err("Focus changed while clicking".into());
                        }
                    }
                    return Ok(Some(Geometry {
                        x: pos.x,
                        y: pos.y,
                        width,
                        height,
                        dpi,
                    }));
                }
                "resize-check" | "client-layout" => {
                    let desired = rect.ok_or("Missing client size")?;
                    if !(160..=8000).contains(&desired.width)
                        || !(160..=8000).contains(&desired.height)
                    {
                        return Err("Invalid client size".into());
                    }
                    if action == "client-layout" {
                        let _ = ShowWindow(hwnd, SW_RESTORE);
                        let mut outer = RECT::default();
                        let mut inner = RECT::default();
                        GetWindowRect(hwnd, &mut outer).map_err(|_| "Cannot read geometry")?;
                        GetClientRect(hwnd, &mut inner).map_err(|_| "Cannot read client area")?;
                        MoveWindow(
                            hwnd,
                            outer.left,
                            outer.top,
                            desired.width + outer.right - outer.left - inner.right + inner.left,
                            desired.height + outer.bottom - outer.top - inner.bottom + inner.top,
                            true,
                        )
                        .map_err(|_| "Cannot resize client")?;
                    }
                }
                "geometry" => {
                    let mut r = RECT::default();
                    GetWindowRect(hwnd, &mut r).map_err(|_| "Cannot read window geometry")?;
                    return Ok(Some(Geometry {
                        x: r.left,
                        y: r.top,
                        width: r.right - r.left,
                        height: r.bottom - r.top,
                        dpi: GetDpiForWindow(hwnd),
                    }));
                }
                "layout" => {
                    let r = rect.ok_or("Missing geometry")?;
                    if !(160..=8000).contains(&r.width)
                        || !(120..=8000).contains(&r.height)
                        || !(-40000..=40000).contains(&r.x)
                        || !(-40000..=40000).contains(&r.y)
                    {
                        return Err("Invalid geometry".into());
                    }
                    // Refuse layouts completely outside the currently connected monitor workspace.
                    let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
                    let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
                    let right = left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
                    let bottom = top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
                    if r.x + 100 > right
                        || r.y + 60 > bottom
                        || r.x + r.width < left + 100
                        || r.y + r.height < top + 60
                    {
                        return Err("Saved monitor is unavailable".into());
                    }
                    if MonitorFromPoint(
                        POINT {
                            x: r.x + 40,
                            y: r.y + 20,
                        },
                        MONITOR_DEFAULTTONULL,
                    )
                    .0
                    .is_null()
                    {
                        return Err("Saved monitor is unavailable".into());
                    }
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                    MoveWindow(hwnd, r.x, r.y, r.width, r.height, true)
                        .map_err(|_| "Cannot move game window")?;
                }
                _ => return Err("Unknown action".into()),
            }
        }
        Ok(None)
    }
    type WheelContext = Option<(tauri::AppHandle, Vec<(String, u32, u16)>)>;
    thread_local! {static WHEEL: std::cell::RefCell<WheelContext> = const { std::cell::RefCell::new(None) };}
    unsafe extern "system" fn wheel_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if code >= 0
            && wp.0 as u32 == WM_MOUSEWHEEL
            && GetAsyncKeyState(0x11) < 0
            && GetAsyncKeyState(0x10) >= 0
            && GetAsyncKeyState(0x12) >= 0
        {
            let mut class = [0u16; 128];
            let len = GetClassNameW(GetForegroundWindow(), &mut class);
            if len > 0 && String::from_utf16_lossy(&class[..len as usize]) == "ElementClient Window"
            {
                let event = &*(lp.0 as *const MSLLHOOKSTRUCT);
                if event.flags & LLMHF_INJECTED == 0 {
                    let up = ((event.mouseData >> 16) as i16) > 0;
                    let key = if up { 0xff01 } else { 0xff02 };
                    let handled = WHEEL.with(|ctx| {
                        let ctx = ctx.borrow();
                        if let Some((app, bindings)) = ctx.as_ref() {
                            if let Some((id, _, _)) = bindings.iter().find(|(_, _, k)| *k == key) {
                                let _ = app.emit_to("main", "game-macro-hotkey", id);
                                return true;
                            }
                        }
                        false
                    });
                    if handled {
                        return LRESULT(1);
                    }
                }
            }
        }
        CallNextHookEx(None, code, wp, lp)
    }
    pub fn bindings(app: tauri::AppHandle, bindings: Vec<Binding>) -> Result<(), String> {
        let parsed: Vec<_> = bindings
            .into_iter()
            .map(|b| {
                let (mods, key) = match b.chord.as_str() {
                    "CTRL+WHEELUP" => (vec![0x11], 0xff01),
                    "CTRL+WHEELDOWN" => (vec![0x11], 0xff02),
                    _ => chord(&b.chord)?,
                };
                let flags = mods.iter().fold(0u32, |v, m| {
                    v | match m {
                        0x11 => 2,
                        0x12 => 1,
                        _ => 4,
                    }
                });
                Ok((b.id, flags, key))
            })
            .collect::<Result<_, String>>()?;
        let mut guard = THREAD.lock().map_err(|_| "Hotkey lock failed")?;
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(thread) = guard.take() {
            let _ = thread.join();
        }
        if parsed.is_empty() {
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::channel();
        *guard = Some(std::thread::spawn(move || unsafe {
            let mut ids = Vec::new();
            let wheel_bindings: Vec<_> = parsed
                .iter()
                .filter(|(_, _, key)| *key >= 0xff01)
                .cloned()
                .collect();
            let hook = if wheel_bindings.is_empty() {
                None
            } else {
                WHEEL.with(|ctx| *ctx.borrow_mut() = Some((app.clone(), wheel_bindings)));
                match SetWindowsHookExW(WH_MOUSE_LL, Some(wheel_hook), None, 0) {
                    Ok(hook) => Some(hook),
                    Err(_) => {
                        WHEEL.with(|ctx| *ctx.borrow_mut() = None);
                        let _ = tx.send(false);
                        return;
                    }
                }
            };
            for (i, (_, mods, key)) in parsed.iter().enumerate() {
                let id = i as i32 + 1;
                if *key >= 0xff01 {
                    continue;
                }
                if RegisterHotKey(None, id, HOT_KEY_MODIFIERS(*mods | 0x4000), *key as u32).is_err()
                {
                    for id in ids {
                        let _ = UnregisterHotKey(None, id);
                    }
                    if let Some(hook) = hook {
                        let _ = UnhookWindowsHookEx(hook);
                    }
                    WHEEL.with(|ctx| *ctx.borrow_mut() = None);
                    let _ = tx.send(false);
                    return;
                }
                ids.push(id);
            }
            let _ = tx.send(true);
            while GENERATION.load(Ordering::SeqCst) == generation {
                let mut message = MSG::default();
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    if message.message == WM_HOTKEY {
                        if let Some((id, _, _)) = parsed.get(message.wParam.0.saturating_sub(1)) {
                            let _ = app.emit_to("main", "game-macro-hotkey", id);
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            for id in ids {
                let _ = UnregisterHotKey(None, id);
            }
            if let Some(hook) = hook {
                let _ = UnhookWindowsHookEx(hook);
            }
            WHEEL.with(|ctx| *ctx.borrow_mut() = None);
        }));
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(true) => Ok(()),
            _ => {
                GENERATION.fetch_add(1, Ordering::SeqCst);
                if let Some(thread) = guard.take() {
                    let _ = thread.join();
                }
                Err("Hotkey is occupied or unavailable; no hotkeys enabled".into())
            }
        }
    }
}

fn compatible_integrity(client: Option<bool>, application: bool) -> bool {
    client == Some(false) || (client == Some(true) && application)
}
#[cfg(test)]
mod integrity_tests {
    use super::compatible_integrity;
    #[test]
    fn elevated_clients_require_an_elevated_application_and_unknown_is_denied() {
        assert!(compatible_integrity(Some(false), false));
        assert!(compatible_integrity(Some(false), true));
        assert!(compatible_integrity(Some(true), true));
        assert!(!compatible_integrity(Some(true), false));
        assert!(!compatible_integrity(None, false));
        assert!(!compatible_integrity(None, true));
    }
}

#[cfg(windows)]
#[path = "game_macro_mirror.rs"]
mod mirror;
#[cfg(windows)]
static MIRROR_CONTROL: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri IPC parameters retain the existing frontend contract.
pub async fn game_macro_mirror(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    operation: String,
    session_id: String,
    targets: Vec<Target>,
    shortcuts: Vec<String>,
    mouse: Option<bool>,
    keyboard: Option<bool>,
    source: Option<Target>,
) -> Result<bool, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = MIRROR_CONTROL
                .lock()
                .map_err(|_| "Mirror control lock failed")?;
            match operation.as_str() {
                "start" => mirror::start(
                    app,
                    session_id,
                    targets,
                    shortcuts,
                    mouse.unwrap_or(false),
                    keyboard.unwrap_or(true),
                    source,
                ),
                "stop" => mirror::stop(&session_id),
                "heartbeat" => mirror::heartbeat(&session_id),
                _ => Err("Unknown mirror operation".into()),
            }
        })
        .await
        .map_err(|_| "Keyboard mirror worker failed")?
    }
    #[cfg(not(windows))]
    {
        let _ = (
            app, operation, session_id, targets, shortcuts, mouse, keyboard, source,
        );
        Err("Game control is Windows-only".into())
    }
}

pub fn shutdown_mirror() {
    #[cfg(windows)]
    if let Ok(_guard) = MIRROR_CONTROL.lock() {
        let _ = mirror::stop("");
    }
}

#[derive(Serialize)]
pub struct ScreenPoint {
    x: i32,
    y: i32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerInput {
    x: i32,
    y: i32,
    button: String,
    count: u8,
    background: bool,
    check_only: bool,
    #[serde(default)]
    modifiers: Vec<String>,
}
#[tauri::command]
pub fn game_macro_cursor(window: tauri::WebviewWindow) -> Result<ScreenPoint, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        win::cursor()
    }
    #[cfg(not(windows))]
    {
        Err("Windows-only".into())
    }
}
#[tauri::command]
pub async fn game_macro_pointer(
    window: tauri::WebviewWindow,
    target: Target,
    input: PointerInput,
    point: Option<PointInput>,
) -> Result<Option<Geometry>, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let c = crate::launcher::macro_client_at(target.pid, target.started_at, target.hwnd)?;
            if !compatible_integrity(c.elevated, crate::launcher::self_elevated()) {
                return Err("Game client identity changed or access is unavailable".into());
            }
            win::pointer(c.hwnd.ok_or("No game window")?, target.pid, input, point)
        })
        .await
        .map_err(|_| "Pointer worker failed")?
    }
    #[cfg(not(windows))]
    {
        let _ = (target, input, point);
        Err("Windows-only".into())
    }
}

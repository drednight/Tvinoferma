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
        serde_json::json!({"opacity":opacity,"topmost":topmost}),
    )
    .map_err(|_| "Cannot save overlay preferences".into())
}
#[tauri::command]
pub fn game_macro_navigate(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
) -> Result<(), String> {
    if !["main", "game-overlay"].contains(&window.label()) {
        return Err("Untrusted window".into());
    }
    match action.as_str() {
        "stop" => app
            .emit_to("main", "game-overlay-action", "stop")
            .map_err(|_| "Cannot stop".into()),
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
pub async fn game_macro_guide(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    mode: String,
    width: u32,
    height: u32,
    target: Option<Target>,
    request_id: Option<String>,
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
        #[cfg(windows)]
        {
            let hwnd = client.hwnd.ok_or("No client window")?;
            win::action(hwnd, target.pid, "focus", None, None, None)?;
            origin = Some(win::client_center(hwnd)?);
        }
        #[cfg(not(windows))]
        {
            let _ = client;
        }
        *GUIDE_TARGET.lock().map_err(|_| "Guide lock failed")? = Some((request_id.clone(), target));
    } else if !(160..=8000).contains(&width) || !(160..=8000).contains(&height) {
        return Err("Invalid guide size".into());
    }
    let url = format!("game-guide.html?mode={mode}&width={width}&height={height}");
    let guide =
        tauri::WebviewWindowBuilder::new(&app, "game-guide", tauri::WebviewUrl::App(url.into()))
            .title("Твиноферма — экранная рамка")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
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
) -> Result<Option<Geometry>, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        let clients = crate::launcher::launcher_running_details().await?;
        let client = clients
            .into_iter()
            .find(|c| {
                c.pid == target.pid
                    && c.started_at == Some(target.started_at)
                    && compatible_integrity(c.elevated, crate::launcher::self_elevated())
            })
            .ok_or("Game client identity changed or access is unavailable")?;
        let hwnd = client.hwnd.ok_or("No game window")?;
        tauri::async_runtime::spawn_blocking(move || {
            win::action(hwnd, target.pid, &action, key.as_deref(), rect, point)
        })
        .await
        .map_err(|_| "Window action failed")?
    }
    #[cfg(not(windows))]
    {
        let _ = (target, action, key, rect, point);
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
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, MonitorFromPoint, ScreenToClient, MONITOR_DEFAULTTONULL,
    };
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::*;
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    static THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
    fn chord(text: &str) -> Result<(Vec<u16>, u16), String> {
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
    pub fn action(
        raw: u64,
        pid: u32,
        action: &str,
        key: Option<&str>,
        rect: Option<GeometryInput>,
        point: Option<PointInput>,
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
                    let _ = SetForegroundWindow(hwnd);
                    std::thread::sleep(Duration::from_millis(80));
                    if GetForegroundWindow() != hwnd {
                        return Err("Windows refused game activation".into());
                    }
                }
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
                        std::thread::sleep(Duration::from_millis(30));
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
                        if SendInput(
                            &[mouse(false), mouse(true)],
                            std::mem::size_of::<INPUT>() as i32,
                        ) != 2
                        {
                            let _ = SendInput(&[mouse(true)], std::mem::size_of::<INPUT>() as i32);
                            return Err("Windows did not accept the click".into());
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

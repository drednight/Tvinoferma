//! User-triggered, bounded keyboard operations. Only main can execute, only verified game clients.
use serde::{Deserialize, Serialize};
use tauri::Manager;

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
) -> Result<(), String> {
    main_only(&window)?;
    if let Some(overlay) = app.get_webview_window("game-overlay") {
        overlay
            .set_always_on_top(topmost)
            .map_err(|_| "Cannot change overlay mode")?;
        overlay.show().map_err(|_| "Cannot show overlay")?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "game-overlay",
        tauri::WebviewUrl::App("game-overlay.html".into()),
    )
    .title("Твиноферма — управление пати")
    .inner_size(430.0, 580.0)
    .min_inner_size(320.0, 300.0)
    .always_on_top(topmost)
    .skip_taskbar(true)
    .transparent(true)
    .build()
    .map_err(|_| "Cannot open overlay")?;
    Ok(())
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
                    && c.elevated == Some(false)
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
    if bindings.len() > 34 {
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
    use windows::Win32::Foundation::{HWND, POINT, RECT};
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
                    let mut events: Vec<INPUT> = mods.iter().map(|v| make(*v, false)).collect();
                    events.push(make(key, false));
                    events.push(make(key, true));
                    events.extend(mods.iter().rev().map(|v| make(*v, true)));
                    if SendInput(&events, std::mem::size_of::<INPUT>() as i32)
                        != events.len() as u32
                    {
                        let mut release = vec![make(key, true)];
                        release.extend(mods.iter().map(|v| make(*v, true)));
                        let _ = SendInput(&release, std::mem::size_of::<INPUT>() as i32);
                        return Err("Windows did not accept all key events".into());
                    }
                }
                "capture" | "preview" | "click" => {
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
                    } else {
                        let p = point.ok_or("Missing calibration")?;
                        if width != p.width || height != p.height || dpi != p.dpi || dpi == 0 {
                            return Err("Client size or DPI differs from calibration".into());
                        }
                        pos = POINT { x: p.x, y: p.y };
                    }
                    if width < 160
                        || height < 120
                        || dpi == 0
                        || pos.x < 0
                        || pos.y < 0
                        || pos.x >= width
                        || pos.y >= height
                    {
                        return Err("Point is outside client area".into());
                    }
                    if action == "click" {
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
                                    dwFlags: if up {
                                        MOUSEEVENTF_LEFTUP
                                    } else {
                                        MOUSEEVENTF_LEFTDOWN
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
    pub fn bindings(app: tauri::AppHandle, bindings: Vec<Binding>) -> Result<(), String> {
        let parsed: Vec<_> = bindings
            .into_iter()
            .map(|b| {
                let (mods, key) = chord(&b.chord)?;
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
            for (i, (_, mods, key)) in parsed.iter().enumerate() {
                let id = i as i32 + 1;
                if RegisterHotKey(None, id, HOT_KEY_MODIFIERS(*mods | 0x4000), *key as u32).is_err()
                {
                    for id in ids {
                        let _ = UnregisterHotKey(None, id);
                    }
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

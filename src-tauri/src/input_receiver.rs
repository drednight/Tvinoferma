//! Opt-in Win32 message receiver. Captures only its own window, never hooks other processes.
#[tauri::command]
pub async fn game_macro_receiver(
    window: tauri::WebviewWindow,
    operation: String,
    key: Option<String>,
    method: Option<crate::game_macros::BackgroundMethod>,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Only main may use the receiver".into());
    }
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            win::control(&operation, key.as_deref(), method)
        })
        .await
        .map_err(|_| "Receiver worker failed".to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (operation, key, method);
        Err("Приёмник доступен только в настольной версии Windows.".into())
    }
}
#[cfg(windows)]
pub fn is_receiver(raw: u64) -> bool {
    win::is_receiver(raw)
}
#[cfg(windows)]
mod win {
    use crate::game_macros::BackgroundMethod;
    use std::sync::Mutex;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;
    #[derive(Default)]
    struct State {
        hwnd: usize,
        text: usize,
        events: Vec<serde_json::Value>,
        sequence: u64,
    }
    static STATE: Mutex<State> = Mutex::new(State {
        hwnd: 0,
        text: 0,
        events: Vec::new(),
        sequence: 0,
    });
    static CONTROL: Mutex<()> = Mutex::new(());
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    pub fn is_receiver(raw: u64) -> bool {
        STATE
            .lock()
            .is_ok_and(|s| s.hwnd != 0 && s.hwnd as u64 == raw)
    }
    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wp: WPARAM,
        lp: LPARAM,
    ) -> LRESULT {
        if matches!(
            message,
            WM_KEYDOWN
                | WM_KEYUP
                | WM_SYSKEYDOWN
                | WM_SYSKEYUP
                | WM_ACTIVATE
                | WM_ACTIVATEAPP
                | WM_SETFOCUS
                | WM_KILLFOCUS
        ) {
            let foreground = unsafe { GetForegroundWindow() } == hwnd;
            let display = if let Ok(mut state) = STATE.lock() {
                state.sequence += 1;
                let n = state.sequence;
                let event = serde_json::json!({"n":n,"message":message,"vk":if matches!(message,WM_KEYDOWN|WM_KEYUP|WM_SYSKEYDOWN|WM_SYSKEYUP){Some(wp.0 as u32)}else{None},"wparam":wp.0,"lparam":lp.0 as u64,"foreground":foreground,"atMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64});
                state.events.push(event);
                if state.events.len() > 200 {
                    state.events.remove(0);
                }
                let text = state
                    .events
                    .iter()
                    .rev()
                    .take(18)
                    .map(|event| format!("{}\r\n", event))
                    .collect::<String>();
                Some((state.text,wide(&format!("OWN WINDOW ONLY — no global capture. API delivery is NOT game acceptance.\r\nLatest messages (newest first):\r\n{text}"))))
            } else {
                None
            };
            if let Some((text, value)) = display {
                if text != 0 {
                    let _ = unsafe { SetWindowTextW(HWND(text as *mut _), PCWSTR(value.as_ptr())) };
                }
            }
        }
        if message == WM_DESTROY {
            if let Ok(mut state) = STATE.lock() {
                if state.hwnd == hwnd.0 as usize {
                    state.hwnd = 0;
                    state.text = 0;
                }
            }
            unsafe {
                PostQuitMessage(0);
            }
            return LRESULT(0);
        }
        // Never execute default Alt shortcuts from a synthetic test message.
        if matches!(message, WM_SYSKEYDOWN | WM_SYSKEYUP) {
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(hwnd, message, wp, lp) }
    }
    fn open() -> Result<(), String> {
        if STATE.lock().map_err(|_| "Receiver state unavailable")?.hwnd != 0 {
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let create = (|| -> Result<HWND, String> {
                unsafe {
                    let instance =
                        HINSTANCE(GetModuleHandleW(None).map_err(|_| "Cannot get module")?.0);
                    let class = WNDCLASSW {
                        lpfnWndProc: Some(procedure),
                        hInstance: instance,
                        lpszClassName: w!("TvinofermaInputReceiverV1"),
                        ..Default::default()
                    };
                    let _ = RegisterClassW(&class);
                    let hwnd = CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        class.lpszClassName,
                        w!("Tvinoferma — own message receiver (not PW)"),
                        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                        CW_USEDEFAULT,
                        CW_USEDEFAULT,
                        820,
                        480,
                        None,
                        None,
                        Some(instance),
                        None,
                    )
                    .map_err(|_| "Cannot create receiver")?;
                    let child=CreateWindowExW(WINDOW_EX_STYLE::default(),w!("STATIC"),w!("Own window only. Run ONE explicit test from Tvinoferma, then refresh the report. No global keyboard capture. Physical keys typed here are also visible."),WS_CHILD|WS_VISIBLE,10,10,780,420,Some(hwnd),None,Some(instance),None).map_err(|_|"Cannot create receiver text");
                    match child {
                        Ok(text) => {
                            let mut state =
                                STATE.lock().map_err(|_| "Receiver state unavailable")?;
                            state.hwnd = hwnd.0 as usize;
                            state.text = text.0 as usize;
                            state.events.clear();
                            state.sequence = 0;
                        }
                        Err(error) => {
                            let _ = DestroyWindow(hwnd);
                            return Err(error.into());
                        }
                    }
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    Ok(hwnd)
                }
            })();
            match create {
                Ok(hwnd) => {
                    if tx.send(Ok(())).is_err() {
                        let _ = unsafe { DestroyWindow(hwnd) };
                        return;
                    }
                    let mut message = MSG::default();
                    while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
                        let _ = unsafe { TranslateMessage(&message) };
                        unsafe {
                            DispatchMessageW(&message);
                        }
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(error));
                }
            }
        });
        rx.recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|_| "Receiver startup timed out".to_string())?
    }
    pub fn control(
        operation: &str,
        key: Option<&str>,
        method: Option<BackgroundMethod>,
    ) -> Result<serde_json::Value, String> {
        let _guard = CONTROL
            .try_lock()
            .map_err(|_| "Receiver operation already running")?;
        if operation == "open" {
            open()?;
        }
        let raw = STATE.lock().map_err(|_| "Receiver state unavailable")?.hwnd as u64;
        let delivery = match operation {
            "send" => {
                if raw == 0 {
                    return Err("Open receiver first".into());
                }
                let key = key.ok_or("Choose a key")?;
                if !matches!(key, "B" | "F8" | "SHIFT+1") {
                    return Err("Receiver test keys: B, F8, SHIFT+1".into());
                }
                Some(crate::game_macros::receiver_send(
                    raw,
                    key,
                    method.ok_or("Choose a method")?,
                )?)
            }
            "close" => {
                if raw != 0 {
                    unsafe {
                        PostMessageW(
                            Some(HWND(raw as usize as *mut _)),
                            WM_CLOSE,
                            WPARAM(0),
                            LPARAM(0),
                        )
                        .map_err(|_| "Cannot close receiver")?;
                    }
                }
                None
            }
            "clear" => {
                let mut s = STATE.lock().map_err(|_| "Receiver state unavailable")?;
                s.events.clear();
                s.sequence = 0;
                let text = s.text;
                drop(s);
                if text != 0 {
                    let value = wide("Messages cleared. Own window only — not PW.");
                    let _ = unsafe { SetWindowTextW(HWND(text as *mut _), PCWSTR(value.as_ptr())) };
                }
                None
            }
            "open" | "read" => None,
            _ => return Err("Unknown receiver operation".into()),
        };
        let state = STATE.lock().map_err(|_| "Receiver state unavailable")?;
        Ok(
            serde_json::json!({"schema":1,"scope":"own-window-only","open":state.hwnd!=0,"events":state.events,"total":state.sequence,"delivery":delivery,"gameAccepted":"unknown"}),
        )
    }
    #[cfg(test)]
    mod tests {
        #[test]
        fn own_window_receives_posted_down_and_up_without_game_access() {
            use crate::game_macros::BackgroundMethod;
            super::control("open", None, None).expect("open own receiver");
            super::control("clear", None, None).unwrap();
            assert!(super::control("send", Some("ALT+F4"), Some(BackgroundMethod::Post)).is_err());
            let sent = super::control("send", Some("B"), Some(BackgroundMethod::Post))
                .expect("send only to own receiver");
            assert_eq!(sent["delivery"]["inputSent"], true);
            let mut received = false;
            for _ in 0..100 {
                let report = super::control("read", None, None).unwrap();
                let events = report["events"].as_array().unwrap();
                let down = events
                    .iter()
                    .position(|event| event["message"] == 256 && event["vk"] == 66);
                let up = events
                    .iter()
                    .position(|event| event["message"] == 257 && event["vk"] == 66);
                if let (Some(down), Some(up)) = (down, up) {
                    assert!(down < up);
                    assert!(events[down]["foreground"].is_boolean());
                    received = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            super::control("close", None, None).unwrap();
            assert!(
                received,
                "own receiver must observe B down/up within one second"
            );
        }
    }
}

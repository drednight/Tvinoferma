//! Opt-in, volatile mirroring. Diagnostic events are bounded and in memory only; no global injection.
use super::{compatible_integrity, Target};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
    mpsc::{sync_channel, Receiver, SyncSender},
    Arc, LazyLock, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::Emitter;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
static CLOCK: LazyLock<Instant> = LazyLock::new(Instant::now);
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
fn now() -> u64 {
    CLOCK.elapsed().as_millis() as u64
}
struct Control {
    stop: AtomicBool,
    reason: AtomicU8,
    lease: AtomicU64,
    failed_input: AtomicU64,
    failed_age: AtomicU64,
}
struct Session {
    id: String,
    control: Arc<Control>,
    thread: JoinHandle<()>,
}
#[derive(Clone)]
struct Client {
    target: Target,
    hwnd: usize,
}
#[derive(Clone, Copy)]
struct Key {
    source: usize,
    at: u64,
    vk: u32,
    scan: u32,
    flags: u32,
    up: bool,
    mouse: Option<Mouse>,
}
#[derive(Clone, Copy)]
struct Mouse {
    x: i32,
    y: i32,
    button: u8,
    flags: u32,
    double: bool,
}
struct Context {
    tx: SyncSender<Key>,
    clients: Vec<Client>,
    shortcuts: Vec<(Vec<u16>, u16)>,
    control: Arc<Control>,
    mouse: bool,
    keyboard: bool,
    source: Option<usize>,
    last_mouse: Option<(usize, u8, i32, i32, u64)>,
}
// Use Windows' time AND movement tolerance; a double click is scoped to one source window.
fn double_click_matches(
    previous: Option<(usize, u8, i32, i32, u64)>,
    current: (usize, u8, i32, i32, u64),
    timeout: u64,
    width: i32,
    height: i32,
) -> bool {
    let Some((source, button, x, y, time)) = previous else {
        return false;
    };
    let (next_source, next_button, next_x, next_y, next_time) = current;
    let dx = i64::from(next_x) - i64::from(x);
    let dy = i64::from(next_y) - i64::from(y);
    let w = i64::from(width.max(1));
    let h = i64::from(height.max(1));
    source == next_source
        && button == next_button
        && next_time >= time
        && next_time - time <= timeout
        && dx >= -(w / 2)
        && dx < (w + 1) / 2
        && dy >= -(h / 2)
        && dy < (h + 1) / 2
}
thread_local! { static CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) }; }
fn halt(control: &Control, reason: u8) {
    control.reason.store(reason, Ordering::SeqCst);
    control.stop.store(true, Ordering::SeqCst);
}
fn modifier_after_event(vk: u32, up: bool, left: u32, right: u32, held: (bool, bool)) -> bool {
    let left_down = if vk == left { !up } else { held.0 };
    let right_down = if vk == right { !up } else { held.1 };
    left_down || right_down
}
unsafe fn keyboard_modifiers(vk: u32, up: bool) -> (bool, bool, bool) {
    let state = |left: u32, right: u32| {
        modifier_after_event(
            vk,
            up,
            left,
            right,
            (
                GetAsyncKeyState(left as i32) < 0,
                GetAsyncKeyState(right as i32) < 0,
            ),
        )
    };
    (state(0xa2, 0xa3), state(0xa0, 0xa1), state(0xa4, 0xa5))
}
fn reserved(vk: u32, ctrl: bool, alt: bool, win: bool) -> bool {
    win || matches!(vk,0x5b..=0x5f|0xa6..=0xb7)
        || (alt && matches!(vk, 0x09 | 0x1b | 0x73))
        || (ctrl && vk == 0x1b)
}
fn source_allowed(selected: Option<usize>, actual: usize) -> bool {
    selected.is_none_or(|source| source == actual)
}
unsafe extern "system" fn hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0
        && matches!(
            wp.0 as u32,
            WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP
        )
    {
        let event = &*(lp.0 as *const KBDLLHOOKSTRUCT);
        if event.flags.0 & LLKHF_INJECTED.0 == 0 {
            CONTEXT.with(|cell| {
                let ctx = cell.borrow();
                let Some(ctx) = ctx.as_ref() else {
                    return;
                };
                if ctx.control.stop.load(Ordering::SeqCst) {
                    return;
                }
                let (ctrl, shift, alt) =
                    keyboard_modifiers(event.vkCode, matches!(wp.0 as u32, WM_KEYUP | WM_SYSKEYUP));
                // Emergency stop works even outside the game. Never suppress the user's input.
                if event.vkCode == 0x13 && ctrl && alt {
                    halt(&ctx.control, 0);
                    return;
                }
                if !ctx.keyboard {
                    return;
                }
                let source = GetForegroundWindow().0 as usize;
                if !source_allowed(ctx.source, source) {
                    return;
                }
                let mut pid = 0;
                GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid));
                if !ctx
                    .clients
                    .iter()
                    .any(|c| c.hwnd == source && c.target.pid == pid)
                {
                    return;
                }
                let system = reserved(
                    event.vkCode,
                    ctrl,
                    alt,
                    GetAsyncKeyState(0x5b) < 0 || GetAsyncKeyState(0x5c) < 0,
                );
                let shortcut = ctx.shortcuts.iter().any(|(mods, key)| {
                    *key as u32 == event.vkCode
                        && mods.contains(&0x11) == ctrl
                        && mods.contains(&0x10) == shift
                        && mods.contains(&0x12) == alt
                });
                // Reset destinations before shortcuts/focus transitions rather than copying OS actions.
                let key = Key {
                    source,
                    mouse: None,
                    at: now(),
                    vk: if system || shortcut { 0 } else { event.vkCode },
                    scan: event.scanCode,
                    flags: event.flags.0,
                    up: matches!(wp.0 as u32, WM_KEYUP | WM_SYSKEYUP),
                };
                if ctx.tx.try_send(key).is_err() {
                    failed_input(&ctx.control, key);
                    halt(&ctx.control, 1);
                }
            });
        }
    }
    CallNextHookEx(None, code, wp, lp)
}
unsafe extern "system" fn mouse_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0
        && matches!(
            wp.0 as u32,
            WM_LBUTTONDOWN
                | WM_LBUTTONUP
                | WM_RBUTTONDOWN
                | WM_RBUTTONUP
                | WM_MBUTTONDOWN
                | WM_MBUTTONUP
                | WM_XBUTTONDOWN
                | WM_XBUTTONUP
        )
    {
        let event = &*(lp.0 as *const MSLLHOOKSTRUCT);
        if event.flags & LLMHF_INJECTED == 0 {
            CONTEXT.with(|cell| {
                let mut ctx = cell.borrow_mut();
                let Some(ctx) = ctx.as_mut() else {
                    return;
                };
                if !ctx.mouse || ctx.control.stop.load(Ordering::SeqCst) {
                    return;
                }
                let hwnd = GetForegroundWindow();
                let source = hwnd.0 as usize;
                if !source_allowed(ctx.source, source) {
                    return;
                }
                let under = WindowFromPoint(event.pt);
                let mut pid = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if !ctx
                    .clients
                    .iter()
                    .any(|c| c.hwnd == source && c.target.pid == pid)
                {
                    return;
                }
                if under != hwnd && !IsChild(hwnd, under).as_bool() {
                    // A click that activates another app still sees the old foreground in
                    // this low-level hook. Do not treat the overlay click as a game failure.
                    ctx.last_mouse = None;
                    let reset = Key {
                        source,
                        at: now(),
                        vk: 0,
                        scan: 0,
                        flags: 0,
                        up: true,
                        mouse: None,
                    };
                    if ctx.tx.try_send(reset).is_err() {
                        halt(&ctx.control, 1);
                    }
                    return;
                }
                let mut p = event.pt;
                let mut r = windows::Win32::Foundation::RECT::default();
                if GetClientRect(hwnd, &mut r).is_err()
                    || !windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut p).as_bool()
                    || p.x < 0
                    || p.y < 0
                    || p.x >= r.right
                    || p.y >= r.bottom
                {
                    // Window borders/title bars are not game input, but not a mode-off request.
                    ctx.last_mouse = None;
                    let reset = Key {
                        source,
                        at: now(),
                        vk: 0,
                        scan: 0,
                        flags: 0,
                        up: true,
                        mouse: None,
                    };
                    if ctx.tx.try_send(reset).is_err() {
                        halt(&ctx.control, 1);
                    }
                    return;
                }
                let msg = wp.0 as u32;
                let button = match msg {
                    WM_LBUTTONDOWN | WM_LBUTTONUP => 0,
                    WM_RBUTTONDOWN | WM_RBUTTONUP => 1,
                    WM_MBUTTONDOWN | WM_MBUTTONUP => 2,
                    _ => {
                        if event.mouseData >> 16 == 1 {
                            3
                        } else {
                            4
                        }
                    }
                };
                let up = matches!(
                    msg,
                    WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP
                );
                let at = now();
                let double = !up
                    && double_click_matches(
                        ctx.last_mouse,
                        (source, button, event.pt.x, event.pt.y, at),
                        GetDoubleClickTime() as u64,
                        GetSystemMetrics(SM_CXDOUBLECLK),
                        GetSystemMetrics(SM_CYDOUBLECLK),
                    );
                if !up {
                    ctx.last_mouse = if double {
                        None
                    } else {
                        Some((source, button, event.pt.x, event.pt.y, at))
                    };
                }
                let flags = if GetAsyncKeyState(0x10) < 0 { 4 } else { 0 }
                    | if GetAsyncKeyState(0x11) < 0 { 8 } else { 0 };
                let key = Key {
                    source,
                    at,
                    vk: 0x100 + button as u32,
                    scan: 0,
                    flags: 0,
                    up,
                    mouse: Some(Mouse {
                        x: event.pt.x,
                        y: event.pt.y,
                        button,
                        flags,
                        double,
                    }),
                };
                if ctx.tx.try_send(key).is_err() {
                    failed_input(&ctx.control, key);
                    halt(&ctx.control, 1);
                }
            });
        }
    }
    CallNextHookEx(None, code, wp, lp)
}
fn verify(client: &Client) -> bool {
    crate::launcher::macro_client_at(
        client.target.pid,
        client.target.started_at,
        Some(client.hwnd as u64),
    )
    .is_ok_and(|c| {
        c.hwnd == Some(client.hwnd as u64)
            && compatible_integrity(c.elevated, crate::launcher::self_elevated())
    })
}
fn message(key: Key, up: bool, repeat: bool) -> (u32, u32, u32) {
    let vk = match key.vk {
        0xa0 | 0xa1 => 0x10,
        0xa2 | 0xa3 => 0x11,
        0xa4 | 0xa5 => 0x12,
        x => x,
    };
    let alt = key.flags & LLKHF_ALTDOWN.0 != 0 || vk == 0x12;
    let flags = 1u32
        | ((key.scan & 0xff) << 16)
        | (u32::from(key.flags & LLKHF_EXTENDED.0 != 0) << 24)
        | (u32::from(alt) << 29)
        | if up {
            0xc0000000
        } else if repeat {
            0x40000000
        } else {
            0
        };
    let msg = match (alt, up) {
        (true, true) => WM_SYSKEYUP,
        (true, false) => WM_SYSKEYDOWN,
        (false, true) => WM_KEYUP,
        (false, false) => WM_KEYDOWN,
    };
    (msg, vk, flags)
}
unsafe fn post(hwnd: usize, key: Key, up: bool, repeat: bool) -> Result<(), u8> {
    if let Some(m) = key.mouse {
        return super::win::mouse_message(
            hwnd as u64,
            m.x,
            m.y,
            m.button,
            up,
            m.flags,
            m.double && !up,
        )
        .map_err(|error| {
            if error == "Point is outside client area" {
                6
            } else {
                4
            }
        });
    }
    let (msg, vk, flags) = message(key, up, repeat);
    PostMessageW(
        Some(HWND(hwnd as *mut _)),
        msg,
        WPARAM(vk as usize),
        LPARAM(flags as isize),
    )
    .map_err(|_| 4)
}

fn release(clients: &[Client], held: &mut HashMap<usize, HashMap<u32, (Key, Instant)>>) {
    for (hwnd, keys) in held.drain() {
        if clients.iter().any(|c| c.hwnd == hwnd && verify(c)) {
            for (_, (key, _)) in keys {
                unsafe {
                    let _ = post(hwnd, key, true, false);
                }
            }
        }
    }
}
fn failed_input(control: &Control, key: Key) {
    control
        .failed_input
        .store(key.vk as u64 | (u64::from(key.up) << 32), Ordering::SeqCst);
    control
        .failed_age
        .store(now().saturating_sub(key.at), Ordering::SeqCst);
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InputTrace {
    vk: u32,
    up: bool,
    recipients: u32,
    age_ms: u64,
    repetitions: u32,
}
struct TraceLog {
    app: tauri::AppHandle,
    id: String,
    pending: Vec<InputTrace>,
    flushed: Instant,
    omitted: u32,
}
impl TraceLog {
    fn record(&mut self, key: Key, recipients: u32) {
        let age = now().saturating_sub(key.at);
        if let Some(last) = self.pending.last_mut() {
            if last.vk == key.vk && last.up == key.up && last.recipients == recipients {
                last.repetitions = last.repetitions.saturating_add(1);
                last.age_ms = last.age_ms.max(age);
                return;
            }
        }
        if self.pending.len() < 64 {
            self.pending.push(InputTrace {
                vk: key.vk,
                up: key.up,
                recipients,
                age_ms: age,
                repetitions: 1,
            });
        } else {
            self.omitted = self.omitted.saturating_add(1);
        }
    }
    fn flush(&mut self, force: bool) {
        if !force && self.flushed.elapsed() < Duration::from_millis(100) {
            return;
        }
        self.flushed = Instant::now();
        if self.pending.is_empty() && self.omitted == 0 {
            return;
        }
        let _=self.app.emit_to("main","game-macro-mirror-input",serde_json::json!({"sessionId":self.id,"events":std::mem::take(&mut self.pending),"omitted":std::mem::take(&mut self.omitted)}));
    }
}
fn forward(
    rx: Receiver<Key>,
    clients: Vec<Client>,
    control: Arc<Control>,
    app: tauri::AppHandle,
    id: String,
) {
    let mut trace = TraceLog {
        app,
        id,
        pending: Vec::new(),
        flushed: Instant::now(),
        omitted: 0,
    };
    let mut held: HashMap<usize, HashMap<u32, (Key, Instant)>> = HashMap::new();
    let mut previous = 0;
    while !control.stop.load(Ordering::SeqCst) {
        trace.flush(false);
        if now().saturating_sub(control.lease.load(Ordering::SeqCst)) > 3000 {
            halt(&control, 2);
            break;
        }
        if held.values().any(|keys| {
            keys.values()
                .any(|(_, at)| at.elapsed() > Duration::from_secs(60))
        }) {
            halt(&control, 5);
            break;
        }
        let foreground = unsafe { GetForegroundWindow().0 as usize };
        if foreground != previous {
            release(&clients, &mut held);
            previous = foreground;
        }
        let Ok(key) = rx.recv_timeout(Duration::from_millis(10)) else {
            continue;
        };
        if now().saturating_sub(key.at) > 250 {
            failed_input(&control, key);
            trace.record(key, 0);
            halt(&control, 1);
            break;
        }
        if key.vk == 0 {
            release(&clients, &mut held);
            continue;
        }
        if key.source != unsafe { GetForegroundWindow().0 as usize } {
            release(&clients, &mut held);
            continue;
        }
        if !clients.iter().any(|c| c.hwnd == key.source && verify(c)) {
            halt(&control, 3);
            break;
        }
        let mut delivered = 0;
        for client in clients.iter().filter(|c| c.hwnd != key.source) {
            if control.stop.load(Ordering::SeqCst) {
                break;
            }
            if !verify(client) {
                halt(&control, 3);
                break;
            }
            if control.stop.load(Ordering::SeqCst)
                || key.source != unsafe { GetForegroundWindow().0 as usize }
            {
                release(&clients, &mut held);
                break;
            }
            if now().saturating_sub(key.at) > 250 {
                failed_input(&control, key);
                halt(&control, 1);
                break;
            }
            let keys = held.entry(client.hwnd).or_default();
            // Ignore unmatched releases (keys held before activation were never copied).
            if key.up && !keys.contains_key(&key.vk) {
                continue;
            }
            let repeat = !key.up && keys.contains_key(&key.vk);
            if !key.up {
                keys.insert(key.vk, (key, Instant::now()));
            }
            if let Err(reason) = unsafe { post(client.hwnd, key, key.up, repeat) } {
                failed_input(&control, key);
                halt(&control, reason);
                break;
            }
            delivered += 1;
            if key.up {
                keys.remove(&key.vk);
            }
        }
        trace.record(key, delivered);
    }
    trace.flush(true);
    release(&clients, &mut held);
}
pub fn stop(id: &str) -> Result<bool, String> {
    let mut guard = SESSION.lock().map_err(|_| "Mirror lock failed")?;
    if guard.as_ref().is_some_and(|s| id.is_empty() || s.id == id) {
        if let Some(session) = guard.take() {
            session.control.stop.store(true, Ordering::SeqCst);
            let _ = session.thread.join();
        }
    }
    Ok(false)
}
pub fn heartbeat(id: &str) -> Result<bool, String> {
    let guard = SESSION.lock().map_err(|_| "Mirror lock failed")?;
    if let Some(session) = guard
        .as_ref()
        .filter(|s| s.id == id && !s.control.stop.load(Ordering::SeqCst))
    {
        session.control.lease.store(now(), Ordering::SeqCst);
        return Ok(true);
    }
    Ok(false)
}
pub fn start(
    app: tauri::AppHandle,
    id: String,
    targets: Vec<Target>,
    shortcuts: Vec<String>,
    mouse: bool,
    keyboard: bool,
    source: Option<Target>,
) -> Result<bool, String> {
    if id.is_empty()
        || id.len() > 80
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || !(2..=30).contains(&targets.len())
        || shortcuts.len() > 65
        || (!mouse && !keyboard)
    {
        return Err("Invalid mirror configuration".into());
    }
    let parsed = shortcuts
        .iter()
        .map(|s| super::win::chord(s))
        .collect::<Result<Vec<_>, _>>()?;
    let mut clients = Vec::new();
    for target in targets {
        let c = crate::launcher::macro_client(target.pid, target.started_at)?;
        if !compatible_integrity(c.elevated, crate::launcher::self_elevated()) {
            return Err("Game client identity changed or access is unavailable".into());
        }
        let hwnd = c.hwnd.ok_or("No game window")? as usize;
        if clients
            .iter()
            .any(|c: &Client| c.target.pid == target.pid || c.hwnd == hwnd)
        {
            return Err("Duplicate mirror target".into());
        }
        clients.push(Client { target, hwnd });
    }
    let source_hwnd = if let Some(source) = source {
        Some(
            clients
                .iter()
                .find(|c| {
                    c.target.pid == source.pid
                        && c.target.started_at == source.started_at
                        && source.hwnd.is_none_or(|hwnd| hwnd == c.hwnd as u64)
                })
                .ok_or("Mirror source is not a verified snapshot client")?
                .hwnd,
        )
    } else {
        None
    };
    stop("")?;
    let control = Arc::new(Control {
        stop: AtomicBool::new(false),
        reason: AtomicU8::new(0),
        lease: AtomicU64::new(now()),
        failed_input: AtomicU64::new(0),
        failed_age: AtomicU64::new(0),
    });
    let thread_control = control.clone();
    let thread_id = id.clone();
    let (ready_tx, ready_rx) = sync_channel(1);
    let thread = std::thread::spawn(move || unsafe {
        let (tx, rx) = sync_channel(256);
        CONTEXT.with(|ctx| {
            *ctx.borrow_mut() = Some(Context {
                tx,
                clients: clients.clone(),
                shortcuts: parsed,
                control: thread_control.clone(),
                mouse,
                keyboard,
                source: source_hwnd,
                last_mouse: None,
            })
        });
        let module = GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0));
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module, 0);
        match hook {
            Ok(hook) => {
                let mouse_hook = if mouse {
                    match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0) {
                        Ok(h) => Some(h),
                        Err(_) => {
                            let _ = UnhookWindowsHookEx(hook);
                            CONTEXT.with(|ctx| *ctx.borrow_mut() = None);
                            let _ = ready_tx.send(false);
                            return;
                        }
                    }
                } else {
                    None
                };
                let worker_control = thread_control.clone();
                let worker_app = app.clone();
                let worker_id = thread_id.clone();
                let worker = std::thread::spawn(move || {
                    forward(rx, clients, worker_control, worker_app, worker_id)
                });
                let _ = ready_tx.send(true);
                while !thread_control.stop.load(Ordering::SeqCst) {
                    let mut message = MSG::default();
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                let _ = UnhookWindowsHookEx(hook);
                if let Some(hook) = mouse_hook {
                    let _ = UnhookWindowsHookEx(hook);
                }
                CONTEXT.with(|ctx| *ctx.borrow_mut() = None);
                let _ = worker.join();
            }
            Err(_) => {
                let _ = ready_tx.send(false);
                CONTEXT.with(|ctx| *ctx.borrow_mut() = None);
            }
        }
        let failed = thread_control.failed_input.load(Ordering::SeqCst);
        let failure = if failed == 0 {
            None
        } else {
            Some(
                serde_json::json!({"vk":failed as u32,"up":failed>>32!=0,"ageMs":thread_control.failed_age.load(Ordering::SeqCst)}),
            )
        };
        let _=app.emit_to("main","game-macro-mirror-state",serde_json::json!({"sessionId":thread_id,"active":false,"reason":thread_control.reason.load(Ordering::SeqCst),"failedInput":failure}));
    });
    let ready = ready_rx
        .recv_timeout(Duration::from_secs(3))
        .unwrap_or(false);
    if !ready {
        control.stop.store(true, Ordering::SeqCst);
        let _ = thread.join();
        return Err("Keyboard mirror unavailable".into());
    }
    *SESSION.lock().map_err(|_| "Mirror lock failed")? = Some(Session {
        id,
        control,
        thread,
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn doubles_allow_system_jitter_but_not_other_sources_buttons_or_late_clicks() {
        let previous = Some((10, 0, 100, 100, 1000));
        assert!(double_click_matches(
            previous,
            (10, 0, 101, 99, 1300),
            500,
            4,
            4
        ));
        assert!(!double_click_matches(
            previous,
            (10, 0, 104, 100, 1300),
            500,
            4,
            4
        ));
        assert!(!double_click_matches(
            previous,
            (20, 0, 100, 100, 1300),
            500,
            4,
            4
        ));
        assert!(!double_click_matches(
            previous,
            (10, 1, 100, 100, 1300),
            500,
            4,
            4
        ));
        assert!(!double_click_matches(
            previous,
            (10, 0, 100, 100, 1600),
            500,
            4,
            4
        ));
        assert!(!double_click_matches(
            None,
            (10, 0, 100, 100, 1300),
            500,
            4,
            4
        ));
    }
    #[test]
    fn leader_source_does_not_accept_other_clients() {
        assert!(source_allowed(None, 20));
        assert!(source_allowed(Some(10), 10));
        assert!(!source_allowed(Some(10), 20));
    }
    #[test]
    fn physical_modifier_transition_overrides_stale_async_state_without_releasing_other_side() {
        assert!(modifier_after_event(
            0xa0,
            false,
            0xa0,
            0xa1,
            (false, false)
        ));
        assert!(!modifier_after_event(0xa0, true, 0xa0, 0xa1, (true, false)));
        assert!(modifier_after_event(0xa0, true, 0xa0, 0xa1, (true, true)));
        assert!(modifier_after_event(0x41, false, 0xa2, 0xa3, (false, true)));
    }
    fn key(vk: u32, flags: u32) -> Key {
        Key {
            source: 0,
            mouse: None,
            at: 0,
            vk,
            scan: 0x2a,
            flags,
            up: false,
        }
    }
    #[test]
    fn messages_preserve_shift_release_repeat_and_alt_context() {
        let (msg, vk, flags) = message(key(0xa0, 0), false, false);
        assert_eq!((msg, vk), (WM_KEYDOWN, 0x10));
        assert_eq!((flags >> 16) & 0xff, 0x2a);
        assert_eq!(
            message(key(0xa0, 0), true, false).2 & 0xc0000000,
            0xc0000000
        );
        assert_eq!(
            message(key(0x70, 0), false, true).2 & 0x40000000,
            0x40000000
        );
        assert_eq!(
            message(key(0xa4, LLKHF_ALTDOWN.0), true, false).0,
            WM_SYSKEYUP
        );
        assert_ne!(
            message(key(0x71, LLKHF_EXTENDED.0), false, false).2 & 0x01000000,
            0
        );
    }
    #[test]
    fn excludes_system_actions_not_normal_shift_chords() {
        assert!(reserved(0x73, false, true, false));
        assert!(reserved(0x09, false, true, false));
        assert!(reserved(0x1b, true, false, false));
        assert!(reserved(0x41, false, false, true));
        assert!(!reserved(0x31, false, false, false));
        assert!(!reserved(0x76, true, false, false));
    }
}

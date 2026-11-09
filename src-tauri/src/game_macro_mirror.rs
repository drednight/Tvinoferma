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
    twins_modifier: u8,
    active_modifier: u8,
    local_buttons: u8,
    twins_source: Option<usize>,
    exclusive_left: bool,
    last_exclusive: bool,
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
// Only explicit Ctrl/Alt/Shift combinations; no arbitrary keys or OS-reserved Win gesture.
fn twins_modifier_mask(value: &str) -> Result<u8, String> {
    match value {
        "CTRL" => Ok(1),
        "SHIFT" => Ok(2),
        "ALT" => Ok(4),
        "CTRL+SHIFT" => Ok(3),
        "CTRL+ALT" => Ok(5),
        "ALT+SHIFT" => Ok(6),
        "CTRL+ALT+SHIFT" => Ok(7),
        _ => Err("Invalid twins mouse modifier".into()),
    }
}
fn twins_modifier_key(mask: u8, vk: u32) -> bool {
    (mask & 1 != 0 && matches!(vk, 0x11 | 0xa2 | 0xa3))
        || (mask & 2 != 0 && matches!(vk, 0x10 | 0xa0 | 0xa1))
        || (mask & 4 != 0 && matches!(vk, 0x12 | 0xa4 | 0xa5))
}
fn twins_gesture(mask: u8, held: u8, win: bool) -> bool {
    mask != 0 && mask == held && !win
}
// Decide local-only per press, never per release: pressing a modifier mid-drag must
// still forward an already mirrored release; releasing the modifier must not leak a local up.
fn local_mouse_route(button: u8, up: bool, armed: bool, local_buttons: &mut u8) -> bool {
    let bit = 1u8 << button;
    if up {
        let local = *local_buttons & bit != 0;
        *local_buttons &= !bit;
        local
    } else if armed {
        *local_buttons |= bit;
        true
    } else {
        *local_buttons &= !bit;
        false
    }
}
fn twins_left_route(up: bool, captured: bool, armed: bool) -> bool {
    if up {
        captured
    } else {
        armed
    }
}
fn mouse_flags(exclusive: bool, held: u8) -> u32 {
    if exclusive {
        0
    } else {
        (u32::from(held & 1) * 8) | (u32::from((held >> 1) & 1) * 4)
    }
}
unsafe fn held_mouse_modifiers() -> u8 {
    u8::from(GetAsyncKeyState(0x11) < 0)
        | (u8::from(GetAsyncKeyState(0x10) < 0) << 1)
        | (u8::from(GetAsyncKeyState(0x12) < 0) << 2)
}
// Bounded Win32 checks only in the hook; exact process/start-time checks remain in the worker.
unsafe fn mouse_destination_ready(
    client: &Client,
    point: windows::Win32::Foundation::POINT,
) -> bool {
    let hwnd = HWND(client.hwnd as *mut _);
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let mut p = point;
    let mut rect = windows::Win32::Foundation::RECT::default();
    pid == client.target.pid
        && IsWindow(Some(hwnd)).as_bool()
        && IsWindowVisible(hwnd).as_bool()
        && !IsIconic(hwnd).as_bool()
        && GetClientRect(hwnd, &mut rect).is_ok()
        && windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut p).as_bool()
        && p.x >= 0
        && p.y >= 0
        && p.x < rect.right
        && p.y < rect.bottom
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
                // The chosen gesture modifiers are local controls, not copied keyboard input.
                // Still pass all physical keyboard events to the PL and preserve emergency stop.
                if ctx.mouse
                    && ctx.twins_source == Some(source)
                    && twins_modifier_key(ctx.twins_modifier, event.vkCode)
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
    let mut suppress = false;
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
                if up && local_mouse_route(button, true, false, &mut ctx.local_buttons) {
                    ctx.last_mouse = None;
                    return;
                }
                // Pair the release with the captured down, even after modifier/focus changes.
                let captured_up =
                    wp.0 as u32 == WM_LBUTTONUP && std::mem::take(&mut ctx.exclusive_left);
                suppress = captured_up;
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
                if !up
                    && local_mouse_route(
                        button,
                        false,
                        twins_gesture(
                            ctx.active_modifier,
                            held_mouse_modifiers(),
                            GetAsyncKeyState(0x5b) < 0 || GetAsyncKeyState(0x5c) < 0,
                        ),
                        &mut ctx.local_buttons,
                    )
                {
                    ctx.last_mouse = None;
                    return;
                }
                let exclusive = button == 0
                    && twins_left_route(
                        up,
                        captured_up,
                        msg == WM_LBUTTONDOWN
                            && ctx.twins_source == Some(source)
                            && twins_gesture(
                                ctx.twins_modifier,
                                held_mouse_modifiers(),
                                GetAsyncKeyState(0x5b) < 0 || GetAsyncKeyState(0x5c) < 0,
                            ),
                    );
                if exclusive && !up {
                    // Fail closed: never turn a twins-only gesture into an accidental PL click.
                    suppress = true;
                    ctx.exclusive_left = true;
                    if !ctx
                        .clients
                        .iter()
                        .all(|client| mouse_destination_ready(client, event.pt))
                    {
                        halt(&ctx.control, 3);
                        return;
                    }
                }
                if !up && ctx.last_exclusive != exclusive {
                    ctx.last_mouse = None;
                }
                if !up {
                    ctx.last_exclusive = exclusive;
                }
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
                let flags = mouse_flags(exclusive, held_mouse_modifiers());
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
    if suppress {
        LRESULT(1)
    } else {
        CallNextHookEx(None, code, wp, lp)
    }
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
// Keep all blocking calls off the input hook. Each key delivery is bounded at 25 ms.
#[link(name = "user32")]
unsafe extern "system" {
    #[link_name = "SendNotifyMessageW"]
    fn mirror_notify(hwnd: *mut std::ffi::c_void, msg: u32, wp: usize, lp: isize) -> i32;
    #[link_name = "SendMessageTimeoutW"]
    fn mirror_timeout(
        hwnd: *mut std::ffi::c_void,
        msg: u32,
        wp: usize,
        lp: isize,
        flags: u32,
        timeout: u32,
        result: *mut usize,
    ) -> isize;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyboardMethod {
    Post,
    ActivityNotify,
    Combined,
}
impl KeyboardMethod {
    pub fn parse(value: Option<&str>, legacy_combined: bool) -> Result<Self, String> {
        match value {
            Some("post") => Ok(Self::Post),
            Some("activity-notify") => Ok(Self::ActivityNotify),
            Some("combined") => Ok(Self::Combined),
            None => Ok(if legacy_combined {
                Self::Combined
            } else {
                Self::Post
            }),
            _ => Err("Unknown keyboard repeat method".into()),
        }
    }
    fn posts(self) -> bool {
        self != Self::ActivityNotify
    }
    fn activity(self) -> bool {
        self != Self::Post
    }
}
fn modifier_release_order(vk: u32) -> bool {
    matches!(vk, 0x10..=0x12 | 0xa0..=0xa5)
}
fn suppress_repeat(hold_only: bool, repeated_down: bool, mouse: bool) -> bool {
    hold_only && repeated_down && !mouse
}
unsafe fn combined_key(
    hwnd: usize,
    source: usize,
    msg: u32,
    vk: u32,
    flags: u32,
) -> Result<(), u8> {
    let raw = hwnd as *mut std::ffi::c_void;
    let original = GetForegroundWindow();
    let release = matches!(msg, WM_KEYUP | WM_SYSKEYUP);
    if !release && original.0 as usize != source {
        return Err(10);
    }
    let thread = GetWindowThreadProcessId(original, None);
    let app = mirror_notify(raw, WM_ACTIVATEAPP, 1, thread as isize) != 0;
    let window = mirror_notify(raw, WM_ACTIVATE, 1, original.0 as isize) != 0;
    let mut result = 0usize;
    let sent = (release || (app && window && GetForegroundWindow() == original))
        && mirror_timeout(
            raw,
            msg,
            vk as usize,
            flags as isize,
            0x0002 | 0x0020,
            25,
            &mut result,
        ) != 0;
    // Restore notification state even on failure; never call SetFocus/SetForegroundWindow.
    let current = GetForegroundWindow();
    let mut current_pid = 0;
    let current_thread = GetWindowThreadProcessId(current, Some(&mut current_pid));
    let mut target_pid = 0;
    GetWindowThreadProcessId(HWND(raw), Some(&mut target_pid));
    let restored_window = mirror_notify(
        raw,
        WM_ACTIVATE,
        usize::from(current.0 as usize == hwnd),
        current.0 as isize,
    ) != 0;
    let restored_app = mirror_notify(
        raw,
        WM_ACTIVATEAPP,
        usize::from(current_pid == target_pid),
        current_thread as isize,
    ) != 0;
    if GetForegroundWindow() != original {
        Err(10)
    } else if !app || !window {
        Err(7)
    } else if !sent {
        Err(8)
    } else if !restored_window || !restored_app {
        Err(9)
    } else {
        Ok(())
    }
}
unsafe fn post(
    hwnd: usize,
    key: Key,
    up: bool,
    repeat: bool,
    method: KeyboardMethod,
) -> Result<(), u8> {
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
    let posted = if method.posts() {
        PostMessageW(
            Some(HWND(hwnd as *mut _)),
            msg,
            WPARAM(vk as usize),
            LPARAM(flags as isize),
        )
        .map_err(|_| 4)
    } else {
        Ok(())
    };
    // Never skip either release transport when the other fails. No retry/fallback.
    let activity = if method.activity() {
        combined_key(hwnd, key.source, msg, vk, flags)
    } else {
        Ok(())
    };
    posted.and(activity)
}

fn release(
    clients: &[Client],
    held: &mut HashMap<usize, HashMap<u32, (Key, Instant)>>,
    method: KeyboardMethod,
) {
    for (hwnd, keys) in held.drain() {
        if clients.iter().any(|c| c.hwnd == hwnd && verify(c)) {
            let mut releases: Vec<_> = keys.into_values().collect();
            // Release ordinary keys before their modifiers, including emergency cleanup.
            releases.sort_by_key(|(key, _)| modifier_release_order(key.vk));
            for (key, _) in releases {
                unsafe {
                    let _ = post(hwnd, key, true, false, method);
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
    method: KeyboardMethod,
    hold_only: bool,
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
            release(&clients, &mut held, method);
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
            release(&clients, &mut held, method);
            continue;
        }
        if key.source != unsafe { GetForegroundWindow().0 as usize } {
            release(&clients, &mut held, method);
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
                release(&clients, &mut held, method);
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
            if suppress_repeat(hold_only, repeat, key.mouse.is_some()) {
                // Refresh the physical-event lease without another DOWN. Preserve first press.
                if let Some((_, at)) = keys.get_mut(&key.vk) {
                    *at = Instant::now();
                }
                continue;
            }
            if !key.up {
                keys.insert(key.vk, (key, Instant::now()));
            }
            if let Err(reason) = unsafe { post(client.hwnd, key, key.up, repeat, method) } {
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
    release(&clients, &mut held, method);
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
pub struct Options {
    pub mouse: bool,
    pub keyboard: bool,
    pub method: KeyboardMethod,
    pub hold_only: bool,
    pub source: Option<Target>,
    pub twins_modifier: Option<String>,
    pub active_modifier: Option<String>,
    pub twins_source: Option<Target>,
}
pub fn start(
    app: tauri::AppHandle,
    id: String,
    targets: Vec<Target>,
    shortcuts: Vec<String>,
    options: Options,
) -> Result<bool, String> {
    let Options {
        mouse,
        keyboard,
        method,
        hold_only,
        source,
        twins_modifier,
        active_modifier,
        twins_source,
    } = options;
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
    let active_modifier = active_modifier
        .as_deref()
        .map(twins_modifier_mask)
        .transpose()?
        .unwrap_or(0);
    let twins_modifier = twins_modifier
        .as_deref()
        .map(twins_modifier_mask)
        .transpose()?
        .unwrap_or(0);
    let twins_source_hwnd = match (twins_modifier, twins_source) {
        (0, None) => None,
        (mask, Some(target)) if mask != 0 && mouse => Some(
            clients
                .iter()
                .find(|c| {
                    c.target.pid == target.pid
                        && c.target.started_at == target.started_at
                        && target.hwnd == Some(c.hwnd as u64)
                })
                .ok_or("Twins source is not a verified snapshot client")?
                .hwnd,
        ),
        _ => return Err("Twins mouse gesture requires mouse mode and an explicit source".into()),
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
                twins_modifier,
                active_modifier,
                local_buttons: 0,
                twins_source: twins_source_hwnd,
                exclusive_left: false,
                last_exclusive: false,
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
                    forward(
                        rx,
                        clients,
                        worker_control,
                        worker_app,
                        worker_id,
                        method,
                        hold_only,
                    )
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
    fn cleanup_releases_chord_key_before_modifiers() {
        let mut keys = vec![0xa0, 0x31, 0xa2, 0x42];
        keys.sort_by_key(|vk| modifier_release_order(*vk));
        assert_eq!(&keys[..2], &[0x31, 0x42]);
        assert!(keys[2..].iter().all(|vk| modifier_release_order(*vk)));
    }
    #[test]
    fn keyboard_methods_are_explicit_and_activity_only_never_posts() {
        assert_eq!(
            KeyboardMethod::parse(None, false).unwrap(),
            KeyboardMethod::Post
        );
        assert_eq!(
            KeyboardMethod::parse(None, true).unwrap(),
            KeyboardMethod::Combined
        );
        assert_eq!(
            KeyboardMethod::parse(Some("post"), true).unwrap(),
            KeyboardMethod::Post
        );
        let activity = KeyboardMethod::parse(Some("activity-notify"), false).unwrap();
        assert!(!activity.posts());
        assert!(activity.activity());
        assert!(KeyboardMethod::Combined.posts());
        assert!(KeyboardMethod::Combined.activity());
        assert!(!KeyboardMethod::Post.activity());
        assert!(KeyboardMethod::parse(Some("unknown"), false).is_err());
    }
    #[test]
    fn hold_only_suppresses_only_repeated_keyboard_downs() {
        assert!(suppress_repeat(true, true, false));
        assert!(!suppress_repeat(true, false, false)); // initial DOWN or UP
        assert!(!suppress_repeat(false, true, false)); // legacy typematic
        assert!(!suppress_repeat(true, true, true)); // mouse unchanged
                                                     // Modifiers and ordinary keys follow the same independent pressed-key tracking.
        for _vk in [0xa0, 0xa2, 0xa4, 0x31, 0x42] {
            assert!(!suppress_repeat(true, false, false));
            assert!(suppress_repeat(true, true, false));
        }
    }
    #[test]
    fn local_mouse_buttons_pair_releases_even_when_modifiers_or_focus_change() {
        for button in 0..5 {
            let mut local = 0;
            assert!(super::local_mouse_route(button, false, true, &mut local));
            assert!(super::local_mouse_route(button, true, false, &mut local));
            assert_eq!(local, 0);
            assert!(!super::local_mouse_route(button, false, false, &mut local));
            // Modifier pressed after a mirrored down must not steal its release.
            assert!(!super::local_mouse_route(button, true, true, &mut local));
        }
        let mut local = 0;
        assert!(super::local_mouse_route(0, false, true, &mut local));
        assert!(super::local_mouse_route(1, false, true, &mut local));
        assert!(super::local_mouse_route(0, true, false, &mut local));
        assert_eq!(local, 2);
        assert!(super::local_mouse_route(1, true, false, &mut local));
        assert_eq!(local, 0);
    }
    #[test]
    fn configurable_gesture_accepts_only_explicit_supported_modifiers() {
        for (text, mask) in [
            ("CTRL", 1),
            ("SHIFT", 2),
            ("ALT", 4),
            ("CTRL+SHIFT", 3),
            ("CTRL+ALT", 5),
            ("ALT+SHIFT", 6),
            ("CTRL+ALT+SHIFT", 7),
        ] {
            assert_eq!(twins_modifier_mask(text).unwrap(), mask);
            assert!(twins_gesture(mask, mask, false));
            assert!(!twins_gesture(mask, mask, true));
            assert!(!twins_gesture(mask, 0, false));
        }
        for value in ["", "WIN", "B", "CTRL+B", "CTRL+CTRL", "CTRL+ALT+PAUSE"] {
            assert!(twins_modifier_mask(value).is_err());
        }
        assert!(!twins_gesture(1, 3, false));
        assert!(!twins_gesture(0, 0, false));
    }
    #[test]
    fn captured_left_release_does_not_depend_on_modifier_or_focus_and_unmatched_up_is_not_captured()
    {
        assert!(twins_left_route(false, false, true));
        assert!(twins_left_route(true, true, false));
        assert!(!twins_left_route(true, false, true));
        assert!(!twins_left_route(false, false, false));
    }
    #[test]
    fn exclusive_click_strips_message_modifiers_and_ordinary_click_keeps_them() {
        for held in 0..=7 {
            assert_eq!(mouse_flags(true, held), 0);
        }
        assert_eq!(mouse_flags(false, 1), 8);
        assert_eq!(mouse_flags(false, 2), 4);
        assert_eq!(mouse_flags(false, 3), 12);
        assert_eq!(mouse_flags(false, 4), 0);
        assert!(twins_modifier_key(1, 0xa2));
        assert!(twins_modifier_key(1, 0xa3));
        assert!(!twins_modifier_key(1, 0xa0));
        assert!(!twins_modifier_key(7, 0x42));
    }

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

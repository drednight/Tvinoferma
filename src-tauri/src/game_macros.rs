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
#[derive(Clone, Deserialize, Serialize)]
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
    PostTargetLayout,
    ActivityWindow,
    ActivityNotify,
}
impl BackgroundMethod {
    fn is_activity(self) -> bool {
        matches!(
            self,
            Self::Activity | Self::ActivityWindow | Self::ActivityNotify
        )
    }
    fn app_notifications(self) -> bool {
        matches!(self, Self::Activity | Self::ActivityNotify)
    }
    fn notification_transport(self, phase: &str) -> Self {
        if matches!(self, Self::ActivityNotify)
            && (phase.starts_with("activate") || phase.starts_with("restore"))
        {
            Self::Notify
        } else {
            Self::SendTimeout
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Post => "post",
            Self::SendTimeout => "send-timeout",
            Self::Notify => "notify",
            Self::Activity => "activity",
            Self::PostTargetLayout => "post-target-layout",
            Self::ActivityWindow => "activity-window",
            Self::ActivityNotify => "activity-notify",
        }
    }
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
            .map_err(|_| "Оверлей: не удалось применить режим поверх окон")?;
        if !existing_only {
            reveal_overlay(&overlay)?;
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
    .map_err(|error| format!("Оверлей: создание окна не удалось ({error})"))?;
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
    reveal_overlay(&overlay)?;
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
// Explicit user opening recovers minimized/off-screen windows without changing saved preferences.
fn overlay_intersects_screen(window: (i32, i32, u32, u32), screen: (i32, i32, u32, u32)) -> bool {
    let (x, y, width, height) = window;
    let (mx, my, mw, mh) = screen;
    let left = i64::from(x).max(i64::from(mx));
    let top = i64::from(y).max(i64::from(my));
    let right = (i64::from(x) + i64::from(width)).min(i64::from(mx) + i64::from(mw));
    let bottom = (i64::from(y) + i64::from(height)).min(i64::from(my) + i64::from(mh));
    right - left >= 60 && bottom - top >= 40
}
fn reveal_overlay(overlay: &tauri::WebviewWindow) -> Result<(), String> {
    overlay
        .unminimize()
        .map_err(|_| "Оверлей: не удалось развернуть окно")?;
    let position = overlay
        .outer_position()
        .map_err(|_| "Оверлей: не удалось прочитать положение")?;
    let size = overlay
        .outer_size()
        .map_err(|_| "Оверлей: не удалось прочитать размер")?;
    let monitors = overlay
        .available_monitors()
        .map_err(|_| "Оверлей: не удалось проверить экраны")?;
    if !monitors.is_empty()
        && !monitors.iter().any(|monitor| {
            let origin = monitor.position();
            let screen = monitor.size();
            overlay_intersects_screen(
                (position.x, position.y, size.width, size.height),
                (origin.x, origin.y, screen.width, screen.height),
            )
        })
    {
        overlay
            .center()
            .map_err(|_| "Оверлей: не удалось вернуть окно на экран")?;
    }
    overlay
        .show()
        .map_err(|_| "Оверлей: не удалось показать окно")?;
    overlay
        .set_focus()
        .map_err(|_| "Оверлей: не удалось вывести окно вперёд")?;
    Ok(())
}
#[cfg(test)]
mod overlay_visibility_tests {
    #[test]
    fn checks_real_overlap_including_negative_monitor_coordinates() {
        use super::overlay_intersects_screen as visible;
        assert!(visible((-1800, 10, 430, 580), (-1920, 0, 1920, 1080)));
        assert!(!visible((6000, 0, 430, 580), (0, 0, 1920, 1080)));
        assert!(!visible((1900, 0, 430, 580), (0, 0, 1920, 1080)));
        assert!(visible((1800, 0, 430, 580), (0, 0, 1920, 1080)));
        assert!(!visible((i32::MAX, 0, 430, 580), (0, 0, 1920, 1080)));
    }
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
                (120.0 * window.scale_factor().unwrap_or(1.0)).round() as u32,
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
    close_mode: Option<String>,
    close_targets: Option<Vec<Target>>,
) -> Result<(), String> {
    if !["main", "game-overlay"].contains(&window.label()) {
        return Err("Untrusted window".into());
    }
    match action.as_str() {
        "party-refresh" | "party-launch" | "party-close-all" => app
            .emit_to(
                "main",
                "game-overlay-party",
                serde_json::json!({"action":action,"partyId":party_id,"closeMode":close_mode,"closeTargets":close_targets}),
            )
            .map_err(|_| "Cannot request party action".into()),
        "stop" | "clear-logs" => app
            .emit_to("main", "game-overlay-action", action)
            .map_err(|_| "Cannot send overlay action".into()),
        "settings" | "logs" | "overlay-settings" | "background-logs" => {
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
            let lease = crate::input_arbiter::INPUT
                .acquire("calibration", crate::input_arbiter::INPUT.epoch())?;
            let _binding = lease.bind();
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
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComparisonStep {
    key: Option<String>,
    wait: Option<u64>,
}
fn validate_comparison_steps(steps: &[ComparisonStep]) -> Result<(), String> {
    if steps.is_empty() || steps.len() > 20 {
        return Err("Expected 1..20 steps".into());
    }
    let mut duration = 0u64;
    let mut keys = 0;
    for step in steps {
        match (&step.key, step.wait) {
            (Some(key), None) => {
                let mut parts: Vec<_> = key.split('+').collect();
                let base = parts.pop().ok_or("Missing key")?;
                let simple = base.len() == 1
                    && base
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
                let function = base
                    .strip_prefix('F')
                    .and_then(|v| v.parse::<u8>().ok())
                    .is_some_and(|n| (1..=24).contains(&n) && base == format!("F{n}"));
                if (!simple && !function)
                    || parts.len() > 2
                    || parts.iter().any(|v| !matches!(*v, "CTRL" | "SHIFT"))
                    || (parts.len() == 2 && parts[0] == parts[1])
                {
                    return Err("Only simple keys with Ctrl/Shift are allowed".into());
                }
                keys += 1;
                duration += 30;
            }
            (None, Some(ms)) if (50..=1500).contains(&ms) => duration += ms,
            _ => return Err("Invalid comparison step".into()),
        }
    }
    if keys == 0 || keys > 10 || duration > 10000 {
        return Err("Expected 1..10 key presses and at most 10 seconds".into());
    }
    Ok(())
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ComparisonTiming {
    timeout_ms: u32,
    modifier_gap_ms: u64,
    shift_vk: u16,
}
impl Default for ComparisonTiming {
    fn default() -> Self {
        Self {
            timeout_ms: 25,
            modifier_gap_ms: 0,
            shift_vk: 0x10,
        }
    }
}
fn validate_comparison_timing(
    steps: &[ComparisonStep],
    timing: ComparisonTiming,
) -> Result<(), String> {
    if ![25, 100, 250].contains(&timing.timeout_ms)
        || ![0, 50, 100, 200].contains(&timing.modifier_gap_ms)
        || ![0x10, 0xa0, 0xa1].contains(&timing.shift_vk)
    {
        return Err("Invalid comparison timing".into());
    }
    let nominal: u64 = steps
        .iter()
        .map(|step| {
            step.wait.unwrap_or(
                30 + if step.key.as_ref().is_some_and(|k| k.contains('+')) {
                    timing.modifier_gap_ms
                } else {
                    0
                },
            )
        })
        .sum();
    if nominal > 10000 {
        return Err("Comparison exceeds 10 seconds including modifier gaps".into());
    }
    Ok(())
}
// No input dispatch lock is held during this wait. Every exit still returns to
// the caller's reverse key-release loop, including cancellation and focus changes.
fn wait_modifier_gap(ms: u64, mut allowed: impl FnMut() -> bool) -> bool {
    let end = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    loop {
        if !allowed() {
            return false;
        }
        let remaining = end.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return true;
        }
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)));
    }
}
fn activity_delivery_flags(steps: &[serde_json::Value]) -> (bool, bool) {
    let timed_out = steps.iter().any(|s| s["error"] == 1460);
    let release_unconfirmed = steps
        .iter()
        .any(|s| s["phase"].as_str().is_some_and(|p| p.ends_with("-up")) && s["ok"] != true);
    (timed_out, release_unconfirmed)
}
#[tauri::command]
pub async fn game_macro_compare_many(
    window: tauri::WebviewWindow,
    targets: Vec<Target>,
    steps: Vec<ComparisonStep>,
    timing: Option<ComparisonTiming>,
) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    validate_comparison_steps(&steps)?;
    let timing = timing.unwrap_or_default();
    validate_comparison_timing(&steps, timing)?;
    if !(1..=4).contains(&targets.len())
        || targets
            .iter()
            .enumerate()
            .any(|(i, t)| targets[..i].iter().any(|p| p.pid == t.pid))
    {
        return Err("Expected 1..4 distinct game processes".into());
    }
    #[cfg(windows)]
    {
        let epoch = crate::input_arbiter::INPUT.epoch();
        tauri::async_runtime::spawn_blocking(move || {
            let lease = crate::input_arbiter::INPUT.acquire("multi-comparison", epoch)?;
            let _binding = lease.bind();
            let foreground = win::comparison_foreground()?;
            // All recipients and all keys are checked before arming any worker.
            for target in &targets {
                let client = crate::launcher::macro_client_at(target.pid,target.started_at,target.hwnd)?;
                if !compatible_integrity(client.elevated,crate::launcher::self_elevated()) {
                    return Err("Game client identity changed or access is unavailable".into());
                }
                for step in &steps {
                    if let Some(key) = &step.key {
                        win::comparison_ready(client.hwnd.ok_or("No game window")?,target.pid,key,&foreground)?;
                    }
                }
            }
            let start = std::time::Instant::now() + std::time::Duration::from_millis(100);
            let failed = std::sync::atomic::AtomicBool::new(false);
            let recipients = std::thread::scope(|scope| {
                let handles: Vec<_> = targets.iter().map(|target| {
                    let lease = &lease;
                    let failed = &failed;
                    let steps = &steps;
                    let foreground = &foreground;
                    scope.spawn(move || {
                        let _binding = lease.bind();
                        let mut rows = Vec::new();
                        let mut blocked: Option<String> = None;
                        while std::time::Instant::now() < start {
                            if crate::input_arbiter::cancelled() { break; }
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                        for (index,step) in steps.iter().enumerate() {
                            let result = (|| -> Result<(),String> {
                                if crate::input_arbiter::cancelled() || failed.load(std::sync::atomic::Ordering::SeqCst) {
                                    return Err("Comparison stopped; some input may already have been sent".into());
                                }
                                if let Some(ms) = step.wait {
                                    let until = std::time::Instant::now() + std::time::Duration::from_millis(ms);
                                    while std::time::Instant::now() < until {
                                        if crate::input_arbiter::cancelled() || failed.load(std::sync::atomic::Ordering::SeqCst) || win::comparison_foreground()? != *foreground {
                                            return Err("Comparison stopped or foreground changed".into());
                                        }
                                        std::thread::sleep(std::time::Duration::from_millis(10));
                                    }
                                    return Ok(());
                                }
                                let key = step.key.as_deref().ok_or("Missing key")?;
                                let client = crate::launcher::macro_client_at(target.pid,target.started_at,target.hwnd)?;
                                if !compatible_integrity(client.elevated,crate::launcher::self_elevated()) {
                                    return Err("Game client access changed".into());
                                }
                                let raw = client.hwnd.ok_or("No game window")?;
                                win::comparison_ready(raw,target.pid,key,foreground)?;
                                let start_ms = start.elapsed().as_millis() as u64;
                                let report = win::comparison_key(raw,target.pid,key,foreground,timing)?;
                                let ok = report["ok"] == true;
                                rows.push(serde_json::json!({"index":index,"key":key,"startMs":start_ms,"endMs":start.elapsed().as_millis() as u64,"details":report}));
                                if !ok { return Err("Recipient refused input or delivery failed; inspect step report".into()); }
                                Ok(())
                            })();
                            if let Err(error) = result {
                                failed.store(true,std::sync::atomic::Ordering::SeqCst);
                                blocked = Some(error);
                                break;
                            }
                        }
                        let timed_out = rows.iter().any(|r| r["details"]["timedOut"] == true);
                        let release_unconfirmed = rows.iter().any(|r| r["details"]["releaseUnconfirmed"] == true);
                        serde_json::json!({"pid":target.pid,"startedAt":target.started_at,"hwnd":target.hwnd,"ok":blocked.is_none(),"blockedBy":blocked,"timedOut":timed_out,"releaseUnconfirmed":release_unconfirmed,"deliveryUncertain":timed_out || release_unconfirmed,"steps":rows})
                    })
                }).collect();
                handles.into_iter().map(|handle| handle.join().unwrap_or_else(|_| {
                    failed.store(true,std::sync::atomic::Ordering::SeqCst);
                    serde_json::json!({"ok":false,"blockedBy":"Comparison worker failed"})
                })).collect::<Vec<_>>()
            });
            Ok(serde_json::json!({"ok":recipients.iter().all(|r| r["ok"] == true),"method":"inactive-activity-notify","gameEffect":"unknown","timing":timing,"timedOut":recipients.iter().any(|r| r["timedOut"] == true),"releaseUnconfirmed":recipients.iter().any(|r| r["releaseUnconfirmed"] == true),"deliveryUncertain":recipients.iter().any(|r| r["deliveryUncertain"] == true),"recipients":recipients}))
        }).await.map_err(|_| "Comparison worker failed")?
    }
    #[cfg(not(windows))]
    {
        let _ = targets;
        Err("Game control is Windows-only".into())
    }
}

#[tauri::command]
pub async fn game_macro_compare_once(
    window: tauri::WebviewWindow,
    target: Target,
    key: String,
    method: String,
) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        let epoch = crate::input_arbiter::INPUT.epoch();
        tauri::async_runtime::spawn_blocking(move || {
            let lease = crate::input_arbiter::INPUT.acquire("comparison", epoch)?;
            let _binding = lease.bind();
            let client =
                crate::launcher::macro_client_at(target.pid, target.started_at, target.hwnd)?;
            if !compatible_integrity(client.elevated, crate::launcher::self_elevated()) {
                return Err("Game client identity changed or access is unavailable".into());
            }
            let mut report = win::compare_once(
                client.hwnd.ok_or("No game window")?,
                target.pid,
                &key,
                &method,
            )?;
            report["identityChecked"] = serde_json::json!(true);
            report["appElevated"] = serde_json::json!(crate::launcher::self_elevated());
            report["targetElevated"] = serde_json::json!(client.elevated);
            Ok(report)
        })
        .await
        .map_err(|_| "Comparison worker failed")?
    }
    #[cfg(not(windows))]
    {
        let _ = (target, key, method);
        Err("Game control is Windows-only".into())
    }
}
#[tauri::command]
pub async fn game_macro_close_targets(
    window: tauri::WebviewWindow,
    targets: Vec<Target>,
) -> Result<crate::launcher::CloseReport, String> {
    main_only(&window)?;
    if targets.is_empty() || targets.len() > 128 {
        return Err("Invalid close selection".into());
    }
    #[cfg(windows)]
    {
        let pids = tauri::async_runtime::spawn_blocking(move || {
            targets
                .into_iter()
                .map(|target| {
                    crate::launcher::macro_client_at(target.pid, target.started_at, target.hwnd)?;
                    Ok(target.pid)
                })
                .collect::<Result<Vec<u32>, String>>()
        })
        .await
        .map_err(|_| "Close validation failed")??;
        crate::launcher::launcher_close_clients_pids(pids).await
    }
    #[cfg(not(windows))]
    {
        let _ = targets;
        Err("Game control is Windows-only".into())
    }
}
#[tauri::command]
pub fn game_macro_input_stop(window: tauri::WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    #[cfg(windows)]
    crate::input_arbiter::INPUT.stop()?;
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
    timing: Option<InputTiming>,
) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        let epoch = crate::input_arbiter::INPUT.epoch();
        tauri::async_runtime::spawn_blocking(move || {
            let lease = crate::input_arbiter::INPUT.acquire("command", epoch)?;
            let _binding = lease.bind();
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
        let epoch = crate::input_arbiter::INPUT.epoch();
        tauri::async_runtime::spawn_blocking(move || {
            let lease = crate::input_arbiter::INPUT.acquire("diagnostic", epoch)?;
            let _binding = lease.bind();
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
) -> Result<Vec<String>, String> {
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
pub(crate) fn receiver_send(
    raw: u64,
    key: &str,
    method: BackgroundMethod,
) -> Result<serde_json::Value, String> {
    let lease =
        crate::input_arbiter::INPUT.acquire("receiver", crate::input_arbiter::INPUT.epoch())?;
    let _binding = lease.bind();
    if !crate::input_receiver::is_receiver(raw) {
        return Err("Receiver unavailable".into());
    }
    if !win::input_idle(None)? {
        return Err("Release physical input before receiver test".into());
    }
    win::background_key(
        raw,
        std::process::id(),
        key,
        InputTiming {
            background_method: method,
            ..Default::default()
        },
    )
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
        send_background_timed(hwnd, msg, wp, lp, method, 25)
    }
    unsafe fn send_background_timed(
        hwnd: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
        method: BackgroundMethod,
        timeout_ms: u32,
    ) -> Result<(), u32> {
        let cleanup = matches!(msg, WM_KEYUP | WM_SYSKEYUP)
            || (matches!(msg, WM_ACTIVATE | WM_ACTIVATEAPP) && wp.0 == 0);
        crate::input_arbiter::dispatch(cleanup, || {
            send_background_unchecked(hwnd, msg, wp, lp, method, timeout_ms)
        })
        .unwrap_or(Err(995))
    }
    unsafe fn send_background_unchecked(
        hwnd: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
        method: BackgroundMethod,
        timeout_ms: u32,
    ) -> Result<(), u32> {
        SetLastError(WIN32_ERROR(0));
        let accepted = match method {
            BackgroundMethod::Activity
            | BackgroundMethod::ActivityWindow
            | BackgroundMethod::ActivityNotify => return Err(87), // Must go through guarded activity_key.
            BackgroundMethod::Post | BackgroundMethod::PostTargetLayout => {
                PostMessageW(Some(hwnd), msg, wp, lp).is_ok()
            }
            BackgroundMethod::Notify => background_notify(hwnd.0, msg, wp.0, lp.0) != 0,
            BackgroundMethod::SendTimeout => {
                let mut result = 0;
                // BLOCK | ABORTIFHUNG | ERRORONEXIT. Bounded wait; no activation API calls.
                background_send_timeout(hwnd.0, msg, wp.0, lp.0, 0x23, timeout_ms, &mut result) != 0
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
    pub fn comparison_foreground() -> Result<String, String> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return Err("No foreground window".into());
        }
        Ok(format!("0x{:X}", hwnd.0 as usize))
    }
    pub fn comparison_ready(raw: u64, pid: u32, key: &str, expected: &str) -> Result<(), String> {
        if crate::input_arbiter::cancelled() {
            return Err("Comparison cancelled".into());
        }
        let hwnd = verified_window(raw, pid)?;
        if comparison_foreground()? != expected || unsafe { GetForegroundWindow() } == hwnd {
            return Err("Keep the same non-game foreground window throughout the test".into());
        }
        let report = background_probe(raw, pid, key, false)?;
        if report["visible"] != true
            || report["minimized"] == true
            || report["hung"] == true
            || !input_idle(Some(key))?
        {
            return Err("Window unavailable or physical keys held".into());
        }
        Ok(())
    }
    pub fn compare_once(
        raw: u64,
        pid: u32,
        key: &str,
        method: &str,
    ) -> Result<serde_json::Value, String> {
        let active = match method {
            "active-send" | "active-post" => true,
            "inactive-post" | "inactive-activity-window" | "inactive-activity-notify" => false,
            _ => return Err("Invalid comparison method".into()),
        };
        let (mods, vk) = chord(key)?;
        if !mods.is_empty()
            || !((0x30..=0x39).contains(&vk)
                || (0x41..=0x5a).contains(&vk)
                || (0x70..=0x87).contains(&vk))
        {
            return Err("Comparison requires one letter, digit or function key".into());
        }
        let hwnd = verified_window(raw, pid)?;
        let mut report = background_probe(raw, pid, key, false)?;
        report["method"] = serde_json::json!(method);
        report["gameEffect"] = serde_json::json!("unknown");
        report["targetActiveRequired"] = serde_json::json!(active);
        if report["visible"] != true
            || report["minimized"] == true
            || report["hung"] == true
            || !input_idle(Some(key))?
            || (unsafe { GetForegroundWindow() } == hwnd) != active
        {
            report["refused"] = serde_json::json!(true);
            report["ok"] = serde_json::json!(false);
            report["inputSent"] = serde_json::json!(false);
            report["blockedBy"]=serde_json::json!("Условие опыта не выполнено: проверьте активность, видимость окна и отпустите физические клавиши.");
            return Ok(report);
        }
        if method == "active-send" {
            let result = action(
                raw,
                pid,
                "key",
                Some(key),
                None,
                None,
                InputTiming::default(),
            );
            report["ok"] = serde_json::json!(result.is_ok());
            report["inputSent"] = serde_json::json!(result.is_ok());
            report["deliveryUncertain"] = serde_json::json!(result.is_err());
            if let Err(error) = result {
                report["blockedBy"] = serde_json::json!(error);
            }
        } else {
            let transport = match method {
                "inactive-activity-window" => BackgroundMethod::ActivityWindow,
                "inactive-activity-notify" => BackgroundMethod::ActivityNotify,
                _ => BackgroundMethod::Post,
            };
            report = background_key(
                raw,
                pid,
                key,
                InputTiming {
                    background_method: transport,
                    ..Default::default()
                },
            )?;
        }
        report["method"] = serde_json::json!(method);
        report["gameEffect"] = serde_json::json!("unknown");
        report["targetActiveRequired"] = serde_json::json!(active);
        if (unsafe { GetForegroundWindow() } == hwnd) != active {
            report["foregroundChanged"] = serde_json::json!(true);
            report["ok"] = serde_json::json!(false);
        }
        Ok(report)
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
                "guiAvailable":gui_ok,"guiError":gui_error,
                "guiFocusHwnd":if gui_ok {Some(format!("0x{:X}",gui.hwndFocus.0 as usize))}else{None},
                "guiActiveHwnd":if gui_ok {Some(format!("0x{:X}",gui.hwndActive.0 as usize))}else{None},
                "guiFocusIsChild":gui_ok&&IsChild(hwnd,gui.hwndFocus).as_bool(),"focusIsTarget":gui_ok&&gui.hwndFocus==hwnd,
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
    fn extended_key(vk: u16) -> bool {
        matches!(vk, 0x21..=0x28 | 0x2d | 0x2e | 0x6f | 0x90)
    }
    fn background_key_message(vk: u16, scan: u32, up: bool, alt_down: bool) -> (u32, u32) {
        let system = alt_down || vk == 0x12;
        let msg = match (system, up) {
            (true, true) => WM_SYSKEYUP,
            (true, false) => WM_SYSKEYDOWN,
            (false, true) => WM_KEYUP,
            (false, false) => WM_KEYDOWN,
        };
        let flags = 1u32
            | ((scan & 0xff) << 16)
            | (u32::from(extended_key(vk)) << 24)
            | (u32::from(alt_down) << 29)
            | if up { 0xc0000000 } else { 0 };
        (msg, flags)
    }
    pub fn background_key(
        raw: u64,
        pid: u32,
        key: &str,
        timing: InputTiming,
    ) -> Result<serde_json::Value, String> {
        if timing.background_method.is_activity() {
            return activity_key(
                raw,
                pid,
                key,
                timing.hold_ms,
                false,
                timing.activity_foreground.as_deref(),
                timing.background_method,
            );
        }
        let hwnd = verified_window(raw, pid)?;
        let mut report = background_probe(raw, pid, key, false)?;
        let (mods, vk) = chord(key)?;
        let mut alt_down = false;
        let original = unsafe { GetForegroundWindow() };
        let mut messages = Vec::new();
        let mut failure = None;
        let mut send = |key: u16, up: bool| {
            let scan = unsafe {
                if matches!(timing.background_method, BackgroundMethod::PostTargetLayout) {
                    let thread = GetWindowThreadProcessId(hwnd, None);
                    MapVirtualKeyExW(key as u32, MAPVK_VK_TO_VSC, Some(GetKeyboardLayout(thread)))
                } else {
                    MapVirtualKeyW(key as u32, MAPVK_VK_TO_VSC)
                }
            };
            let (msg, flags) = background_key_message(key, scan, up, alt_down);
            if key == 0x12 {
                alt_down = !up;
            }
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
        report["method"] = serde_json::json!(timing.background_method.label());
        report["holdMs"] = serde_json::json!(timing.hold_ms.clamp(10, 200));
        report["foregroundChanged"] = serde_json::json!(foreground_changed);
        report["error"] = serde_json::json!(failure);
        report["ok"] = serde_json::json!(failure.is_none() && !foreground_changed);
        Ok(report)
    }
    // Shared guarded protocol: explicit diagnostic or opt-in single-key command, never repeat.
    pub fn activity_probe(raw: u64, pid: u32) -> Result<serde_json::Value, String> {
        activity_key(raw, pid, "B", 30, true, None, BackgroundMethod::Activity)
    }
    // One activity protocol per target. A batch owns the arbiter and may address
    // different game processes concurrently; the same HWND must never overlap.
    static ACTIVITY_TARGETS: Mutex<Vec<u64>> = Mutex::new(Vec::new());
    struct ActivityGuard(u64);
    impl ActivityGuard {
        fn acquire(raw: u64) -> Result<Self, String> {
            let mut targets = ACTIVITY_TARGETS
                .lock()
                .map_err(|_| "Activity guard unavailable")?;
            if targets.contains(&raw) {
                return Err("Activity test already running for this window".into());
            }
            targets.push(raw);
            Ok(Self(raw))
        }
    }
    impl Drop for ActivityGuard {
        fn drop(&mut self) {
            if let Ok(mut targets) = ACTIVITY_TARGETS.lock() {
                targets.retain(|raw| *raw != self.0);
            }
        }
    }
    pub fn comparison_key(
        raw: u64,
        pid: u32,
        key: &str,
        foreground: &str,
        timing: ComparisonTiming,
    ) -> Result<serde_json::Value, String> {
        activity_key_timed(
            raw,
            pid,
            key,
            30,
            false,
            Some(foreground),
            BackgroundMethod::ActivityNotify,
            timing,
        )
    }
    fn activity_key(
        raw: u64,
        pid: u32,
        key: &str,
        hold_ms: u64,
        diagnostic: bool,
        expected: Option<&str>,
        method: BackgroundMethod,
    ) -> Result<serde_json::Value, String> {
        activity_key_timed(
            raw,
            pid,
            key,
            hold_ms,
            diagnostic,
            expected,
            method,
            ComparisonTiming::default(),
        )
    }
    fn activity_key_timed(
        raw: u64,
        pid: u32,
        key: &str,
        hold_ms: u64,
        diagnostic: bool,
        expected: Option<&str>,
        method: BackgroundMethod,
        timing: ComparisonTiming,
    ) -> Result<serde_json::Value, String> {
        let (mut mods, vk) = chord(key)?;
        for modifier in &mut mods {
            if *modifier == 0x10 {
                *modifier = timing.shift_vk;
            }
        }
        let _guard = ActivityGuard::acquire(raw)?;
        let hwnd = verified_window(raw, pid)?;
        let mut report = background_probe(raw, pid, key, false)?;
        report["timeoutMs"] = serde_json::json!(timing.timeout_ms);
        report["modifierGapMs"] = serde_json::json!(timing.modifier_gap_ms);
        report["shiftVk"] = serde_json::json!(timing.shift_vk);
        report["modifiers"] = serde_json::json!(mods);
        // Window messages do not set the target thread's GetKeyState/GetAsyncKeyState.
        // Never substitute global SendInput or attach input queues in this protocol.
        report["modifierState"] = serde_json::json!(if mods.is_empty() {
            "not-requested"
        } else {
            "window-messages-only"
        });
        report["activityTest"] = serde_json::json!(true);
        report["activityVariant"] = serde_json::json!(method.label());
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
            || (original_pid == pid
                && (diagnostic || original != hwnd)
                && !crate::input_receiver::is_receiver(raw))
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
            let transport = method.notification_transport(phase);
            let asynchronous = matches!(transport, BackgroundMethod::Notify);
            let started = std::time::Instant::now();
            let result = unsafe {
                send_background_timed(
                    hwnd,
                    msg,
                    WPARAM(wp),
                    LPARAM(lp),
                    transport,
                    timing.timeout_ms,
                )
            };
            failure.set(failure.get().or(result.err()));
            let after = unsafe { GetForegroundWindow() };
            changed.set(changed.get() || after != original);
            steps.push(serde_json::json!({"phase":phase,"elapsedUs":started.elapsed().as_micros() as u64,"timeoutMs":timing.timeout_ms,"asynchronous":asynchronous,"wparam":wp,"lparam":format!("0x{:08X}",lp as u32),"message":format!("0x{msg:04X}"),"ok":result.is_ok(),"error":result.err().unwrap_or(0),"before":format!("0x{:X}",before.0 as usize),"after":format!("0x{:X}",after.0 as usize)}));
            result.is_ok() && (cleanup || !changed.get())
        };
        // No early return below: always attempt reverse notifications, including timeout paths.
        let notifications = original_pid != pid;
        report["notificationsSent"] = serde_json::json!(notifications);
        let app_ok = !notifications
            || !method.app_notifications()
            || send("activate-app", WM_ACTIVATEAPP, 1, source_thread as isize);
        let window_ok = app_ok
            && (!notifications || send("activate-window", WM_ACTIVATE, 1, original.0 as isize));
        if window_ok {
            // Keep a list even when DOWN times out: every attempted key gets an UP.
            let mut pressed = Vec::new();
            let mut alt_down = false;
            let target_layout = unsafe { GetKeyboardLayout(GetWindowThreadProcessId(hwnd, None)) };
            let mut key_message = |key: u16, up: bool| {
                let scan =
                    unsafe { MapVirtualKeyExW(key as u32, MAPVK_VK_TO_VSC, Some(target_layout)) };
                let (msg, flags) = background_key_message(key, scan, up, alt_down);
                if key == 0x12 {
                    alt_down = !up;
                }
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
            for key in mods.iter().copied() {
                pressed.push(key);
                if !key_message(key, false) {
                    down_ok = false;
                    break;
                }
            }
            if down_ok && !mods.is_empty() {
                down_ok = wait_modifier_gap(timing.modifier_gap_ms, || {
                    !crate::input_arbiter::cancelled()
                        && unsafe { GetForegroundWindow() } == original
                        && input_idle(Some(key)).unwrap_or(false)
                });
            }
            if down_ok {
                // Recheck after the gap: never dispatch the base key after stop/focus change.
                down_ok = !crate::input_arbiter::cancelled()
                    && unsafe { GetForegroundWindow() } == original;
                if down_ok {
                    pressed.push(vk);
                    down_ok = key_message(vk, false);
                }
            }
            if !down_ok && failure.get().is_none() {
                failure.set(Some(995));
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
                    if crate::input_arbiter::cancelled() {
                        failure.set(failure.get().or(Some(995)));
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
            if method.app_notifications() {
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
        }
        changed.set(changed.get() || unsafe { GetForegroundWindow() } != original);
        let (timed_out, release_unconfirmed) = activity_delivery_flags(&steps);
        report["timedOut"] = serde_json::json!(timed_out);
        report["releaseUnconfirmed"] = serde_json::json!(release_unconfirmed);
        report["deliveryUncertain"] = serde_json::json!(timed_out || release_unconfirmed);
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
            "BACKSPACE" => 0x08,
            "ESC" => 0x1b,
            "END" => 0x23,
            "PAGEUP" => 0x21,
            "PAGEDOWN" => 0x22,
            "INSERT" => 0x2d,
            "DELETE" => 0x2e,
            "CAPSLOCK" => 0x14,
            "NUMLOCK" => 0x90,
            "SCROLLLOCK" => 0x91,
            "PRINTSCREEN" => 0x2c,
            "MULTIPLY" => 0x6a,
            "ADD" => 0x6b,
            "SUBTRACT" => 0x6d,
            "DECIMAL" => 0x6e,
            "DIVIDE" => 0x6f,
            "SEMICOLON" => 0xba,
            "EQUALS" => 0xbb,
            "COMMA" => 0xbc,
            "MINUS" => 0xbd,
            "PERIOD" => 0xbe,
            "SLASH" => 0xbf,
            "BACKQUOTE" => 0xc0,
            "BRACKETLEFT" => 0xdb,
            "BACKSLASH" => 0xdc,
            "BRACKETRIGHT" => 0xdd,
            "QUOTE" => 0xde,
            s if s.len() == 7 && s.starts_with("NUMPAD") && s.as_bytes()[6].is_ascii_digit() => {
                0x60 + (s.as_bytes()[6] - b'0') as u16
            }
            s if s.len() == 1 && s.as_bytes()[0].is_ascii_alphanumeric() => s.as_bytes()[0] as u16,
            s if s.starts_with('F') => {
                let n: u16 = s[1..].parse().map_err(|_| "Invalid key")?;
                if !(1..=24).contains(&n) {
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
        fn activity_guards_exclude_same_window_but_allow_distinct_recipients() {
            let a = super::ActivityGuard::acquire(u64::MAX - 1).unwrap();
            let b = super::ActivityGuard::acquire(u64::MAX - 2).unwrap();
            assert!(super::ActivityGuard::acquire(u64::MAX - 1).is_err());
            drop(a);
            assert!(super::ActivityGuard::acquire(u64::MAX - 1).is_ok());
            drop(b);
        }

        #[test]
        fn experiments_have_explicit_notification_plans_and_bounded_key_transport() {
            use super::BackgroundMethod as Method;
            assert!(!Method::PostTargetLayout.is_activity());
            assert!(!Method::ActivityWindow.app_notifications());
            assert!(Method::Activity.app_notifications());
            assert!(Method::ActivityNotify.app_notifications());
            for variant in [
                Method::Activity,
                Method::ActivityWindow,
                Method::ActivityNotify,
            ] {
                assert!(variant.is_activity());
                assert!(matches!(
                    variant.notification_transport("key-down"),
                    Method::SendTimeout
                ));
                assert!(matches!(
                    variant.notification_transport("key-up"),
                    Method::SendTimeout
                ));
                assert!(matches!(
                    variant.notification_transport("modifier-up"),
                    Method::SendTimeout
                ));
            }
            assert!(matches!(
                Method::ActivityNotify.notification_transport("activate-app"),
                Method::Notify
            ));
            assert!(matches!(
                Method::ActivityNotify.notification_transport("restore-window"),
                Method::Notify
            ));
            assert!(matches!(
                Method::ActivityWindow.notification_transport("activate-window"),
                Method::SendTimeout
            ));
            for name in ["post-target-layout", "activity-window", "activity-notify"] {
                let parsed: Method = serde_json::from_str(&format!("\"{name}\"")).unwrap();
                assert_eq!(parsed.label(), name);
            }
        }

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
        #[test]
        fn background_alt_context_follows_physical_transition_order() {
            let (ctrl, flags) = super::background_key_message(0x11, 0x1d, false, false);
            assert_eq!(ctrl, super::WM_KEYDOWN);
            assert_eq!(flags & 0x20000000, 0);
            assert_eq!(
                super::background_key_message(0x12, 0x38, false, false).0,
                super::WM_SYSKEYDOWN
            );
            assert_eq!(
                super::background_key_message(0x12, 0x38, false, false).1 & 0x20000000,
                0
            );
            assert_eq!(
                super::background_key_message(0x41, 0x1e, false, true).1 & 0x20000000,
                0x20000000
            );
            assert_eq!(
                super::background_key_message(0x12, 0x38, true, true).0,
                super::WM_SYSKEYUP
            );
            assert_eq!(
                super::background_key_message(0x11, 0x1d, true, false).0,
                super::WM_KEYUP
            );
            assert!(super::extended_key(0x6f));
            assert!(!super::extended_key(0x69));
        }
        #[test]
        fn shared_extended_key_vocabulary_is_bounded() {
            for (name, vk) in [
                ("F24", 0x87),
                ("NUMPAD9", 0x69),
                ("DELETE", 0x2e),
                ("PAGEUP", 0x21),
                ("BACKSPACE", 0x08),
                ("DIVIDE", 0x6f),
                ("QUOTE", 0xde),
            ] {
                assert_eq!(super::chord(name).unwrap(), (vec![], vk));
            }
            for name in ["F25", "NUMPAD10", "WIN+A", "CTRL+CTRL+A"] {
                assert!(super::chord(name).is_err());
            }
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
    #[allow(clippy::too_many_arguments)]
    pub(super) fn mouse_message(
        raw: u64,
        x: i32,
        y: i32,
        button: u8,
        up: bool,
        flags: u32,
        double: bool,
    ) -> Result<(), String> {
        crate::input_arbiter::dispatch(up, || {
            mouse_message_unchecked(raw, x, y, button, up, flags, double)
        })?
    }
    fn mouse_message_unchecked(
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
                } else if double && GetClassLongW(hwnd, GCL_STYLE) & CS_DBLCLKS.0 != 0 {
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
        if crate::input_arbiter::cancelled() {
            return Err("Input operation cancelled".into());
        }
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
                crate::input_arbiter::dispatch(false, || SetCursorPos(screen.x, screen.y))?
                    .map_err(|_| "Cannot position pointer")?;
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
                let sent = guarded_send_input(&events, std::mem::size_of::<INPUT>() as i32);
                if sent != events.len() as u32 {
                    let mut release = vec![mouse(true)];
                    release.extend(mods.iter().rev().map(|vk| key(*vk, true)));
                    let _ = guarded_send_input(&release, std::mem::size_of::<INPUT>() as i32);
                    return Err("Windows did not accept the click".into());
                }
            }
            Ok(Some(geometry))
        }
    }
    unsafe fn guarded_send_input(events: &[INPUT], size: i32) -> u32 {
        let cleanup = events.iter().all(|event| match event.r#type {
            INPUT_KEYBOARD => event.Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP),
            INPUT_MOUSE => {
                let flags = event.Anonymous.mi.dwFlags;
                flags.contains(MOUSEEVENTF_LEFTUP)
                    || flags.contains(MOUSEEVENTF_RIGHTUP)
                    || flags.contains(MOUSEEVENTF_MIDDLEUP)
                    || flags.contains(MOUSEEVENTF_XUP)
            }
            _ => false,
        });
        crate::input_arbiter::dispatch(cleanup, || SendInput(events, size)).unwrap_or(0)
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
                        let _ =
                            crate::input_arbiter::dispatch(false, || SetForegroundWindow(hwnd))?;
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
                                dwFlags: (if up {
                                    KEYEVENTF_KEYUP
                                } else {
                                    KEYBD_EVENT_FLAGS(0)
                                }) | (if extended_key(vk) {
                                    KEYEVENTF_EXTENDEDKEY
                                } else {
                                    KEYBD_EVENT_FLAGS(0)
                                }),
                                ..Default::default()
                            },
                        },
                    };
                    let mut down: Vec<INPUT> = mods.iter().map(|v| make(*v, false)).collect();
                    down.push(make(key, false));
                    let mut up = vec![make(key, true)];
                    up.extend(mods.iter().rev().map(|v| make(*v, true)));
                    let accepted = guarded_send_input(&down, std::mem::size_of::<INPUT>() as i32);
                    if accepted == down.len() as u32 {
                        std::thread::sleep(Duration::from_millis(timing.hold_ms.clamp(10, 200)));
                    }
                    // Always release every potentially pressed key, even after a focus change/partial send.
                    let released = guarded_send_input(&up, std::mem::size_of::<INPUT>() as i32);
                    if released != up.len() as u32 {
                        let _ = guarded_send_input(&up, std::mem::size_of::<INPUT>() as i32);
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
                        crate::input_arbiter::dispatch(false, || SetCursorPos(screen.x, screen.y))?
                            .map_err(|_| "Cannot position pointer")?;
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
                        let accepted = guarded_send_input(
                            &[mouse(false)],
                            std::mem::size_of::<INPUT>() as i32,
                        );
                        if accepted == 1 {
                            std::thread::sleep(Duration::from_millis(
                                timing.hold_ms.clamp(10, 200),
                            ));
                        }
                        // Separate down/up so polling games can observe the pressed button. Always release.
                        let released =
                            guarded_send_input(&[mouse(true)], std::mem::size_of::<INPUT>() as i32);
                        if released != 1 {
                            let _ = guarded_send_input(
                                &[mouse(true)],
                                std::mem::size_of::<INPUT>() as i32,
                            );
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
                                if id == "stop" {
                                    let _ = crate::input_arbiter::INPUT.stop();
                                }
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
    pub fn bindings(app: tauri::AppHandle, bindings: Vec<Binding>) -> Result<Vec<String>, String> {
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
            return Ok(Vec::new());
        }
        let (tx, rx) = std::sync::mpsc::channel();
        *guard = Some(std::thread::spawn(move || unsafe {
            let mut ids = Vec::new();
            let mut failed = Vec::new();
            let wheel_bindings: Vec<_> = parsed
                .iter()
                .filter(|(_, _, key)| *key >= 0xff01)
                .cloned()
                .collect();
            let hook = if wheel_bindings.is_empty() {
                None
            } else {
                WHEEL.with(|ctx| *ctx.borrow_mut() = Some((app.clone(), wheel_bindings.clone())));
                match SetWindowsHookExW(WH_MOUSE_LL, Some(wheel_hook), None, 0) {
                    Ok(hook) => Some(hook),
                    Err(_) => {
                        WHEEL.with(|ctx| *ctx.borrow_mut() = None);
                        failed.extend(wheel_bindings.iter().map(|(id, _, _)| id.clone()));
                        None
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
                    failed.push(parsed[i].0.clone());
                    continue;
                }
                ids.push(id);
            }
            let _ = tx.send(failed);
            while GENERATION.load(Ordering::SeqCst) == generation {
                let mut message = MSG::default();
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    if message.message == WM_HOTKEY {
                        if let Some((id, _, _)) = parsed.get(message.wParam.0.saturating_sub(1)) {
                            if id == "stop" {
                                let _ = crate::input_arbiter::INPUT.stop();
                            }
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
            Ok(failed) => Ok(failed),
            _ => {
                GENERATION.fetch_add(1, Ordering::SeqCst);
                if let Some(thread) = guard.take() {
                    let _ = thread.join();
                }
                Err("Hotkey worker unavailable; reconnect hotkeys".into())
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
    combined: Option<bool>,
    keyboard_method: Option<String>,
    hold_only: Option<bool>,
    keyboard_source: Option<Target>,
    keyboard_targets: Option<Vec<Target>>,
    source: Option<Target>,
    twins_modifier: Option<String>,
    active_modifier: Option<String>,
    twins_source: Option<Target>,
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
                    mirror::Options {
                        mouse: mouse.unwrap_or(false),
                        keyboard: keyboard.unwrap_or(true),
                        method: mirror::KeyboardMethod::parse(
                            keyboard_method.as_deref(),
                            combined.unwrap_or(false),
                        )?,
                        hold_only: hold_only.unwrap_or(false),
                        keyboard_source,
                        keyboard_targets,
                        source,
                        twins_modifier,
                        active_modifier,
                        twins_source,
                    },
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
            app,
            operation,
            session_id,
            targets,
            shortcuts,
            mouse,
            keyboard,
            combined,
            keyboard_method,
            hold_only,
            keyboard_source,
            keyboard_targets,
            source,
            twins_modifier,
            active_modifier,
            twins_source,
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
        let epoch = crate::input_arbiter::INPUT.epoch();
        tauri::async_runtime::spawn_blocking(move || {
            let lease = crate::input_arbiter::INPUT.acquire("pointer", epoch)?;
            let _binding = lease.bind();
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

#[cfg(test)]
mod multi_comparison_tests {
    use super::*;
    fn plan(value: serde_json::Value) -> Vec<ComparisonStep> {
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn modifier_gap_does_not_allow_base_key_after_cancel() {
        assert!(wait_modifier_gap(0, || true));
        assert!(!wait_modifier_gap(200, || false));
        let mut checks = 0;
        assert!(!wait_modifier_gap(200, || {
            checks += 1;
            checks < 2
        }));
        assert_eq!(checks, 2);
    }
    #[test]
    fn budgets_and_uncertain_release_are_explicit() {
        let steps = plan(serde_json::json!([{"key":"SHIFT+1"}]));
        assert!(validate_comparison_timing(&steps, ComparisonTiming::default()).is_ok());
        for shift_vk in [0x10, 0xa0, 0xa1, 0, 0x11] {
            let timing = ComparisonTiming {
                shift_vk,
                ..ComparisonTiming::default()
            };
            assert_eq!(
                validate_comparison_timing(&steps, timing).is_ok(),
                [0x10, 0xa0, 0xa1].contains(&shift_vk)
            );
        }
        for timeout_ms in [25, 100, 250] {
            for modifier_gap_ms in [0, 50, 100, 200] {
                assert!(validate_comparison_timing(
                    &steps,
                    ComparisonTiming {
                        timeout_ms,
                        modifier_gap_ms,
                        ..ComparisonTiming::default()
                    }
                )
                .is_ok());
            }
        }
        assert!(validate_comparison_timing(
            &steps,
            ComparisonTiming {
                timeout_ms: 1000,
                modifier_gap_ms: 0,
                ..ComparisonTiming::default()
            }
        )
        .is_err());
        assert!(validate_comparison_timing(
            &steps,
            ComparisonTiming {
                timeout_ms: 25,
                modifier_gap_ms: 999,
                ..ComparisonTiming::default()
            }
        )
        .is_err());
        let mut long = vec![
            ComparisonStep {
                key: None,
                wait: Some(1500)
            };
            6
        ];
        long.extend(vec![
            ComparisonStep {
                key: Some("SHIFT+1".into()),
                wait: None
            };
            5
        ]);
        assert!(validate_comparison_timing(
            &long,
            ComparisonTiming {
                timeout_ms: 25,
                modifier_gap_ms: 200,
                ..ComparisonTiming::default()
            }
        )
        .is_err());
        assert_eq!(
            activity_delivery_flags(&[
                serde_json::json!({"phase":"key-down","error":1460,"ok":false}),
                serde_json::json!({"phase":"key-up","ok":true})
            ]),
            (true, false)
        );
        assert_eq!(
            activity_delivery_flags(&[
                serde_json::json!({"phase":"modifier-up","error":1460,"ok":false})
            ]),
            (true, true)
        );
        assert_eq!(
            activity_delivery_flags(&[serde_json::json!({"phase":"key-up","skipped":true})]),
            (false, true)
        );
        assert_eq!(
            activity_delivery_flags(&[serde_json::json!({"phase":"key-up","ok":true})]),
            (false, false)
        );
    }
    #[test]
    fn allows_only_bounded_key_wait_plans() {
        assert!(validate_comparison_steps(&plan(serde_json::json!([
            {"key":"B"},{"wait":500},{"key":"SHIFT+1"},{"key":"CTRL+B"}
        ])))
        .is_ok());
        for value in [
            serde_json::json!([]),
            serde_json::json!([{"wait":500}]),
            serde_json::json!([{"key":"ALT+F4"}]),
            serde_json::json!([{"key":"CTRL+CTRL+B"}]),
            serde_json::json!([{"key":"B","wait":500}]),
            serde_json::json!([{"key":"ENTER"}]),
            serde_json::json!([{"key":"B"},{"wait":1501}]),
        ] {
            assert!(validate_comparison_steps(&plan(value)).is_err());
        }
        assert!(validate_comparison_steps(&vec![
            ComparisonStep {
                key: Some("B".into()),
                wait: None
            };
            11
        ])
        .is_err());
        let mut too_long = vec![
            ComparisonStep {
                key: None,
                wait: Some(1500)
            };
            7
        ];
        too_long.push(ComparisonStep {
            key: Some("B".into()),
            wait: None,
        });
        assert!(validate_comparison_steps(&too_long).is_err());
        assert!(serde_json::from_value::<ComparisonStep>(
            serde_json::json!({"key":"B","hold":10000})
        )
        .is_err());
    }
}

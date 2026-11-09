//! Explicit 30-second browser-process observation. Never returns a URL/token over IPC.
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::Emitter;

struct Attempt {
    id: String,
    phase: Arc<AtomicU8>,
}
static ATTEMPT: Mutex<Option<Attempt>> = Mutex::new(None);
struct AttemptGuard(String);
impl Drop for AttemptGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = ATTEMPT.lock() {
            if slot.as_ref().is_some_and(|attempt| attempt.id == self.0) {
                *slot = None;
            }
        }
    }
}
// Best effort for owned buffers only; OS, URL parser and WebView can retain copies.
struct Sensitive(String);
impl Drop for Sensitive {
    fn drop(&mut self) {
        unsafe {
            for byte in self.0.as_mut_vec() {
                std::ptr::write_volatile(byte, 0);
            }
        }
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn account_uid(key: &str) -> Result<String, String> {
    let stored = Sensitive(
        super::get_magic(key)
            .map_err(|_| "account_unavailable")?
            .ok_or("missing_account")?,
    );
    let mut values = stored
        .0
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| *key == "MyComUserUid")
        .map(|(_, value)| value);
    let uid = values.next().ok_or("missing_uid")?;
    if values.next().is_some()
        || uid.is_empty()
        || uid.len() > 32
        || !uid.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("missing_uid".into());
    }
    Ok(uid.to_string())
}
fn exchange_uid(value: &str) -> Option<String> {
    if value.len() > 16384 {
        return None;
    }
    let url = tauri::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("auth-ac.vkplay.ru")
        || url.path() != "/oauth2/session/exchange/confirm/init"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut uid = None;
    let mut token = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "user_id"
                if uid.is_none()
                    && !value.is_empty()
                    && value.len() <= 32
                    && value.bytes().all(|c| c.is_ascii_digit()) =>
            {
                uid = Some(value.into_owned())
            }
            "token" if !token && !value.is_empty() && value.len() <= 8192 => token = true,
            _ => return None,
        }
    }
    if token {
        uid
    } else {
        None
    }
}
fn browser(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "zen.exe"
            | "firefox.exe"
            | "chrome.exe"
            | "msedge.exe"
            | "brave.exe"
            | "opera.exe"
            | "vivaldi.exe"
    )
}

#[tauri::command]
pub async fn gc_site_login_cancel(
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("forbidden".into());
    }
    let slot = ATTEMPT.lock().map_err(|_| "unavailable")?;
    Ok(slot
        .as_ref()
        .filter(|attempt| attempt.id == request_id)
        .is_some_and(|attempt| {
            attempt
                .phase
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        }))
}
#[tauri::command]
pub async fn gc_site_login_wait(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
    char_id: String,
    char_nick: String,
    account_key: String,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("forbidden".into());
    }
    if !valid_id(&char_id)
        || !valid_id(&request_id)
        || account_key.len() > 128
        || !(account_key == char_id
            || account_key
                .strip_prefix(&format!("{char_id}@"))
                .is_some_and(valid_id))
    {
        return Err("invalid_request".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (app, char_nick);
        Err("windows_only".into())
    }
    #[cfg(windows)]
    {
        let phase = Arc::new(AtomicU8::new(0));
        {
            let mut slot = ATTEMPT.lock().map_err(|_| "unavailable")?;
            if slot.is_some() {
                return Err("busy".into());
            }
            *slot = Some(Attempt {
                id: request_id.clone(),
                phase: phase.clone(),
            });
        }
        let _guard = AttemptGuard(request_id.clone());
        let key = account_key.clone();
        let ready_app = app.clone();
        let control = phase.clone();
        let captured = tauri::async_runtime::spawn_blocking(move || {
            let uid = account_uid(&key)?;
            let result = observe(
                &control,
                || {
                    let _ = ready_app.emit_to("main", "gc-site-login-ready", &request_id);
                },
                &uid,
            )?;
            if account_uid(&key)? != uid {
                return Err("account_changed".into());
            }
            Ok::<_, String>(result)
        })
        .await
        .map_err(|_| "unavailable")??;
        // Commit navigation atomically against cancellation. No secret is returned to JS.
        if phase
            .compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("cancelled".into());
        }
        crate::windows::open_link_browser(app, captured.0.clone(), Some(char_id), Some(char_nick))
            .await
            .map_err(|_| "open_failed")?;
        Ok("opened".into())
    }
}
#[cfg(windows)]
fn observe(phase: &AtomicU8, ready: impl FnOnce(), uid: &str) -> Result<Sensitive, String> {
    let mut seen: std::collections::HashSet<_> = super::win::all_processes()
        .into_iter()
        .filter(|(name, _)| browser(name))
        .filter_map(|(_, pid)| super::win::process_start_ms(pid).map(|start| (pid, start)))
        .collect();
    let deadline = Instant::now() + Duration::from_secs(30);
    ready();
    let mut denied = false;
    while Instant::now() < deadline {
        if phase.load(Ordering::SeqCst) != 0 {
            return Err("cancelled".into());
        }
        for (name, pid) in super::win::all_processes()
            .into_iter()
            .filter(|(name, _)| browser(name))
        {
            let _ = name;
            let Some(start) = super::win::process_start_ms(pid) else {
                continue;
            };
            if seen.contains(&(pid, start)) {
                continue;
            }
            let Some(args) = process_args(pid) else {
                denied = true;
                continue;
            };
            seen.insert((pid, start));
            let candidates: Vec<_> = args
                .iter()
                .filter_map(|arg| exchange_uid(&arg.0).map(|id| (arg, id)))
                .collect();
            if candidates.len() != 1 {
                continue;
            }
            let (url, actual) = &candidates[0];
            if actual != uid {
                return Err("wrong_account".into());
            }
            if phase.load(Ordering::SeqCst) != 0 {
                return Err("cancelled".into());
            }
            return Ok(Sensitive(url.0.clone()));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(if denied {
        "process_unavailable"
    } else {
        "timeout"
    }
    .into())
}

#[cfg(windows)]
fn process_args(pid: u32) -> Option<Vec<Sensitive>> {
    use std::ffi::c_void;
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetCurrentProcess() -> *mut c_void;
        fn GetCurrentProcessId() -> u32;
        fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(
            token: *mut c_void,
            class: u32,
            buffer: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
        fn EqualSid(a: *const c_void, b: *const c_void) -> i32;
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQueryInformationProcess(
            process: *mut c_void,
            class: u32,
            buffer: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn CommandLineToArgvW(command: *const u16, count: *mut i32) -> *mut *mut u16;
    }
    struct Handle(*mut c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    unsafe fn user(process: *mut c_void) -> Option<Vec<usize>> {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(process, 8, &mut token) == 0 {
            return None;
        }
        let token = Handle(token);
        let mut needed = 0;
        GetTokenInformation(token.0, 1, std::ptr::null_mut(), 0, &mut needed);
        if needed == 0 || needed > 65536 {
            return None;
        }
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(token.0, 1, buffer.as_mut_ptr().cast(), needed, &mut needed) == 0 {
            return None;
        }
        Some(buffer)
    }
    unsafe {
        let mut session = 0;
        let mut own_session = 0;
        if ProcessIdToSessionId(pid, &mut session) == 0
            || ProcessIdToSessionId(GetCurrentProcessId(), &mut own_session) == 0
            || session != own_session
        {
            return None;
        }
        let process = Handle(OpenProcess(0x1000, 0, pid));
        if process.0.is_null() {
            return None;
        }
        let owner = user(process.0)?;
        let own = user(GetCurrentProcess())?;
        if EqualSid(owner[0] as *const c_void, own[0] as *const c_void) == 0 {
            return None;
        }
        let mut needed = 0;
        NtQueryInformationProcess(process.0, 60, std::ptr::null_mut(), 0, &mut needed);
        if needed < std::mem::size_of::<UnicodeString>() as u32 || needed > 131072 {
            return None;
        }
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        let status = NtQueryInformationProcess(
            process.0,
            60,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * std::mem::size_of::<usize>()) as u32,
            &mut needed,
        );
        if status < 0 {
            return None;
        }
        let header = &*(buffer.as_ptr() as *const UnicodeString);
        let start = buffer.as_ptr() as usize;
        let end = start + buffer.len() * std::mem::size_of::<usize>();
        let address = header.buffer as usize;
        let length = header.length as usize;
        if !length.is_multiple_of(2)
            || !address.is_multiple_of(2)
            || address < start
            || address.checked_add(length)? > end
        {
            return None;
        }
        let mut command = std::slice::from_raw_parts(header.buffer, length / 2).to_vec();
        command.push(0);
        let mut count = 0;
        let argv = CommandLineToArgvW(command.as_ptr(), &mut count);
        for word in &mut command {
            std::ptr::write_volatile(word, 0);
        }
        for word in &mut buffer {
            std::ptr::write_volatile(word, 0);
        }
        if argv.is_null() {
            return None;
        }
        let mut result = Vec::new();
        if (1..=256).contains(&count) {
            for arg in std::slice::from_raw_parts(argv, count as usize) {
                let mut length = 0;
                while length < 16384 && *arg.add(length) != 0 {
                    length += 1;
                }
                if length < 16384 {
                    result.push(Sensitive(String::from_utf16_lossy(
                        std::slice::from_raw_parts(*arg, length),
                    )));
                }
                for index in 0..length {
                    std::ptr::write_volatile(arg.add(index), 0);
                }
            }
        }
        LocalFree(argv.cast());
        Some(result)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn own_process_command_line_is_readable_without_elevation() {
        let args = process_args(std::process::id()).expect("own process command line");
        assert!(!args.is_empty());
    }
    #[test]
    fn accepts_only_exact_exchange_and_unique_parameters() {
        let good = "https://auth-ac.vkplay.ru/oauth2/session/exchange/confirm/init?token=SYNTHETIC&user_id=123";
        assert_eq!(exchange_uid(good).as_deref(), Some("123"));
        for invalid in [
            good.replace("https:", "http:"),
            good.replace("auth-ac.vkplay.ru", "auth-ac.vkplay.ru.evil.test"),
            format!("{good}&user_id=123"),
            format!("{good}#fragment"),
            good.replace("user_id=123", "user_id=bad"),
            good.replace("token=SYNTHETIC&", ""),
        ] {
            assert!(exchange_uid(&invalid).is_none());
        }
    }
    #[test]
    fn browser_filter_and_ids_are_bounded() {
        assert!(browser("ZEN.EXE"));
        assert!(!browser("powershell.exe"));
        assert!(valid_id("character_1"));
        assert!(!valid_id("a@b"));
    }
}

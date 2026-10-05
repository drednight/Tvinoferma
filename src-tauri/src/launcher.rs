//! Запуск игры: у каждого аккаунта свой GameCenter (VK Play) в своей папке.
//!
//! Что делает запуск аккаунта (`launcher_start`):
//! 1. Если для персонажа запомнен вход (`launcher_capture_account`), GameCenter этого аккаунта закрывается,
//!    а в его `GameCenter.ini` записываются два ключа — `CurrentUserNick` и `MyComUserMagic2`
//!    (так же, как делает PWtools). Токен `MyComUserMagic2` лежит только в хранилище ОС (keyring),
//!    в `state.json` и в интерфейс он не попадает.
//! 2. Запускается `GameCenter.exe vkplay://play/0.61`.
//! 3. Если клиент игры уже был запущен, GameCenter спрашивает «Клиент игры уже запущен»:
//!    в этом окне выбирается «Запустить новую копию клиента» (по умолчанию выбрана она, достаточно Enter).
//!    Окно «Попытка авторизации…» с кнопкой «Прервать» не трогаем: Enter в нём прервал бы вход.
//! 4. Ждём, пока появится новый процесс клиента игры.
//! 5. Если передан заголовок и значок класса, окну нового клиента ставятся название «Ник — Класс»
//!    и значок (в фоне: окно появляется не сразу). Меняется только вид окна, сама игра не затрагивается.
//!
//! Безопасность: запускается только файл с именем `GameCenter.exe`, а ссылка запуска
//! должна начинаться с `vkplay://` и не содержать пробелов — произвольные программы отсюда не стартуют.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};
use tauri::Emitter;

const GAMECENTER_EXE: &str = "GameCenter.exe";
/// Клиенты игры: `elementclient_64.exe`, а также `elementclient.exe` и подобные образы
const CLIENT_FILTER: &str = "IMAGENAME eq elementclient*";
/// Perfect World в VK Play (id проекта 0.61)
const DEFAULT_URL: &str = "vkplay://play/0.61";
/// Класс окон-вопросов GameCenter
const DIALOG_CLASS: &str = "TYesNoForm";
/// Заголовок окна вопроса «Клиент игры уже запущен» («VK Play Игровой центр»)
const DIALOG_TITLE: &str = "VK Play";
/// Сколько ждать это окно после старта GameCenter, если клиент уже был запущен
const DIALOG_WAIT: Duration = Duration::from_secs(30);
/// Сколько ждать новый клиент игры, секунд (если не задано в вызове)
const DEFAULT_CLIENT_WAIT_SECS: u64 = 60;
/// Сколько искать окно нового клиента, чтобы подписать его и поставить значок
const DECORATE_WAIT: Duration = Duration::from_secs(90);
/// Сколько ещё следить за окном после первой подписи (игра может сама сменить заголовок при загрузке и входе в мир)
const DECORATE_KEEP: Duration = Duration::from_secs(180);
/// Как часто проверять окна клиента
const DECORATE_STEP: Duration = Duration::from_millis(700);
/// Допустимый размер значка (сторона квадрата, пикселей)
const ICON_MIN: usize = 8;
const ICON_MAX: usize = 128;

const INI_NAME: &str = "GameCenter.ini";
const KEY_NICK: &str = "CurrentUserNick";
const KEY_MAGIC: &str = "MyComUserMagic2";
const VAULT_SERVICE: &str = "com.tvinoferma.desktop";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    pid: u32,
    /// Было ли окно «Клиент игры уже запущен» и мы в нём подтвердили запуск новой копии
    dialog_clicked: bool,
    /// Был ли перед запуском подставлен сохранённый вход аккаунта в GameCenter.ini
    switched: bool,
    /// PID нового клиента игры (0 — не определён)
    client_pid: u32,
    /// Сколько GameCenter из других папок пришлось закрыть (иначе они перехватили бы запуск)
    closed_other_gc: u32,
    /// Сколько GameCenter закрыть не удалось (запущены от администратора): запуск может пойти из них
    gc_close_failed: u32,
}

/// Окна и клавиши Windows (user32) без лишних зависимостей.
#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;
    type EnumProc = unsafe extern "system" fn(Hwnd, isize) -> i32;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(proc_: EnumProc, lparam: isize) -> i32;
        fn GetClassNameW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
        fn GetWindowTextW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn PostMessageW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
        fn SendMessageTimeoutW(
            hwnd: Hwnd,
            msg: u32,
            wparam: usize,
            lparam: isize,
            flags: u32,
            timeout_ms: u32,
            result: *mut usize,
        ) -> isize;
        fn CreateIconIndirect(info: *const IconInfo) -> *mut c_void;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
        fn GetCurrentProcess() -> *mut c_void;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(
            token: *mut c_void,
            class: u32,
            info: *mut c_void,
            len: u32,
            returned: *mut u32,
        ) -> i32;
    }

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateBitmap(
            width: i32,
            height: i32,
            planes: u32,
            bits_per_pixel: u32,
            bits: *const c_void,
        ) -> *mut c_void;
        fn DeleteObject(obj: *mut c_void) -> i32;
    }

    /// ICONINFO из Win32: цветная картинка и маска значка.
    #[repr(C)]
    struct IconInfo {
        is_icon: i32,
        x_hotspot: u32,
        y_hotspot: u32,
        mask: *mut c_void,
        color: *mut c_void,
    }

    pub struct WinInfo {
        pub hwnd: usize,
        pub pid: u32,
        pub class: String,
        pub title: String,
        pub visible: bool,
    }

    fn read(f: impl Fn(*mut u16, i32) -> i32) -> String {
        let mut buf = [0u16; 256];
        let n = f(buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..n.clamp(0, 256) as usize])
    }

    unsafe extern "system" fn collect(hwnd: Hwnd, lparam: isize) -> i32 {
        let list = unsafe { &mut *(lparam as *mut Vec<WinInfo>) };
        let class = read(|b, n| unsafe { GetClassNameW(hwnd, b, n) });
        let title = read(|b, n| unsafe { GetWindowTextW(hwnd, b, n) });
        let visible = unsafe { IsWindowVisible(hwnd) } != 0;
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        list.push(WinInfo {
            hwnd: hwnd as usize,
            pid,
            class,
            title,
            visible,
        });
        1 // продолжать перебор окон
    }

    /// Все окна верхнего уровня.
    pub fn all_windows() -> Vec<WinInfo> {
        let mut list: Vec<WinInfo> = Vec::new();
        unsafe {
            EnumWindows(collect, &mut list as *mut Vec<WinInfo> as isize);
        }
        list
    }

    /// Отправка сообщения окну другого процесса с ограничением по времени: зависшее окно нас не подвесит.
    /// `Err(код)` — код ошибки Windows: 5 — отказано в доступе (окно запущено от администратора, а мы нет),
    /// 1460 — окно не ответило вовремя.
    fn send(hwnd: usize, msg: u32, wparam: usize, lparam: isize) -> Result<(), u32> {
        const SMTO_ABORTIFHUNG: u32 = 0x0002;
        let mut result: usize = 0;
        unsafe {
            let ok = SendMessageTimeoutW(
                hwnd as Hwnd,
                msg,
                wparam,
                lparam,
                SMTO_ABORTIFHUNG,
                1500,
                &mut result,
            ) != 0;
            if ok {
                Ok(())
            } else {
                Err(GetLastError())
            }
        }
    }

    /// Меняет заголовок окна (в том числе окна другого процесса).
    pub fn set_title(hwnd: usize, title: &str) -> Result<(), u32> {
        const WM_SETTEXT: u32 = 0x000C;
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        send(hwnd, WM_SETTEXT, 0, wide.as_ptr() as isize)
    }

    /// Значок из пикселей BGRA (предумноженная прозрачность), сторона — `size`. 0 — не получилось.
    /// Значок не уничтожается: он нужен окну, пока оно живо (пара маленьких значков на окно).
    pub fn make_icon(bgra: &[u8], size: usize) -> usize {
        if size == 0 || bgra.len() != size * size * 4 {
            return 0;
        }
        let mask = vec![0u8; size.div_ceil(16) * 2 * size]; // строки 1-битной маски выровнены по WORD
        unsafe {
            let color = CreateBitmap(
                size as i32,
                size as i32,
                1,
                32,
                bgra.as_ptr() as *const c_void,
            );
            let mask_bmp = CreateBitmap(
                size as i32,
                size as i32,
                1,
                1,
                mask.as_ptr() as *const c_void,
            );
            let mut icon: *mut c_void = std::ptr::null_mut();
            if !color.is_null() && !mask_bmp.is_null() {
                let info = IconInfo {
                    is_icon: 1,
                    x_hotspot: 0,
                    y_hotspot: 0,
                    mask: mask_bmp,
                    color,
                };
                icon = CreateIconIndirect(&info);
            }
            if !color.is_null() {
                DeleteObject(color);
            }
            if !mask_bmp.is_null() {
                DeleteObject(mask_bmp);
            }
            icon as usize
        }
    }

    /// Ставит окну малый (заголовок) и большой (панель задач, Alt+Tab) значки. 0 — этот значок не меняем.
    pub fn set_icons(hwnd: usize, small: usize, big: usize) -> Result<(), u32> {
        const WM_SETICON: u32 = 0x0080;
        if small != 0 {
            send(hwnd, WM_SETICON, 0, small as isize)?; // ICON_SMALL
        }
        if big != 0 {
            send(hwnd, WM_SETICON, 1, big as isize)?; // ICON_BIG
        }
        Ok(())
    }

    /// Завершает процесс по PID. `Err(код)` — код ошибки Windows (5 — отказано в доступе: процесс запущен от имени администратора).
    pub fn kill_process(pid: u32) -> Result<(), u32> {
        const PROCESS_TERMINATE: u32 = 0x0001;
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if h.is_null() {
                return Err(GetLastError());
            }
            let ok = TerminateProcess(h, 1) != 0;
            let err = if ok { 0 } else { GetLastError() };
            CloseHandle(h);
            if ok {
                Ok(())
            } else {
                Err(err)
            }
        }
    }

    /// Запущена ли сама Твиноферма с правами администратора.
    pub fn is_elevated() -> bool {
        const TOKEN_QUERY: u32 = 0x0008;
        const TOKEN_ELEVATION: u32 = 20;
        unsafe {
            let mut token: *mut c_void = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation: u32 = 0;
            let mut returned: u32 = 0;
            let ok = GetTokenInformation(
                token,
                TOKEN_ELEVATION,
                &mut elevation as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
                &mut returned,
            ) != 0;
            CloseHandle(token);
            ok && elevation != 0
        }
    }

    /// Нажатие Enter в окне (сообщения клавиатуры отправляются прямо в окно, фокус не нужен).
    pub fn press_enter(hwnd: usize) {
        const WM_KEYDOWN: u32 = 0x0100;
        const WM_KEYUP: u32 = 0x0101;
        const VK_RETURN: usize = 0x0D;
        let h = hwnd as Hwnd;
        unsafe {
            PostMessageW(h, WM_KEYDOWN, VK_RETURN, 0x001C_0001);
            PostMessageW(h, WM_KEYUP, VK_RETURN, 0xC01C_0001u32 as isize);
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub struct WinInfo {
        pub hwnd: usize,
        pub pid: u32,
        pub class: String,
        pub title: String,
        pub visible: bool,
    }
    pub fn all_windows() -> Vec<WinInfo> {
        Vec::new()
    }
    pub fn press_enter(_hwnd: usize) {}
    pub fn set_title(_hwnd: usize, _title: &str) -> Result<(), u32> {
        Err(1)
    }
    pub fn make_icon(_bgra: &[u8], _size: usize) -> usize {
        0
    }
    pub fn set_icons(_hwnd: usize, _small: usize, _big: usize) -> Result<(), u32> {
        Err(1)
    }
    pub fn kill_process(_pid: u32) -> Result<(), u32> {
        Err(1)
    }
    pub fn is_elevated() -> bool {
        false
    }
}

/// Принимает папку GameCenter или путь к `GameCenter.exe`, возвращает путь к exe.
fn resolve_gamecenter_exe(input: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input.trim().trim_matches('"'));
    let exe = if path.is_dir() {
        path.join(GAMECENTER_EXE)
    } else {
        path
    };
    let name_ok = exe
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case(GAMECENTER_EXE))
        .unwrap_or(false);
    if !name_ok {
        return Err(format!(
            "Укажите папку GameCenter или файл {}",
            GAMECENTER_EXE
        ));
    }
    if !exe.is_file() {
        return Err(format!("Файл не найден: {}", exe.display()));
    }
    Ok(exe)
}

/// Чтобы при запуске служебных утилит не мигало консольное окно.
fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Имя образа и PID из вывода `tasklist /FO CSV /NH`: `"elementclient_64.exe","22368","Console",...`
fn parse_processes(out: &str) -> Vec<(String, u32)> {
    out.lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with('"') {
                return None; // «INFO: задачи не найдены» и пустые строки
            }
            let mut parts = line.trim_matches('"').split("\",\"");
            let name = parts.next()?.to_string();
            let pid = parts.next()?.parse().ok()?;
            Some((name, pid))
        })
        .collect()
}

/// Все запущенные клиенты игры: (имя образа, PID).
fn client_processes() -> Result<Vec<(String, u32)>, String> {
    let out = hidden(Command::new("tasklist").args(["/FI", CLIENT_FILTER, "/FO", "CSV", "/NH"]))
        .output()
        .map_err(|e| e.to_string())?;
    Ok(parse_processes(&String::from_utf8_lossy(&out.stdout)))
}

/// PID всех запущенных клиентов игры.
fn client_pids() -> Result<Vec<u32>, String> {
    Ok(client_processes()?
        .into_iter()
        .map(|(_, pid)| pid)
        .collect())
}

/// Окно вопроса GameCenter «Клиент игры уже запущен»: видимое, класс `TYesNoForm`, заголовок «VK Play…».
/// Окно «Попытка авторизации…» (кнопка «Прервать») сюда не входит: Enter в нём прервал бы смену аккаунта.
fn is_gc_dialog(class: &str, title: &str, visible: bool) -> bool {
    visible
        && class.ends_with(DIALOG_CLASS)
        && title.contains(DIALOG_TITLE)
        && !title.to_lowercase().contains("авториз")
}

fn find_dialogs() -> Vec<usize> {
    win::all_windows()
        .into_iter()
        .filter(|w| is_gc_dialog(&w.class, &w.title, w.visible))
        .map(|w| w.hwnd)
        .collect()
}

/// Ждёт окно «Клиент игры уже запущен» и подтверждает запуск новой копии (Enter).
/// Возвращает `true`, если окно появилось и Enter был отправлен.
fn confirm_new_client_dialog() -> bool {
    let deadline = Instant::now() + DIALOG_WAIT;
    while Instant::now() < deadline {
        if !find_dialogs().is_empty() {
            // Enter может не дойти с первого раза — повторяем, пока окно не исчезнет
            for _ in 0..5 {
                for hwnd in find_dialogs() {
                    win::press_enter(hwnd);
                }
                sleep(Duration::from_millis(800));
                if find_dialogs().is_empty() {
                    break;
                }
            }
            return true;
        }
        sleep(Duration::from_millis(300));
    }
    false
}

// ---------------------------------------------------------------------------
// Название окна клиента («Ник — Класс») и значок класса
// ---------------------------------------------------------------------------

/// Заголовок окна: без управляющих символов, не длиннее 100 знаков. `None` — подписывать нечем.
fn clean_title(raw: &str) -> Option<String> {
    let t: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(100)
        .collect();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// Сторона квадратного значка по числу байт RGBA. `None` — размер не подходит (не квадрат или вне границ).
fn icon_side(len: usize) -> Option<usize> {
    if len == 0 || (len & 3) != 0 {
        return None;
    }
    let px = len / 4;
    let side = (px as f64).sqrt().round() as usize;
    (side * side == px && (ICON_MIN..=ICON_MAX).contains(&side)).then_some(side)
}

/// RGBA из canvas (прозрачность отдельно) → BGRA с предумноженной прозрачностью, как ждёт Windows.
fn rgba_to_bgra_premultiplied(rgba: &[u8]) -> Vec<u8> {
    let premul = |c: u8, a: u8| ((u32::from(c) * u32::from(a) + 127) / 255) as u8;
    let mut out = Vec::with_capacity(rgba.len());
    for px in rgba.chunks(4) {
        if let [r, g, b, a] = *px {
            out.extend_from_slice(&[premul(b, a), premul(g, a), premul(r, a), a]);
        }
    }
    out
}

/// Значок из пикселей RGBA (присылает интерфейс). 0 — значка нет или он некорректный.
fn icon_from_rgba(rgba: Option<&[u8]>) -> usize {
    let Some(bytes) = rgba else { return 0 };
    match icon_side(bytes.len()) {
        Some(side) => win::make_icon(&rgba_to_bgra_premultiplied(bytes), side),
        None => 0,
    }
}

/// Первый PID клиента игры, которого не было до запуска.
fn new_client_pid(before: &HashSet<u32>, now: &[u32]) -> Option<u32> {
    now.iter().copied().find(|pid| !before.contains(pid))
}

/// Окно клиента, которое стоит подписывать: видимое, с заголовком и принадлежит нужному процессу.
fn is_client_window(w: &win::WinInfo, pid: u32) -> bool {
    w.pid == pid && w.visible && !w.title.is_empty()
}

/// Чем закончилась попытка подписать окно клиента.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decorated {
    /// Название стоит (проверено по заголовку окна)
    Ok,
    /// Windows не пускает нас в окно: игра запущена от администратора, а Твиноферма — нет
    Denied,
    /// Окно нашлось, но название не принялось (код ошибки в событии)
    Failed,
    /// Окно клиента не появилось за отведённое время
    Missing,
}

/// Событие `launcher-decorate` для интерфейса: подпись окна может закончиться уже после запуска.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DecorateEvent {
    pid: u32,
    title: String,
    status: Decorated,
    code: u32,
}

/// Что накопилось за время слежения за окном клиента.
#[derive(Default)]
struct DecorateProgress {
    /// Заголовок окна уже совпал с нужным
    verified: bool,
    /// Окно клиента хотя бы раз попалось на глаза
    seen: bool,
    /// Последний код ошибки Windows
    last_error: u32,
    /// Окна, которым значок уже ставили
    with_icons: Vec<usize>,
}

/// Один проход по окнам: подписывает окна клиента `pid`. `Some(код)` — дальше пробовать бессмысленно (нет доступа).
fn decorate_step(
    progress: &mut DecorateProgress,
    windows: &[win::WinInfo],
    pid: u32,
    title: &str,
    set_title: &mut impl FnMut(usize, &str) -> Result<(), u32>,
    set_icons: &mut impl FnMut(usize) -> Result<(), u32>,
) -> Option<u32> {
    for w in windows.iter().filter(|w| is_client_window(w, pid)) {
        progress.seen = true;
        let mut touched = false;
        if w.title == title {
            progress.verified = true;
        } else {
            // заголовка нет или игра сама его переписала — ставим снова
            touched = true;
            if let Err(code) = set_title(w.hwnd, title) {
                progress.last_error = code;
                if code == ERROR_ACCESS_DENIED {
                    return Some(code);
                }
            }
        }
        if touched || !progress.with_icons.contains(&w.hwnd) {
            if let Err(code) = set_icons(w.hwnd) {
                progress.last_error = code;
                if code == ERROR_ACCESS_DENIED {
                    return Some(code);
                }
            }
            if !progress.with_icons.contains(&w.hwnd) {
                progress.with_icons.push(w.hwnd);
            }
        }
    }
    None
}

/// Подписывает окно(а) клиента и ставит значок. Окно появляется не сразу (загрузка), поэтому ищем его в фоне;
/// после первой подписи ещё `DECORATE_KEEP` следим за заголовком: игра может переписать его при загрузке.
/// Итог (`Ok`, `Denied`, …) сообщается один раз через `report`.
fn decorate_client(
    pid: u32,
    title: String,
    small: Option<Vec<u8>>,
    big: Option<Vec<u8>>,
    report: impl Fn(Decorated, u32),
) {
    let small_icon = icon_from_rgba(small.as_deref());
    let big_icon = icon_from_rgba(big.as_deref());
    let deadline = Instant::now() + DECORATE_WAIT;
    let mut progress = DecorateProgress::default();
    let mut reported = false;
    let mut verified_at: Option<Instant> = None;
    while Instant::now() < deadline {
        let windows = win::all_windows();
        let denied = decorate_step(
            &mut progress,
            &windows,
            pid,
            &title,
            &mut |hwnd, t| win::set_title(hwnd, t),
            &mut |hwnd| win::set_icons(hwnd, small_icon, big_icon),
        );
        if let Some(code) = denied {
            report(Decorated::Denied, code);
            return;
        }
        if progress.verified {
            if !reported {
                reported = true;
                verified_at = Some(Instant::now());
                report(Decorated::Ok, 0);
            }
            if verified_at.is_some_and(|t| t.elapsed() > DECORATE_KEEP) {
                return;
            }
        }
        sleep(DECORATE_STEP);
    }
    if !reported {
        let status = if progress.seen {
            Decorated::Failed
        } else {
            Decorated::Missing
        };
        report(status, progress.last_error);
    }
}

// ---------------------------------------------------------------------------
// GameCenter.ini: два ключа аккаунта
// ---------------------------------------------------------------------------

enum IniEncoding {
    /// ANSI / UTF-8: правим строки побайтово, остальные байты файла не трогаем
    Bytes,
    /// UTF-16 LE с BOM
    Utf16Le,
}

fn decode_ini(bytes: &[u8]) -> (String, IniEncoding) {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // пары байт после BOM (лишний нечётный байт в конце игнорируется)
        let units: Vec<u16> = (2..bytes.len().saturating_sub(1))
            .step_by(2)
            .map(|i| u16::from_le_bytes([bytes[i], bytes[i + 1]]))
            .collect();
        (String::from_utf16_lossy(&units), IniEncoding::Utf16Le)
    } else {
        // Побайтово: любая однобайтная кодировка и UTF-8 возвращаются в файл без потерь
        (
            bytes.iter().map(|&b| b as char).collect(),
            IniEncoding::Bytes,
        )
    }
}

fn encode_ini(text: &str, enc: &IniEncoding) -> Vec<u8> {
    match enc {
        IniEncoding::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            out
        }
        IniEncoding::Bytes => text.chars().map(|c| c as u32 as u8).collect(),
    }
}

/// Значение ключа (первое вхождение; имя ключа без учёта регистра).
fn ini_get(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (k, v) = line.trim_start().split_once('=')?;
        k.trim()
            .eq_ignore_ascii_case(key)
            .then(|| v.trim().to_string())
    })
}

/// Записывает значение ключа: заменяет существующую строку, иначе добавляет после `[Main]`
/// (или в конец файла). Остальные строки и переводы строк не меняются.
fn ini_set(text: &str, key: &str, value: &str) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_string).collect();
    let is_key = |line: &str| {
        line.trim_start()
            .split_once('=')
            .map(|(k, _)| k.trim().eq_ignore_ascii_case(key))
            .unwrap_or(false)
    };
    if let Some(i) = lines.iter().position(|l| is_key(l.as_str())) {
        let ending = if lines[i].ends_with("\r\n") {
            "\r\n"
        } else if lines[i].ends_with('\n') {
            "\n"
        } else {
            ""
        };
        lines[i] = format!("{}={}{}", key, value, ending);
    } else if let Some(i) = lines
        .iter()
        .position(|l| l.trim().eq_ignore_ascii_case("[Main]"))
    {
        if !lines[i].ends_with('\n') {
            lines[i].push_str(eol);
        }
        lines.insert(i + 1, format!("{}={}{}", key, value, eol));
    } else {
        if let Some(last) = lines.last_mut() {
            if !last.ends_with('\n') {
                last.push_str(eol);
            }
        }
        lines.push(format!("{}={}{}", key, value, eol));
    }
    lines.concat()
}

/// Токен и ник, которые можно безопасно записать в ini (одна строка, печатные ASCII).
fn safe_ini_value(v: &str) -> bool {
    !v.is_empty() && v.len() <= 512 && v.chars().all(|c| c.is_ascii_graphic())
}

/// Значение из ini для показа в интерфейсе (ник): в файле могла быть UTF-8 или cp1251.
fn display_value(raw: &str) -> String {
    if raw.chars().any(|c| c as u32 > 0xFF) {
        return raw.to_string(); // файл был UTF-16: символы уже настоящие
    }
    let bytes: Vec<u8> = raw.chars().map(|c| c as u32 as u8).collect();
    match String::from_utf8(bytes.clone()) {
        Ok(s) => s,
        Err(_) => bytes
            .iter()
            .map(|&b| match b {
                0xA8 => 'Ё',
                0xB8 => 'ё',
                0xC0..=0xFF => char::from_u32(0x410 + (b as u32 - 0xC0)).unwrap_or('?'),
                _ if b < 0x80 => b as char,
                _ => '?',
            })
            .collect(),
    }
}

fn gc_ini_path(exe: &Path) -> Result<PathBuf, String> {
    exe.parent()
        .map(|dir| dir.join(INI_NAME))
        .ok_or_else(|| "Не удалось определить папку GameCenter".to_string())
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("ini.tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Подставляет вход аккаунта в `GameCenter.ini` рядом с exe. При первой подмене рядом
/// остаётся копия исходного файла `GameCenter.ini.tvinoferma-backup`.
fn switch_account(exe: &Path, nick: Option<&str>, magic: &str) -> Result<(), String> {
    if !safe_ini_value(magic) {
        return Err("Сохранённый вход повреждён: запомните вход заново".to_string());
    }
    let ini = gc_ini_path(exe)?;
    let bytes = std::fs::read(&ini).map_err(|e| format!("{}: {}", ini.display(), e))?;
    let backup = ini.with_extension("ini.tvinoferma-backup");
    if !backup.exists() {
        let _ = std::fs::copy(&ini, &backup);
    }
    let (text, enc) = decode_ini(&bytes);
    let mut text = ini_set(&text, KEY_MAGIC, magic);
    // Ник — только для отображения до входа; не-ASCII не пишем, чтобы не испортить кодировку файла
    if let Some(n) = nick
        .map(str::trim)
        .filter(|n| !n.is_empty() && n.is_ascii() && !n.contains(['\r', '\n']))
    {
        text = ini_set(&text, KEY_NICK, n);
    }
    write_atomic(&ini, &encode_ini(&text, &enc))
}

// ---------------------------------------------------------------------------
// Токен аккаунта — в хранилище ОС (как учётные данные в commands/secrets.rs)
// ---------------------------------------------------------------------------

fn magic_entry(char_id: &str) -> Result<keyring::Entry, String> {
    if char_id.is_empty() || char_id.len() > 128 {
        return Err("Некорректный id персонажа".to_string());
    }
    keyring::Entry::new(VAULT_SERVICE, &format!("gc-magic:{}", char_id)).map_err(|e| e.to_string())
}

fn get_magic(char_id: &str) -> Result<Option<String>, String> {
    match magic_entry(char_id)?.get_password() {
        Ok(v) if !v.is_empty() => Ok(Some(v)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Путь без префикса `\\?\` (так его возвращает Windows в списке процессов).
fn plain_path(p: &Path) -> String {
    let s = std::fs::canonicalize(p)
        .unwrap_or_else(|_| p.to_path_buf())
        .display()
        .to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

/// Итог закрытия GameCenter перед запуском.
#[derive(Debug, Default, PartialEq, Eq)]
struct GcClosed {
    /// Сколько GameCenter из других папок закрыто
    others: u32,
    /// Сколько GameCenter закрыть не удалось (обычно они запущены от администратора)
    failed: u32,
}

/// Разбор строки «закрыто_чужих не_удалось», которую печатает скрипт закрытия.
fn parse_gc_closed(out: &str) -> GcClosed {
    let mut it = out.split_whitespace().filter_map(|w| w.parse::<u32>().ok());
    GcClosed {
        others: it.next().unwrap_or(0),
        failed: it.next().unwrap_or(0),
    }
}

/// Закрывает GameCenter перед запуском. Запущенные клиенты игры продолжают работать.
///
/// GameCenter работает в одном экземпляре на компьютер: если уже открыт GameCenter из другой папки,
/// новый просто передаёт ему ссылку запуска, и игра стартует под тем аккаунтом, что открыт там.
/// Поэтому GameCenter из **других** папок закрываются всегда, а из этого `exe` — только если `close_own`
/// (когда подставляется сохранённый вход).
fn close_gamecenters(exe: &Path, close_own: bool) -> Result<GcClosed, String> {
    let script = "$me = $env:TF_GC_EXE; $own = $env:TF_GC_OWN -eq '1'; $others = 0; $failed = 0; \
                  Get-CimInstance Win32_Process -Filter \"Name='GameCenter.exe'\" | ForEach-Object { \
                    $mine = ($_.ExecutablePath -ieq $me); \
                    if ($mine -and -not $own) { return }; \
                    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; if (-not $mine) { $others++ } } \
                    catch { $failed++ } \
                  }; \
                  Write-Output \"$others $failed\"";
    let out = hidden(
        Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("TF_GC_EXE", plain_path(exe))
            .env("TF_GC_OWN", if close_own { "1" } else { "0" }),
    )
    .output()
    .map_err(|e| format!("powershell: {}", e))?;
    if out.status.success() {
        Ok(parse_gc_closed(&String::from_utf8_lossy(&out.stdout)))
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

/// Проверка пути из настроек: возвращает полный путь к `GameCenter.exe`.
#[tauri::command]
pub fn launcher_check_path(path: String) -> Result<String, String> {
    resolve_gamecenter_exe(&path).map(|p| p.display().to_string())
}

/// Что сейчас открыто в GameCenter: путь к `GameCenter.exe`, ник и есть ли вход вообще.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcInfo {
    exe: String,
    nick: String,
    logged_in: bool,
}

/// Читает из `GameCenter.ini` ник и признак входа. Токен наружу не отдаётся.
fn read_gc_info(exe: &Path) -> Result<GcInfo, String> {
    let ini = gc_ini_path(exe)?;
    let bytes = std::fs::read(&ini).map_err(|e| format!("{}: {}", ini.display(), e))?;
    let (text, _) = decode_ini(&bytes);
    let logged_in = ini_get(&text, KEY_MAGIC)
        .map(|m| !m.is_empty())
        .unwrap_or(false);
    let nick = ini_get(&text, KEY_NICK)
        .map(|v| display_value(&v))
        .unwrap_or_default();
    Ok(GcInfo {
        exe: exe.display().to_string(),
        nick,
        logged_in,
    })
}

/// Какой аккаунт сейчас открыт в этом GameCenter (для окна «GameCenter и персонажи»).
#[tauri::command]
pub async fn launcher_gc_info(path: String) -> Result<GcInfo, String> {
    let exe = resolve_gamecenter_exe(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_gc_info(&exe))
        .await
        .map_err(|e| e.to_string())?
}

/// Окно проводника «Открыть файл» (системное, через Windows Forms): пользователь указывает `GameCenter.exe`.
/// Скрипт ничего не запускает и не читает, только возвращает выбранный путь.
#[cfg(windows)]
const PICKER_SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = 'Укажите файл GameCenter.exe'
$dlg.Filter = 'GameCenter.exe|GameCenter.exe|Программы (*.exe)|*.exe'
$dlg.CheckFileExists = $true
if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }
$owner.Dispose()
"#;

/// Вывод скрипта выбора файла: путь одной строкой (без BOM и переводов строк) или `None`, если окно закрыли.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_picker_output(out: &str) -> Option<String> {
    let path = out.trim_matches(|c: char| c == '\u{feff}' || c.is_whitespace());
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Открывает проводник и возвращает полный путь к выбранному `GameCenter.exe` (`None` — окно закрыли без выбора).
#[tauri::command]
pub async fn launcher_pick_gamecenter() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let out = tauri::async_runtime::spawn_blocking(|| {
            hidden(Command::new("powershell").args([
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                PICKER_SCRIPT,
            ]))
            .output()
            .map_err(|e| format!("powershell: {}", e))
        })
        .await
        .map_err(|e| e.to_string())??;
        match parse_picker_output(&String::from_utf8_lossy(&out.stdout)) {
            Some(path) => resolve_gamecenter_exe(&path).map(|p| Some(p.display().to_string())),
            None => Ok(None),
        }
    }
    #[cfg(not(windows))]
    {
        Err("Выбор файла доступен только в Windows".to_string())
    }
}

/// Запоминает вход, который сейчас открыт в этом GameCenter: токен — в хранилище ОС, ник возвращается
/// для показа. Перед этим войдите в нужный аккаунт в самом GameCenter.
#[tauri::command]
pub async fn launcher_capture_account(char_id: String, path: String) -> Result<String, String> {
    let exe = resolve_gamecenter_exe(&path)?;
    let ini = gc_ini_path(&exe)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&ini).map_err(|e| format!("{}: {}", ini.display(), e))?;
        let (text, _) = decode_ini(&bytes);
        let magic = ini_get(&text, KEY_MAGIC)
            .filter(|m| !m.is_empty())
            .ok_or_else(|| {
                "В этом GameCenter не выполнен вход: войдите в аккаунт и повторите".to_string()
            })?;
        if !safe_ini_value(&magic) {
            return Err("Данные входа в GameCenter.ini имеют неожиданный вид".to_string());
        }
        magic_entry(&char_id)?
            .set_password(&magic)
            .map_err(|e| e.to_string())?;
        Ok::<String, String>(
            ini_get(&text, KEY_NICK)
                .map(|v| display_value(&v))
                .unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Удаляет сохранённый вход персонажа из хранилища ОС.
#[tauri::command]
pub fn launcher_forget_account(char_id: String) -> Result<(), String> {
    match magic_entry(&char_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Есть ли сохранённый вход у персонажа.
#[tauri::command]
pub async fn launcher_has_account(char_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || get_magic(&char_id).map(|m| m.is_some()))
        .await
        .map_err(|e| e.to_string())?
}

/// Запускает игру для аккаунта и дожидается нового клиента.
///
/// 1. Закрывает GameCenter из других папок (иначе они перехватят запуск и откроют игру под своим аккаунтом).
///    Если у персонажа (`char_id`) сохранён вход — закрывает и этот GameCenter и подставляет вход в его ini.
/// 2. Запоминает, сколько клиентов игры уже запущено, и стартует `GameCenter.exe <ссылка>`.
/// 3. Если клиенты уже были — ждёт окно «Клиент игры уже запущен» и выбирает «Запустить новую копию клиента».
///    Если не было — ничего не нажимает.
/// 4. Ждёт, пока появится новый клиент игры (до `wait_secs`, по умолчанию 60 с); иначе — ошибка.
/// 5. Если передан `window_title`, в фоне подписывает окно нового клиента и ставит значок (`icon_small`, `icon_big` — RGBA);
///    итог приходит событием `launcher-decorate`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn launcher_start(
    app: tauri::AppHandle,
    path: String,
    char_id: Option<String>,
    nick: Option<String>,
    url: Option<String>,
    wait_secs: Option<u64>,
    window_title: Option<String>,
    icon_small: Option<Vec<u8>>,
    icon_big: Option<Vec<u8>>,
) -> Result<LaunchInfo, String> {
    let exe = resolve_gamecenter_exe(&path)?;
    let url = url.unwrap_or_else(|| DEFAULT_URL.to_string());
    if !url.starts_with("vkplay://") || url.chars().any(char::is_whitespace) {
        return Err("Некорректная ссылка запуска".to_string());
    }
    let dir = exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Не удалось определить папку GameCenter".to_string())?;
    let wait = Duration::from_secs(wait_secs.unwrap_or(DEFAULT_CLIENT_WAIT_SECS).clamp(5, 600));

    tauri::async_runtime::spawn_blocking(move || {
        let id = char_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let magic = id.map(get_magic).transpose()?.flatten();
        // Чужие GameCenter закрываем всегда, свой — только если подставляем в него сохранённый вход
        let closed = close_gamecenters(&exe, magic.is_some())?;
        if magic.is_some() || closed.others > 0 {
            sleep(Duration::from_millis(1500));
        }
        let switched = match magic {
            Some(magic) => {
                switch_account(&exe, nick.as_deref(), &magic)?;
                true
            }
            None => false,
        };

        let before: HashSet<u32> = client_pids()?.into_iter().collect();
        let child = Command::new(&exe)
            .current_dir(&dir)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("{}: {}", exe.display(), e))?;
        let pid = child.id();

        let dialog_clicked = !before.is_empty() && confirm_new_client_dialog();

        let deadline = Instant::now() + wait;
        let client_pid = loop {
            if let Some(pid) = new_client_pid(&before, &client_pids()?) {
                break pid;
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Клиент игры не запустился за {} с (GameCenter: {})",
                    wait.as_secs(),
                    exe.display()
                ));
            }
            sleep(Duration::from_millis(500));
        };

        // Название «Ник — Класс» и значок: окно появится не сразу, поэтому работаем в фоне, запуск следующего аккаунта не ждёт
        if let Some(title) = window_title.as_deref().and_then(clean_title) {
            std::thread::spawn(move || {
                let shown = title.clone();
                decorate_client(client_pid, title, icon_small, icon_big, |status, code| {
                    let _ = app.emit(
                        "launcher-decorate",
                        DecorateEvent {
                            pid: client_pid,
                            title: shown.clone(),
                            status,
                            code,
                        },
                    );
                });
            });
        }

        Ok::<LaunchInfo, String>(LaunchInfo {
            pid,
            dialog_clicked,
            switched,
            client_pid,
            closed_other_gc: closed.others,
            gc_close_failed: closed.failed,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// PID всех запущенных клиентов игры (`elementclient_64.exe`).
#[tauri::command]
pub async fn launcher_running_clients() -> Result<Vec<u32>, String> {
    tauri::async_runtime::spawn_blocking(client_pids)
        .await
        .map_err(|e| e.to_string())?
}

/// Код ошибки Windows «Отказано в доступе»: клиент запущен от имени администратора, а Твиноферма — нет
/// (для окон это запрет интерфейсной изоляции UIPI).
const ERROR_ACCESS_DENIED: u32 = 5;

/// Итог закрытия окон игры.
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloseReport {
    /// Сколько клиентов игры было запущено
    pub found: u32,
    /// Сколько удалось закрыть
    pub closed: u32,
    /// Сколько закрыть не удалось
    pub failed: u32,
    /// Из них — отказано в доступе (игра запущена от имени администратора)
    pub denied: u32,
    /// Запущена ли сама Твиноферма от имени администратора
    pub elevated: bool,
    /// Имена образов, которые нашли (для диагностики)
    pub images: Vec<String>,
    /// Почему не закрылся каждый из процессов: «PID 1234: отказано в доступе (код 5)»
    pub details: Vec<String>,
    /// Ошибка поиска процессов (если сам поиск не удался)
    pub error: String,
}

/// Человеческое описание кода ошибки Windows при закрытии процесса.
fn kill_error_text(code: u32) -> String {
    match code {
        ERROR_ACCESS_DENIED => {
            "отказано в доступе (код 5): процесс запущен от имени администратора".into()
        }
        87 => "процесс уже завершился (код 87)".into(),
        c => format!("код ошибки Windows {}", c),
    }
}

/// Закрывает процессы из списка через `kill` и собирает отчёт. `kill` возвращает `Err(код Windows)`.
fn close_with(
    list: Vec<(String, u32)>,
    elevated: bool,
    kill: impl Fn(u32) -> Result<(), u32>,
) -> CloseReport {
    let mut report = CloseReport {
        found: list.len() as u32,
        elevated,
        ..Default::default()
    };
    for (name, pid) in list {
        if !report.images.contains(&name) {
            report.images.push(name);
        }
        match kill(pid) {
            Ok(()) => report.closed += 1,
            // 87 — процесс уже исчез между поиском и закрытием: для нас это то же «закрыт»
            Err(87) => report.closed += 1,
            Err(code) => {
                report.failed += 1;
                if code == ERROR_ACCESS_DENIED {
                    report.denied += 1;
                }
                report
                    .details
                    .push(format!("PID {}: {}", pid, kill_error_text(code)));
            }
        }
    }
    report
}

/// Закрывает все клиенты игры по одному (по PID) и возвращает отчёт. Вызывается из команды и из меню трея.
/// Процесс завершается напрямую (`TerminateProcess`), поэтому причина отказа известна точно, а не угадывается по тексту `taskkill`.
pub fn close_clients_now() -> CloseReport {
    match client_processes() {
        Ok(list) => close_with(list, win::is_elevated(), win::kill_process),
        Err(e) => CloseReport {
            error: e,
            elevated: win::is_elevated(),
            ..Default::default()
        },
    }
}

/// Закрывает все клиенты игры.
#[tauri::command]
pub async fn launcher_close_clients() -> Result<CloseReport, String> {
    tauri::async_runtime::spawn_blocking(close_clients_now)
        .await
        .map_err(|e| e.to_string())
}

/// Команда PowerShell, которая запускает `taskkill` с правами администратора (покажет запрос Windows — UAC).
/// PID — только числа, поэтому подставлять их в строку безопасно.
fn elevated_kill_script(pids: &[u32]) -> String {
    let args = pids
        .iter()
        .flat_map(|p| ["'/PID'".to_string(), format!("'{}'", p)])
        .chain(["'/F'".to_string()])
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "Start-Process -FilePath taskkill -ArgumentList {} -Verb RunAs -WindowStyle Hidden -Wait -ErrorAction Stop",
        args
    )
}

/// Закрывает клиенты игры с правами администратора: Windows спросит разрешение (UAC), затем `taskkill` выполнится от администратора.
/// Нужно, когда игра запущена от имени администратора, а Твиноферма — обычным пользователем.
#[tauri::command]
pub async fn launcher_close_clients_elevated() -> Result<CloseReport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let before = client_processes()?;
        if before.is_empty() {
            return Ok(CloseReport::default());
        }
        let pids: Vec<u32> = before.iter().map(|(_, pid)| *pid).collect();
        let out = hidden(Command::new("powershell").args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            elevated_kill_script(&pids).as_str(),
        ]))
        .output()
        .map_err(|e| format!("powershell: {}", e))?;
        if !out.status.success() {
            return Err("Запрос прав администратора отклонён или не выполнен".to_string());
        }
        let after = client_processes()?;
        let mut report = CloseReport {
            found: before.len() as u32,
            elevated: true, // закрывал процесс с правами администратора
            images: before.iter().map(|(n, _)| n.clone()).collect(),
            ..Default::default()
        };
        report.images.dedup();
        for (_, pid) in &before {
            if after.iter().any(|(_, p)| p == pid) {
                report.failed += 1;
                report.details.push(format!(
                    "PID {}: не закрылся и с правами администратора",
                    pid
                ));
            } else {
                report.closed += 1;
            }
        }
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Диагностика: видимые окна VK Play и окна вопросов GameCenter (`hwnd | класс | заголовок`).
/// Нужна, если автоматическое подтверждение не сработало.
#[tauri::command]
pub fn launcher_find_dialogs() -> Vec<String> {
    win::all_windows()
        .into_iter()
        .filter(|w| {
            w.visible && (w.class.ends_with(DIALOG_CLASS) || w.title.contains(DIALOG_TITLE))
        })
        .map(|w| format!("{} | {} | {}", w.hwnd, w.class, w.title))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_title_is_cleaned() {
        assert_eq!(
            clean_title("  Twin — Маг \n").as_deref(),
            Some("Twin — Маг")
        );
        assert_eq!(clean_title("a\u{0}b\tc").as_deref(), Some("abc"));
        assert_eq!(clean_title("   "), None);
        assert_eq!(clean_title(&"я".repeat(300)).unwrap().chars().count(), 100);
    }

    #[test]
    fn close_report_counts_and_explains_failures() {
        let list = vec![
            ("elementclient_64.exe".to_string(), 10),
            ("elementclient_64.exe".to_string(), 20),
            ("elementclient_64.exe".to_string(), 30),
            ("elementclient.exe".to_string(), 40),
        ];
        let r = close_with(list, false, |pid| match pid {
            10 => Ok(()),
            20 => Err(5),
            30 => Err(87),
            _ => Err(1),
        });
        assert_eq!((r.found, r.closed, r.failed, r.denied), (4, 2, 2, 1));
        assert_eq!(r.images, vec!["elementclient_64.exe", "elementclient.exe"]);
        assert!(!r.elevated);
        assert_eq!(r.details.len(), 2);
        assert!(r.details[0].starts_with("PID 20: отказано в доступе"));
        assert!(r.details[1].contains("код ошибки Windows 1"));
    }

    #[test]
    fn close_report_for_empty_list() {
        let r = close_with(vec![], true, |_| Ok(()));
        assert_eq!((r.found, r.closed, r.failed), (0, 0, 0));
        assert!(r.elevated);
    }

    #[test]
    fn elevated_kill_script_lists_every_pid() {
        let script = elevated_kill_script(&[11, 22]);
        assert!(script.contains("'/PID','11','/PID','22','/F'"));
        assert!(script.contains("-Verb RunAs"));
    }

    #[test]
    fn icon_must_be_a_small_square() {
        assert_eq!(icon_side(16 * 16 * 4), Some(16));
        assert_eq!(icon_side(48 * 48 * 4), Some(48));
        assert_eq!(icon_side(0), None);
        assert_eq!(icon_side(16 * 16 * 4 + 1), None);
        assert_eq!(icon_side(16 * 8 * 4), None); // не квадрат
        assert_eq!(icon_side(4 * 4 * 4), None); // слишком мелкий
        assert_eq!(icon_side(256 * 256 * 4), None); // слишком крупный
    }

    #[test]
    fn pixels_become_premultiplied_bgra() {
        // красный, непрозрачный; зелёный, наполовину прозрачный; полностью прозрачный
        let rgba = [255, 0, 0, 255, 0, 200, 0, 128, 9, 9, 9, 0];
        assert_eq!(
            rgba_to_bgra_premultiplied(&rgba),
            vec![0, 0, 255, 255, 0, 100, 0, 128, 0, 0, 0, 0]
        );
    }

    #[test]
    fn new_client_is_the_pid_that_was_not_there_before() {
        let before: HashSet<u32> = [10, 20].into_iter().collect();
        assert_eq!(new_client_pid(&before, &[10, 20]), None);
        assert_eq!(new_client_pid(&before, &[10, 30, 20]), Some(30));
        // один клиент закрылся, другой открылся: число то же, но новый клиент найден
        assert_eq!(new_client_pid(&before, &[20, 40]), Some(40));
        assert_eq!(new_client_pid(&HashSet::new(), &[]), None);
    }

    #[test]
    fn only_visible_titled_windows_of_the_client_are_decorated() {
        let w = |pid, title: &str, visible| win::WinInfo {
            hwnd: 1,
            pid,
            class: String::new(),
            title: title.to_string(),
            visible,
        };
        assert!(is_client_window(&w(7, "完美世界国际版", true), 7));
        assert!(!is_client_window(&w(8, "完美世界国际版", true), 7)); // чужой процесс
        assert!(!is_client_window(&w(7, "", true), 7)); // служебное окно без заголовка
        assert!(!is_client_window(&w(7, "IME", false), 7)); // невидимое
    }

    fn client_window(hwnd: usize, pid: u32, title: &str) -> win::WinInfo {
        win::WinInfo {
            hwnd,
            pid,
            class: "ElementClient Window".to_string(),
            title: title.to_string(),
            visible: true,
        }
    }

    #[test]
    fn game_window_gets_title_and_icons() {
        let mut progress = DecorateProgress::default();
        let windows = [
            client_window(1, 100, "Perfect World"),
            client_window(2, 200, "Чужое окно"),
        ];
        let mut titled: Vec<(usize, String)> = Vec::new();
        let mut iconed: Vec<usize> = Vec::new();
        let denied = decorate_step(
            &mut progress,
            &windows,
            100,
            "Ник — Класс",
            &mut |h, t| {
                titled.push((h, t.to_string()));
                Ok(())
            },
            &mut |h| {
                iconed.push(h);
                Ok(())
            },
        );
        assert_eq!(denied, None);
        assert_eq!(titled, vec![(1, "Ник — Класс".to_string())]); // чужое окно не тронуто
        assert_eq!(iconed, vec![1]);
        assert!(progress.seen && !progress.verified); // совпадение видно только на следующем проходе
    }

    #[test]
    fn title_is_verified_and_reapplied_after_the_game_rewrites_it() {
        let mut progress = DecorateProgress::default();
        let mut titles = 0;
        let mut icons = 0;
        let mut step = |p: &mut DecorateProgress, title: &str| {
            decorate_step(
                p,
                &[client_window(1, 100, title)],
                100,
                "Ник — Класс",
                &mut |_, _| {
                    titles += 1;
                    Ok(())
                },
                &mut |_| {
                    icons += 1;
                    Ok(())
                },
            )
        };
        step(&mut progress, "Perfect World"); // первая подпись
        step(&mut progress, "Ник — Класс"); // заголовок совпал: ничего не делаем
        assert!(progress.verified);
        step(&mut progress, "Perfect World"); // игра переписала заголовок: ставим снова, значок тоже
        assert_eq!((titles, icons), (2, 2));
    }

    #[test]
    fn access_denied_stops_decoration_and_names_the_reason() {
        let mut progress = DecorateProgress::default();
        let denied = decorate_step(
            &mut progress,
            &[client_window(1, 100, "Perfect World")],
            100,
            "Ник — Класс",
            &mut |_, _| Err(ERROR_ACCESS_DENIED),
            &mut |_| Ok(()),
        );
        assert_eq!(denied, Some(ERROR_ACCESS_DENIED));
        assert_eq!(progress.last_error, ERROR_ACCESS_DENIED);
    }

    #[test]
    fn other_errors_are_remembered_but_do_not_stop() {
        let mut progress = DecorateProgress::default();
        let denied = decorate_step(
            &mut progress,
            &[client_window(1, 100, "Perfect World")],
            100,
            "Ник — Класс",
            &mut |_, _| Err(1460),
            &mut |_| Ok(()),
        );
        assert_eq!(denied, None);
        assert_eq!(progress.last_error, 1460);
    }

    #[test]
    fn decorate_event_is_sent_to_the_interface_in_camel_case() {
        let json = serde_json::to_string(&DecorateEvent {
            pid: 7,
            title: "Ник".to_string(),
            status: Decorated::Denied,
            code: 5,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"pid":7,"title":"Ник","status":"denied","code":5}"#
        );
    }

    #[test]
    fn gamecenter_close_report_is_parsed() {
        assert_eq!(
            parse_gc_closed("2 1\r\n"),
            GcClosed {
                others: 2,
                failed: 1
            }
        );
        assert_eq!(parse_gc_closed("0 0"), GcClosed::default());
        assert_eq!(parse_gc_closed(""), GcClosed::default());
        assert_eq!(parse_gc_closed("мусор"), GcClosed::default());
    }

    #[test]
    fn picker_output_is_a_single_path() {
        assert_eq!(parse_picker_output(""), None);
        assert_eq!(parse_picker_output("\r\n"), None);
        assert_eq!(
            parse_picker_output("\u{feff}D:\\GC 2\\GameCenter.exe\r\n").as_deref(),
            Some("D:\\GC 2\\GameCenter.exe")
        );
    }

    #[test]
    fn parses_tasklist_output() {
        let out = "\"elementclient_64.exe\",\"22368\",\"Console\",\"1\",\"500 000 K\"\r\n\
                   \"elementclient.exe\",\"1204\",\"Console\",\"1\",\"480 000 K\"\r\n";
        assert_eq!(
            parse_processes(out),
            vec![
                ("elementclient_64.exe".to_string(), 22368),
                ("elementclient.exe".to_string(), 1204)
            ]
        );
        assert!(parse_processes("INFO: No tasks are running.\r\n").is_empty());
        assert!(parse_processes("").is_empty());
    }

    #[test]
    fn rejects_foreign_programs() {
        assert!(resolve_gamecenter_exe("").is_err());
        assert!(resolve_gamecenter_exe("C:\\Windows\\notepad.exe").is_err());
    }

    #[test]
    fn resolves_folder_and_file() {
        let dir = std::env::temp_dir().join(format!("tf-gc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(GAMECENTER_EXE);
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(resolve_gamecenter_exe(dir.to_str().unwrap()).unwrap(), exe);
        assert_eq!(resolve_gamecenter_exe(exe.to_str().unwrap()).unwrap(), exe);
        let quoted = format!("\"{}\"", exe.display());
        assert_eq!(resolve_gamecenter_exe(&quoted).unwrap(), exe);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn answers_only_the_question_window() {
        // «Клиент игры уже запущен»: заголовок «VK Play Игровой центр»
        assert!(is_gc_dialog("TYesNoForm", "VK Play Игровой центр", true));
        assert!(is_gc_dialog(
            "GameCenter.TYesNoForm",
            "VK Play Игровой центр",
            true
        ));
        // «Попытка авторизации…» с кнопкой «Прервать» — Enter туда не отправляем
        assert!(!is_gc_dialog("TYesNoForm", "Попытка авторизации...", true));
        assert!(!is_gc_dialog(
            "TYesNoForm",
            "VK Play: попытка авторизации",
            true
        ));
        assert!(!is_gc_dialog("TYesNoForm", "VK Play Игровой центр", false)); // скрытое окно
        assert!(!is_gc_dialog("TMainForm", "VK Play Игровой центр", true));
        assert!(!is_gc_dialog("TYesNoForm", "", true));
    }

    const INI: &str = "[UMS]\r\ngamecenter4=1916\r\n\r\n[Main]\r\nLang=ru\r\nCurrentUserNick=Dred\r\nMyComUserMagic2=OLDTOKEN\r\nForm_State=0\r\n\r\n[Chrome]\r\nCacheVersion=2\r\n";

    #[test]
    fn reads_account_keys() {
        assert_eq!(ini_get(INI, KEY_NICK).as_deref(), Some("Dred"));
        assert_eq!(ini_get(INI, "mycomusermagic2").as_deref(), Some("OLDTOKEN"));
        assert_eq!(ini_get(INI, "Nope"), None);
    }

    #[test]
    fn replaces_keys_and_keeps_everything_else() {
        let out = ini_set(&ini_set(INI, KEY_MAGIC, "NEWTOKEN"), KEY_NICK, "Twin");
        assert_eq!(ini_get(&out, KEY_MAGIC).as_deref(), Some("NEWTOKEN"));
        assert_eq!(ini_get(&out, KEY_NICK).as_deref(), Some("Twin"));
        let expected = INI
            .replace("OLDTOKEN", "NEWTOKEN")
            .replace("CurrentUserNick=Dred", "CurrentUserNick=Twin");
        assert_eq!(out, expected); // остальные строки и CRLF не изменились
    }

    #[test]
    fn inserts_missing_key_after_main_section() {
        let ini = "[Main]\nLang=ru\n[Chrome]\nCacheVersion=2\n";
        let out = ini_set(ini, KEY_MAGIC, "T1");
        assert_eq!(
            out,
            "[Main]\nMyComUserMagic2=T1\nLang=ru\n[Chrome]\nCacheVersion=2\n"
        );
        assert_eq!(ini_set("A=1", KEY_MAGIC, "T1"), "A=1\nMyComUserMagic2=T1\n");
    }

    #[test]
    fn ini_bytes_survive_roundtrip() {
        // cp1251: «Дред» — байты C4 F0 E5 E4; файл не должен измениться вне правки
        let mut raw = b"[Main]\r\nCurrentUserName=".to_vec();
        raw.extend_from_slice(&[0xC4, 0xF0, 0xE5, 0xE4]);
        raw.extend_from_slice(b"\r\nMyComUserMagic2=OLD\r\n");
        let (text, enc) = decode_ini(&raw);
        let out = encode_ini(&ini_set(&text, KEY_MAGIC, "NEW"), &enc);
        let mut expected = b"[Main]\r\nCurrentUserName=".to_vec();
        expected.extend_from_slice(&[0xC4, 0xF0, 0xE5, 0xE4]);
        expected.extend_from_slice(b"\r\nMyComUserMagic2=NEW\r\n");
        assert_eq!(out, expected);
        assert_eq!(
            display_value(&ini_get(&text, "CurrentUserName").unwrap()),
            "Дред"
        );
    }

    #[test]
    fn utf16_ini_roundtrip() {
        let text = "[Main]\r\nCurrentUserNick=Дред\r\nMyComUserMagic2=OLD\r\n";
        let raw = encode_ini(text, &IniEncoding::Utf16Le);
        assert_eq!(&raw[..2], &[0xFF, 0xFE]);
        let (decoded, enc) = decode_ini(&raw);
        assert_eq!(decoded, text);
        assert_eq!(ini_get(&decoded, KEY_NICK).as_deref(), Some("Дред"));
        assert_eq!(encode_ini(&decoded, &enc), raw);
    }

    #[test]
    fn utf8_nick_is_shown_correctly() {
        let raw: String = "Михаил".bytes().map(|b| b as char).collect();
        assert_eq!(display_value(&raw), "Михаил");
        assert_eq!(display_value("Dred"), "Dred");
    }

    #[test]
    fn only_plain_values_go_into_ini() {
        assert!(safe_ini_value("AbC123-_=/+."));
        assert!(!safe_ini_value(""));
        assert!(!safe_ini_value("a b"));
        assert!(!safe_ini_value("a\r\nb=c"));
        assert!(!safe_ini_value("токен"));
    }

    #[test]
    fn switch_account_rewrites_ini_next_to_exe() {
        let dir = std::env::temp_dir().join(format!("tf-gc-switch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(GAMECENTER_EXE);
        std::fs::write(&exe, b"").unwrap();
        std::fs::write(dir.join(INI_NAME), INI).unwrap();
        switch_account(&exe, Some("Twin"), "NEWTOKEN").unwrap();
        let after = std::fs::read_to_string(dir.join(INI_NAME)).unwrap();
        assert_eq!(ini_get(&after, KEY_MAGIC).as_deref(), Some("NEWTOKEN"));
        assert_eq!(ini_get(&after, KEY_NICK).as_deref(), Some("Twin"));
        // исходный файл сохранён рядом один раз
        let backup = std::fs::read_to_string(dir.join("GameCenter.ini.tvinoferma-backup")).unwrap();
        assert_eq!(backup, INI);
        switch_account(&exe, None, "OTHER").unwrap();
        let backup2 =
            std::fs::read_to_string(dir.join("GameCenter.ini.tvinoferma-backup")).unwrap();
        assert_eq!(backup2, INI); // повторная подмена копию не затирает
        assert!(switch_account(&exe, None, "bad value").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}

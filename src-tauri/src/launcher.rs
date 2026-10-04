//! Запуск игры: у каждого аккаунта свой GameCenter (VK Play) в своей папке.
//! Приложение запускает нужный `GameCenter.exe`; если клиент игры уже запущен, GameCenter
//! показывает окно «Клиент игры уже запущен» — в нём автоматически выбирается
//! «Запустить новую копию клиента» (по умолчанию в окне выбрана именно она, достаточно Enter).
//! После этого ждём, пока появится новый процесс клиента, и только тогда запуск считается завершённым.
//!
//! Безопасность: запускается только файл с именем `GameCenter.exe`, а ссылка запуска
//! должна начинаться с `vkplay://` и не содержать пробелов — произвольные программы отсюда не стартуют.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

const GAMECENTER_EXE: &str = "GameCenter.exe";
const CLIENT_EXE: &str = "elementclient_64.exe";
/// Perfect World в VK Play (id проекта 0.61)
const DEFAULT_URL: &str = "vkplay://play/0.61";
/// Класс окна вопроса GameCenter («Клиент игры уже запущен»)
const DIALOG_CLASS: &str = "TYesNoForm";
/// Сколько ждать это окно после старта GameCenter, если клиент уже был запущен
const DIALOG_WAIT: Duration = Duration::from_secs(30);
/// Сколько ждать новый клиент игры, секунд (если не задано в вызове)
const DEFAULT_CLIENT_WAIT_SECS: u64 = 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    pid: u32,
    /// Было ли окно «Клиент игры уже запущен» и мы в нём подтвердили запуск новой копии
    dialog_clicked: bool,
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
    }

    pub struct WinInfo {
        pub hwnd: usize,
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
        list.push(WinInfo {
            hwnd: hwnd as usize,
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
        pub class: String,
        pub title: String,
        pub visible: bool,
    }
    pub fn all_windows() -> Vec<WinInfo> {
        Vec::new()
    }
    pub fn press_enter(_hwnd: usize) {}
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

/// PID из вывода `tasklist /FO CSV /NH`: `"elementclient_64.exe","22368","Console",...`
fn parse_tasklist(out: &str) -> Vec<u32> {
    out.lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with('"') {
                return None; // «INFO: задачи не найдены» и пустые строки
            }
            line.trim_matches('"').split("\",\"").nth(1)?.parse().ok()
        })
        .collect()
}

/// PID всех запущенных клиентов игры.
fn client_pids() -> Result<Vec<u32>, String> {
    let filter = format!("IMAGENAME eq {}", CLIENT_EXE);
    let out = hidden(Command::new("tasklist").args(["/FI", filter.as_str(), "/FO", "CSV", "/NH"]))
        .output()
        .map_err(|e| e.to_string())?;
    Ok(parse_tasklist(&String::from_utf8_lossy(&out.stdout)))
}

/// Окно вопроса GameCenter: видимое, класс заканчивается на `TYesNoForm`.
fn is_gc_dialog(class: &str, visible: bool) -> bool {
    visible && class.ends_with(DIALOG_CLASS)
}

fn find_dialogs() -> Vec<usize> {
    win::all_windows()
        .into_iter()
        .filter(|w| is_gc_dialog(&w.class, w.visible))
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

/// Проверка пути из настроек: возвращает полный путь к `GameCenter.exe`.
#[tauri::command]
pub fn launcher_check_path(path: String) -> Result<String, String> {
    resolve_gamecenter_exe(&path).map(|p| p.display().to_string())
}

/// Запускает GameCenter из указанной папки со ссылкой запуска игры и дожидается нового клиента.
///
/// 1. Запоминает, сколько клиентов игры уже запущено.
/// 2. Стартует `GameCenter.exe <ссылка>`.
/// 3. Если клиенты уже были — ждёт окно «Клиент игры уже запущен» и выбирает «Запустить новую копию клиента».
///    Если не было — ничего не нажимает.
/// 4. Ждёт, пока число клиентов вырастет (до `wait_secs`, по умолчанию 60 с); иначе — ошибка.
#[tauri::command]
pub async fn launcher_start(
    path: String,
    url: Option<String>,
    wait_secs: Option<u64>,
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
        let before = client_pids()?.len();
        let child = Command::new(&exe)
            .current_dir(&dir)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("{}: {}", exe.display(), e))?;
        let pid = child.id();

        let dialog_clicked = before > 0 && confirm_new_client_dialog();

        let deadline = Instant::now() + wait;
        loop {
            if client_pids()?.len() > before {
                break;
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Клиент игры не запустился за {} с (GameCenter: {})",
                    wait.as_secs(),
                    exe.display()
                ));
            }
            sleep(Duration::from_millis(500));
        }
        Ok::<LaunchInfo, String>(LaunchInfo {
            pid,
            dialog_clicked,
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

/// Закрывает все клиенты игры. Возвращает, сколько было запущено.
#[tauri::command]
pub async fn launcher_close_clients() -> Result<u32, String> {
    let count = launcher_running_clients().await?.len() as u32;
    if count == 0 {
        return Ok(0);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = hidden(Command::new("taskkill").args(["/F", "/IM", CLIENT_EXE]))
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok::<u32, String>(count)
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
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
        .filter(|w| w.visible && (w.class.ends_with(DIALOG_CLASS) || w.title.contains("VK Play")))
        .map(|w| format!("{} | {} | {}", w.hwnd, w.class, w.title))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tasklist_output() {
        let out = "\"elementclient_64.exe\",\"22368\",\"Console\",\"1\",\"500 000 K\"\r\n\
                   \"elementclient_64.exe\",\"1204\",\"Console\",\"1\",\"480 000 K\"\r\n";
        assert_eq!(parse_tasklist(out), vec![22368, 1204]);
        assert!(parse_tasklist("INFO: No tasks are running.\r\n").is_empty());
        assert!(parse_tasklist("").is_empty());
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
    fn recognizes_gamecenter_question_window() {
        assert!(is_gc_dialog("TYesNoForm", true));
        assert!(is_gc_dialog("GameCenter.TYesNoForm", true));
        assert!(!is_gc_dialog("TYesNoForm", false)); // скрытое окно не трогаем
        assert!(!is_gc_dialog("TMainForm", true));
        assert!(!is_gc_dialog("", true));
    }
}

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
/// Класс окон-вопросов GameCenter
const DIALOG_CLASS: &str = "TYesNoForm";
/// Заголовок окна вопроса «Клиент игры уже запущен» («VK Play Игровой центр»)
const DIALOG_TITLE: &str = "VK Play";
/// Сколько ждать это окно после старта GameCenter, если клиент уже был запущен
const DIALOG_WAIT: Duration = Duration::from_secs(30);
/// Сколько ждать новый клиент игры, секунд (если не задано в вызове)
const DEFAULT_CLIENT_WAIT_SECS: u64 = 60;

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
        return Err(format!("Укажите папку GameCenter или файл {}", GAMECENTER_EXE));
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
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        (String::from_utf16_lossy(&units), IniEncoding::Utf16Le)
    } else {
        // Побайтово: любая однобайтная кодировка и UTF-8 возвращаются в файл без потерь
        (bytes.iter().map(|&b| b as char).collect(), IniEncoding::Bytes)
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
        k.trim().eq_ignore_ascii_case(key).then(|| v.trim().to_string())
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

/// Закрывает процессы GameCenter, запущенные именно из этого `GameCenter.exe`
/// (остальные установки GameCenter не трогаем). Запущенные клиенты игры продолжают работать.
fn close_gamecenter(exe: &Path) -> Result<(), String> {
    let script = "Get-CimInstance Win32_Process -Filter \"Name='GameCenter.exe'\" | \
                  Where-Object { $_.ExecutablePath -ieq $env:TF_GC_EXE } | \
                  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    let out = hidden(
        Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("TF_GC_EXE", plain_path(exe)),
    )
    .output()
    .map_err(|e| format!("powershell: {}", e))?;
    if out.status.success() {
        Ok(())
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
            .ok_or_else(|| "В этом GameCenter не выполнен вход: войдите в аккаунт и повторите".to_string())?;
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
/// 1. Если у персонажа (`char_id`) сохранён вход — закрывает этот GameCenter и подставляет вход в его ini.
/// 2. Запоминает, сколько клиентов игры уже запущено, и стартует `GameCenter.exe <ссылка>`.
/// 3. Если клиенты уже были — ждёт окно «Клиент игры уже запущен» и выбирает «Запустить новую копию клиента».
///    Если не было — ничего не нажимает.
/// 4. Ждёт, пока число клиентов вырастет (до `wait_secs`, по умолчанию 60 с); иначе — ошибка.
#[tauri::command]
pub async fn launcher_start(
    path: String,
    char_id: Option<String>,
    nick: Option<String>,
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
        let id = char_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let switched = match id.map(get_magic).transpose()?.flatten() {
            Some(magic) => {
                close_gamecenter(&exe)?;
                sleep(Duration::from_millis(1500));
                switch_account(&exe, nick.as_deref(), &magic)?;
                true
            }
            None => false,
        };

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
            switched,
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
    fn answers_only_the_question_window() {
        // «Клиент игры уже запущен»: заголовок «VK Play Игровой центр»
        assert!(is_gc_dialog("TYesNoForm", "VK Play Игровой центр", true));
        assert!(is_gc_dialog("GameCenter.TYesNoForm", "VK Play Игровой центр", true));
        // «Попытка авторизации…» с кнопкой «Прервать» — Enter туда не отправляем
        assert!(!is_gc_dialog("TYesNoForm", "Попытка авторизации...", true));
        assert!(!is_gc_dialog("TYesNoForm", "VK Play: попытка авторизации", true));
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
        assert_eq!(out, "[Main]\nMyComUserMagic2=T1\nLang=ru\n[Chrome]\nCacheVersion=2\n");
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
        assert_eq!(display_value(&ini_get(&text, "CurrentUserName").unwrap()), "Дред");
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
        let backup2 = std::fs::read_to_string(dir.join("GameCenter.ini.tvinoferma-backup")).unwrap();
        assert_eq!(backup2, INI); // повторная подмена копию не затирает
        assert!(switch_account(&exe, None, "bad value").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}

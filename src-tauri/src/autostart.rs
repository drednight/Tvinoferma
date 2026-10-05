//! Автозапуск вместе с Windows.
//!
//! Запись лежит в `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (права администратора не нужны).
//! Режим «в трее» хранится прямо в команде запуска (`--autostart --minimized`): окно прячется ещё до
//! того, как интерфейс успеет что-то прочитать, поэтому настройки приложения для этого не нужны.
//! Запись можно изменить и вручную («Диспетчер задач → Автозагрузка»): мы читаем её как есть.

use serde::Serialize;
use std::path::Path;

/// Имя значения в разделе `Run`
const VALUE_NAME: &str = "Tvinoferma";
/// Признак «запущено Windows при входе в систему»
const ARG_AUTOSTART: &str = "--autostart";
/// Признак «окно не показываем, приложение живёт в трее»
const ARG_MINIMIZED: &str = "--minimized";

/// Команда для записи в `Run`: путь в кавычках (в пути бывают пробелы) и признаки запуска.
fn build_command(exe: &str, minimized: bool) -> String {
    let mut cmd = format!("\"{}\" {}", exe, ARG_AUTOSTART);
    if minimized {
        cmd.push(' ');
        cmd.push_str(ARG_MINIMIZED);
    }
    cmd
}

/// Разбор команды из `Run`: путь к программе и режим «в трее». `None` — это не наша команда.
fn parse_command(cmd: &str) -> Option<(String, bool)> {
    let cmd = cmd.trim();
    let (path, rest) = match cmd.strip_prefix('"') {
        Some(tail) => {
            let end = tail.find('"')?;
            (&tail[..end], &tail[end + 1..])
        }
        None => {
            // без кавычек: путь до первого пробела перед «--» (пути с пробелами без кавычек не поддерживаются)
            let end = cmd.find(" --").unwrap_or(cmd.len());
            (&cmd[..end], &cmd[end..])
        }
    };
    if path.is_empty() {
        return None;
    }
    let minimized = rest.split_whitespace().any(|a| a == ARG_MINIMIZED);
    Some((path.to_string(), minimized))
}

/// Одинаковые ли пути (Windows не различает регистр и вид слэшей).
fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

/// Запущено ли приложение с `--minimized` (автозапуск «в трее»): главное окно сразу прячется.
pub fn started_minimized() -> bool {
    std::env::args().any(|a| a == ARG_MINIMIZED)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutostartInfo {
    /// Работает ли автозапуск на этой системе (только Windows)
    supported: bool,
    /// Есть ли запись в `Run`
    enabled: bool,
    /// Режим «в трее» (без окна)
    minimized: bool,
    /// Куда указывает запись (пусто, если записи нет)
    path: String,
    /// Запись ведёт на эту же копию программы
    current: bool,
    /// Файл из записи не существует (программу переустановили или перенесли): запись нужно обновить
    broken: bool,
}

fn info_from(value: Option<String>, exe: &str) -> AutostartInfo {
    let parsed = value.as_deref().and_then(parse_command);
    match parsed {
        Some((path, minimized)) => AutostartInfo {
            supported: true,
            enabled: true,
            minimized,
            current: same_path(&path, exe),
            broken: !Path::new(&path).exists(),
            path,
        },
        None => AutostartInfo {
            supported: true,
            enabled: false,
            minimized: true,
            path: String::new(),
            current: false,
            broken: false,
        },
    }
}

#[cfg(windows)]
mod reg {
    use std::ffi::c_void;

    type Hkey = *mut c_void;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(
            key: Hkey,
            sub_key: *const u16,
            options: u32,
            access: u32,
            result: *mut Hkey,
        ) -> i32;
        fn RegSetValueExW(
            key: Hkey,
            name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            len: u32,
        ) -> i32;
        fn RegQueryValueExW(
            key: Hkey,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            len: *mut u32,
        ) -> i32;
        fn RegDeleteValueW(key: Hkey, name: *const u16) -> i32;
        fn RegCloseKey(key: Hkey) -> i32;
    }

    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const REG_SZ: u32 = 1;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const SUB_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// `HKEY_CURRENT_USER` — предопределённый дескриптор 0x80000001.
    fn hkcu() -> Hkey {
        0x8000_0001u32 as i32 as isize as Hkey
    }

    fn open_run() -> Result<Hkey, String> {
        let mut key: Hkey = std::ptr::null_mut();
        let code = unsafe {
            RegOpenKeyExW(
                hkcu(),
                wide(SUB_KEY).as_ptr(),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                &mut key,
            )
        };
        if code == 0 {
            Ok(key)
        } else {
            Err(format!(
                "Не удалось открыть раздел автозагрузки (код {})",
                code
            ))
        }
    }

    pub fn get(name: &str) -> Option<String> {
        let key = open_run().ok()?;
        let name = wide(name);
        let mut len: u32 = 0;
        let mut kind: u32 = 0;
        let mut value = None;
        unsafe {
            let probe = RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                std::ptr::null_mut(),
                &mut len,
            );
            if probe == 0 && kind == REG_SZ && len >= 2 {
                let mut buf = vec![0u16; (len as usize).div_ceil(2)];
                let code = RegQueryValueExW(
                    key,
                    name.as_ptr(),
                    std::ptr::null_mut(),
                    &mut kind,
                    buf.as_mut_ptr() as *mut u8,
                    &mut len,
                );
                if code == 0 {
                    let chars = (len as usize / 2).min(buf.len());
                    let text = String::from_utf16_lossy(&buf[..chars]);
                    value = Some(text.trim_end_matches('\0').to_string());
                }
            }
            RegCloseKey(key);
        }
        value
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        let key = open_run()?;
        let data = wide(value);
        let code = unsafe {
            let c = RegSetValueExW(
                key,
                wide(name).as_ptr(),
                0,
                REG_SZ,
                data.as_ptr() as *const u8,
                (data.len() * 2) as u32,
            );
            RegCloseKey(key);
            c
        };
        if code == 0 {
            Ok(())
        } else {
            Err(format!("Не удалось записать автозапуск (код {})", code))
        }
    }

    pub fn remove(name: &str) -> Result<(), String> {
        let key = open_run()?;
        let code = unsafe {
            let c = RegDeleteValueW(key, wide(name).as_ptr());
            RegCloseKey(key);
            c
        };
        if code == 0 || code == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("Не удалось убрать автозапуск (код {})", code))
        }
    }
}

#[cfg(not(windows))]
mod reg {
    pub fn get(_name: &str) -> Option<String> {
        None
    }
    pub fn set(_name: &str, _value: &str) -> Result<(), String> {
        Err("Автозапуск поддерживается только в Windows".to_string())
    }
    pub fn remove(_name: &str) -> Result<(), String> {
        Ok(())
    }
}

fn current_exe() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("Не удалось определить путь к программе: {}", e))
}

fn read_info() -> Result<AutostartInfo, String> {
    let exe = current_exe()?;
    let mut info = info_from(reg::get(VALUE_NAME), &exe);
    info.supported = cfg!(windows);
    Ok(info)
}

/// Состояние автозапуска: включён ли, в каком режиме и на какую копию программы указывает.
#[tauri::command]
pub fn autostart_status() -> Result<AutostartInfo, String> {
    read_info()
}

/// Включает или выключает автозапуск. `minimized` — запускать сразу в трей, без окна.
#[tauri::command]
pub fn autostart_set(enabled: bool, minimized: bool) -> Result<AutostartInfo, String> {
    if enabled {
        reg::set(VALUE_NAME, &build_command(&current_exe()?, minimized))?;
    } else {
        reg::remove(VALUE_NAME)?;
    }
    read_info()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_quotes_the_path_and_adds_flags() {
        assert_eq!(
            build_command(r"C:\Program Files\Tvinoferma\tvinoferma.exe", true),
            r#""C:\Program Files\Tvinoferma\tvinoferma.exe" --autostart --minimized"#
        );
        assert_eq!(
            build_command(r"C:\T\t.exe", false),
            r#""C:\T\t.exe" --autostart"#
        );
    }

    #[test]
    fn command_survives_a_roundtrip() {
        for minimized in [true, false] {
            let cmd = build_command(r"C:\Users\Иван\AppData\Local\Тест\t.exe", minimized);
            assert_eq!(
                parse_command(&cmd),
                Some((
                    r"C:\Users\Иван\AppData\Local\Тест\t.exe".to_string(),
                    minimized
                ))
            );
        }
    }

    #[test]
    fn foreign_commands_are_read_too() {
        assert_eq!(
            parse_command(r"C:\T\t.exe --minimized"),
            Some((r"C:\T\t.exe".to_string(), true))
        );
        assert_eq!(
            parse_command(r"C:\T\t.exe"),
            Some((r"C:\T\t.exe".to_string(), false))
        );
        assert_eq!(parse_command("   "), None);
        assert_eq!(parse_command(r#""" --minimized"#), None);
        assert_eq!(parse_command(r#""C:\broken"#), None);
    }

    #[test]
    fn paths_are_compared_like_windows_does() {
        assert!(same_path(r"C:\Tvinoferma\App.exe", "c:/tvinoferma/app.EXE"));
        assert!(!same_path(r"C:\A\app.exe", r"C:\B\app.exe"));
    }

    #[test]
    fn no_entry_means_disabled_with_tray_mode_as_default() {
        let info = info_from(None, r"C:\T\t.exe");
        assert!(!info.enabled && info.minimized && !info.broken && !info.current);
    }

    #[test]
    fn entry_for_a_missing_file_is_marked_broken() {
        let info = info_from(
            Some(build_command(r"Z:\нет\такого\t.exe", false)),
            r"C:\T\t.exe",
        );
        assert!(info.enabled && info.broken && !info.current && !info.minimized);
    }

    #[test]
    fn entry_for_this_program_is_current() {
        let exe = std::env::current_exe().unwrap().display().to_string();
        let info = info_from(Some(build_command(&exe, true)), &exe);
        assert!(info.enabled && info.current && !info.broken && info.minimized);
    }
}

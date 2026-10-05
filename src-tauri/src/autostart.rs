//! Автозапуск вместе с Windows.
//!
//! Обычный режим: запись в `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (права администратора не нужны).
//! Режим «от администратора»: задание Планировщика («при входе в систему», наивысшие права). Run-запись для этого не годится:
//! Windows не запускает из неё программы, которым нужен запрос UAC. Задание создаётся один раз (Windows спросит разрешение),
//! дальше при входе в систему Твиноферма стартует с правами администратора без вопросов.
//! Режим «в трее» хранится прямо в команде запуска (`--autostart --minimized`): окно прячется ещё до
//! того, как интерфейс успеет что-то прочитать, поэтому настройки приложения для этого не нужны.
//! Запись можно изменить и вручную («Диспетчер задач → Автозагрузка»): мы читаем её как есть.

use crate::launcher::{hidden, self_elevated};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// Имя значения в разделе `Run`
const VALUE_NAME: &str = "Tvinoferma";
/// Признак «запущено Windows при входе в систему»
const ARG_AUTOSTART: &str = "--autostart";
/// Признак «окно не показываем, приложение живёт в трее»
const ARG_MINIMIZED: &str = "--minimized";
/// Имя задания в Планировщике (латиницей: имя попадает в командную строку)
const TASK_NAME: &str = "Tvinoferma autostart";
/// Код «запрос прав администратора отменён» (так PowerShell сообщает об отказе в UAC)
const EXIT_UAC_CANCELLED: i32 = 1223;

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
    /// Автозапуск идёт через Планировщик с правами администратора
    admin: bool,
    /// Сама Твиноферма сейчас запущена от администратора
    self_elevated: bool,
}

/// Состояние по записи `Run` и заданию Планировщика (задание важнее: оно запускает программу с правами администратора).
fn info_from(run: Option<String>, task: Option<(String, bool)>, exe: &str) -> AutostartInfo {
    let admin = task.is_some();
    let parsed = task.or_else(|| run.as_deref().and_then(parse_command));
    match parsed {
        Some((path, minimized)) => AutostartInfo {
            supported: true,
            enabled: true,
            minimized,
            current: same_path(&path, exe),
            broken: !Path::new(&path).exists(),
            path,
            admin,
            self_elevated: false,
        },
        None => AutostartInfo {
            supported: true,
            enabled: false,
            minimized: true,
            path: String::new(),
            current: false,
            broken: false,
            admin: false,
            self_elevated: false,
        },
    }
}

// ---------------------------------------------------------------------------
// Задание Планировщика (запуск от администратора)
// ---------------------------------------------------------------------------

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// XML задания: при входе этого пользователя, наивысшие права, без ограничений по питанию и времени работы
/// (по умолчанию Планировщик не запускает задания на батарее и через 3 дня их убивает).
fn task_xml(exe: &str, minimized: bool, user: &str) -> String {
    let args = if minimized {
        format!("{} {}", ARG_AUTOSTART, ARG_MINIMIZED)
    } else {
        ARG_AUTOSTART.to_string()
    };
    // папка программы (без Path::parent: разбор по слэшам одинаков на любой системе)
    let dir = exe.rsplit_once(['\\', '/']).map_or("", |(d, _)| d);
    let user = xml_escape(user);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Запуск Твинофермы при входе в Windows (с правами администратора)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
      <Delay>PT10S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{args}</Arguments>
      <WorkingDirectory>{dir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"#,
        user = user,
        command = xml_escape(exe),
        args = args,
        dir = xml_escape(dir),
    )
}

/// Текст в UTF-16 LE с BOM: в таком виде Планировщик читает XML заданий без сюрпризов с кодировкой.
fn utf16le_with_bom(text: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

/// Разбор вывода запроса задания: «команда<TAB>аргументы» → путь и режим «в трее». Пустой вывод — задания нет.
fn parse_task_output(out: &str) -> Option<(String, bool)> {
    let line = out.lines().map(str::trim).find(|l| !l.is_empty())?;
    let (command, args) = line.split_once('\t').unwrap_or((line, ""));
    let path = command.trim().trim_matches('"').to_string();
    if path.is_empty() {
        return None;
    }
    Some((path, args.split_whitespace().any(|a| a == ARG_MINIMIZED)))
}

/// Что сказать пользователю по коду завершения запроса прав администратора.
fn elevation_error(code: Option<i32>, what: &str) -> String {
    match code {
        Some(EXIT_UAC_CANCELLED) => {
            "Запрос прав администратора отменён — автозапуск от администратора не изменён"
                .to_string()
        }
        Some(c) => format!("{} (код {}). Попробуйте ещё раз", what, c),
        None => format!("{}: команда не завершилась", what),
    }
}

/// Запускает `schtasks` с правами администратора: сразу, если мы уже администратор, иначе через запрос UAC.
fn run_schtasks(args: &[&str]) -> Result<(), String> {
    let quoted: Vec<String> = args.iter().map(|a| format!("\"{}\"", a)).collect();
    let status = if self_elevated() {
        hidden(Command::new("schtasks").args(args)).status()
    } else {
        let script = "try { $p = Start-Process -FilePath 'schtasks.exe' -ArgumentList $env:TF_SCHTASKS_ARGS \
                      -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } catch { exit 1223 }";
        hidden(
            Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("TF_SCHTASKS_ARGS", quoted.join(" ")),
        )
        .status()
    }
    .map_err(|e| format!("Не удалось запустить команду: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err(elevation_error(
            status.code(),
            "Планировщик заданий отказал",
        ))
    }
}

/// Читает задание из Планировщика (для чтения права администратора не нужны). `None` — задания нет или не прочиталось.
fn task_read() -> Option<(String, bool)> {
    let script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
                  $t = Get-ScheduledTask -TaskName $env:TF_TASK_NAME -ErrorAction SilentlyContinue; \
                  if ($t) { $a = $t.Actions | Select-Object -First 1; [Console]::Out.Write($a.Execute + \"`t\" + $a.Arguments) }";
    let out = hidden(
        Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("TF_TASK_NAME", TASK_NAME),
    )
    .output()
    .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_task_output(&String::from_utf8_lossy(&out.stdout))
}

fn task_create(exe: &str, minimized: bool) -> Result<(), String> {
    let user = format!(
        "{}\\{}",
        std::env::var("USERDOMAIN").unwrap_or_default(),
        std::env::var("USERNAME").unwrap_or_default()
    );
    let user = user.trim_matches('\\').to_string();
    let file = std::env::temp_dir().join("tvinoferma-autostart-task.xml");
    std::fs::write(&file, utf16le_with_bom(&task_xml(exe, minimized, &user)))
        .map_err(|e| format!("Не удалось подготовить задание: {}", e))?;
    let res = run_schtasks(&[
        "/Create",
        "/TN",
        TASK_NAME,
        "/XML",
        &file.display().to_string(),
        "/F",
    ]);
    let _ = std::fs::remove_file(&file);
    res
}

fn task_delete() -> Result<(), String> {
    run_schtasks(&["/Delete", "/TN", TASK_NAME, "/F"])
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
    let mut info = info_from(reg::get(VALUE_NAME), task_read(), &exe);
    info.supported = cfg!(windows);
    info.self_elevated = self_elevated();
    Ok(info)
}

/// Состояние автозапуска: включён ли, в каком режиме и на какую копию программы указывает.
#[tauri::command]
pub async fn autostart_status() -> Result<AutostartInfo, String> {
    tauri::async_runtime::spawn_blocking(read_info)
        .await
        .map_err(|e| e.to_string())?
}

fn apply(enabled: bool, minimized: bool, admin: bool) -> Result<AutostartInfo, String> {
    let has_task = task_read().is_some();
    if enabled && admin {
        // создаём задание (Windows спросит разрешение), и только потом убираем обычную запись, чтобы не стартовало дважды
        task_create(&current_exe()?, minimized)?;
        reg::remove(VALUE_NAME)?;
    } else if enabled {
        if has_task {
            task_delete()?;
        }
        reg::set(VALUE_NAME, &build_command(&current_exe()?, minimized))?;
    } else {
        reg::remove(VALUE_NAME)?;
        if has_task {
            task_delete()?;
        }
    }
    read_info()
}

/// Включает или выключает автозапуск. `minimized` — запускать сразу в трей, без окна;
/// `admin` — запускать от администратора (через Планировщик заданий; при первом включении Windows спросит разрешение).
#[tauri::command]
pub async fn autostart_set(
    enabled: bool,
    minimized: bool,
    admin: bool,
) -> Result<AutostartInfo, String> {
    tauri::async_runtime::spawn_blocking(move || apply(enabled, minimized, admin))
        .await
        .map_err(|e| e.to_string())?
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
        let info = info_from(None, None, r"C:\T\t.exe");
        assert!(!info.enabled && info.minimized && !info.broken && !info.current);
    }

    #[test]
    fn entry_for_a_missing_file_is_marked_broken() {
        let info = info_from(
            Some(build_command(r"Z:\нет\такого\t.exe", false)),
            None,
            r"C:\T\t.exe",
        );
        assert!(info.enabled && info.broken && !info.current && !info.minimized);
    }

    #[test]
    fn entry_for_this_program_is_current() {
        let exe = std::env::current_exe().unwrap().display().to_string();
        let info = info_from(Some(build_command(&exe, true)), None, &exe);
        assert!(info.enabled && info.current && !info.broken && info.minimized);
    }

    #[test]
    fn scheduler_task_wins_over_run_entry_and_means_admin() {
        let info = info_from(
            Some(build_command(r"C:\Run\t.exe", false)),
            Some((r"Z:\Task\t.exe".to_string(), true)),
            r"Z:\Task\t.exe",
        );
        assert!(info.enabled && info.admin && info.minimized && info.current);
        assert_eq!(info.path, r"Z:\Task\t.exe");
    }

    #[test]
    fn task_xml_runs_with_highest_rights_at_logon_without_limits() {
        let xml = task_xml(r"C:\Program Files\Tvinoferma\t&t.exe", true, r"PC\Иван");
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains("<UserId>PC\\Иван</UserId>"));
        assert!(xml.contains("<Command>C:\\Program Files\\Tvinoferma\\t&amp;t.exe</Command>"));
        assert!(xml.contains("<Arguments>--autostart --minimized</Arguments>"));
        assert!(xml.contains("<WorkingDirectory>C:\\Program Files\\Tvinoferma</WorkingDirectory>"));
        assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(task_xml(r"C:\T\t.exe", false, "u").contains("<Arguments>--autostart</Arguments>"));
    }

    #[test]
    fn task_file_is_utf16_with_bom() {
        let bytes = utf16le_with_bom("Aя");
        assert_eq!(bytes, vec![0xFF, 0xFE, 0x41, 0x00, 0x4F, 0x04]);
    }

    #[test]
    fn task_query_output_is_parsed() {
        assert_eq!(
            parse_task_output("C:\\T\\t.exe\t--autostart --minimized"),
            Some((r"C:\T\t.exe".to_string(), true))
        );
        assert_eq!(
            parse_task_output("\"C:\\T\\t.exe\"\t--autostart\r\n"),
            Some((r"C:\T\t.exe".to_string(), false))
        );
        assert_eq!(parse_task_output(""), None);
        assert_eq!(parse_task_output("  \n"), None);
    }

    #[test]
    fn cancelled_uac_is_explained() {
        assert!(elevation_error(Some(EXIT_UAC_CANCELLED), "x").contains("отменён"));
        assert!(elevation_error(Some(1), "Отказ").contains("код 1"));
        assert!(elevation_error(None, "Отказ").contains("не завершилась"));
    }
}

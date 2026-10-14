//! Astrum Play: запуск аккаунта через свой лаунчер (`AstrumPlay.exe`).
//!
//! Чем отличается от GameCenter:
//! - вход лежит в `AstrumPlay.ini` (UTF-16 LE); ключи аккаунта — те же, что у GameCenter
//!   (`ACCOUNT_KEYS` родительского модуля), и подставлять их нужно все: лаунчер опознаёт
//!   аккаунт по `MyComUserUid`, поэтому одной замены токена мало;
//! - Astrum сам перезапускается, если его ini изменили при работе, поэтому ini пишется только при закрытом Astrum;
//! - окно вопроса «Клиент игры уже запущен» называется «Astrum Play Launcher»; Enter выбирает
//!   основную кнопку «Запустить новую копию клиента» (проверено на живом окне).
//!
//! Общие части (окна, процессы, разбор ini, подпись окон) берутся из родительского модуля `launcher`.

use super::{
    clean_title, client_pids, decode_ini, display_value, get_magic, ini_get, new_client_pid,
    pairs_to_text, read_account, stored_account, watch_client, win, write_account, GcInfo,
    LaunchInfo, CLIENT_POLL_STEP, LOGIN_KEY,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// Имя исполняемого файла Astrum Play
pub(super) const ASTRUM_EXE: &str = "AstrumPlay.exe";
/// Ссылка запуска Perfect World в Astrum Play (подтверждено логом: `AstrumPlay.exe "astrumplay://play/0.61"`)
pub(super) const ASTRUM_DEFAULT_URL: &str = "astrumplay://play/0.61";
const ASTRUM_INI: &str = "AstrumPlay.ini";
/// Заголовок окна вопроса «Клиент игры уже запущен». Как и у GameCenter, решает не полный
/// заголовок, а его часть плюс класс окна: у VK Play проверялось «VK Play» в заголовке
/// `TYesNoForm`. У Astrum тот же движок, а полный заголовок в разных сборках звучит
/// по-разному («Astrum Play Launcher», «VK Play Astrum Play Launcher»), поэтому режем по бренду.
const ASTRUM_DIALOG_TITLE: &str = "Astrum Play";
/// Сколько ждать, пока закрытый Astrum освободит файлы и единственный экземпляр
const ASTRUM_EXIT_WAIT: Duration = Duration::from_secs(5);
/// Сколько пытаться нажимать Enter в окне вопроса (после запуска, если клиент уже был открыт)
const ASTRUM_DIALOG_WAIT: Duration = Duration::from_secs(30);
/// Как часто повторять Enter в окно вопроса
const ASTRUM_DIALOG_GAP: Duration = Duration::from_millis(700);

/// Путь к `AstrumPlay.exe`: папка или файл. Другие программы не принимаются.
pub(super) fn resolve_exe(input: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input.trim().trim_matches('"'));
    let exe = if path.is_dir() {
        path.join(ASTRUM_EXE)
    } else {
        path
    };
    let name_ok = exe
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(ASTRUM_EXE));
    if !name_ok {
        return Err(format!(
            "Укажите папку Astrum Play или файл {}",
            ASTRUM_EXE
        ));
    }
    if !exe.is_file() {
        return Err(format!("Файл не найден: {}", exe.display()));
    }
    Ok(exe)
}

/// Ссылка запуска допустима: только схема `astrumplay://` и без пробелов.
fn url_ok(url: &str) -> bool {
    url.starts_with("astrumplay://") && !url.chars().any(char::is_whitespace)
}

fn ini_path(exe: &Path) -> Result<PathBuf, String> {
    exe.parent()
        .map(|dir| dir.join(ASTRUM_INI))
        .ok_or_else(|| "Не удалось определить папку Astrum Play".to_string())
}

/// Запоминает вход, открытый сейчас в Astrum: все ключи аккаунта — в хранилище ОС. Возвращает ник для показа.
pub(super) fn capture(char_id: &str, path: &str) -> Result<String, String> {
    let exe = resolve_exe(path)?;
    let ini = ini_path(&exe)?;
    let bytes = std::fs::read(&ini).map_err(|e| format!("{}: {}", ini.display(), e))?;
    let (text, _) = decode_ini(&bytes);
    let pairs = read_account(&text).ok_or_else(|| {
        "В Astrum Play не выполнен вход: войдите в аккаунт и повторите".to_string()
    })?;
    if pairs.is_empty() {
        return Err("В Astrum Play не выполнен вход: войдите в аккаунт и повторите".to_string());
    }
    let nick = ini_get(&text, "CurrentUserNick")
        .map(|v| display_value(&v))
        .unwrap_or_default();
    super::magic_entry(char_id)?
        .set_password(&pairs_to_text(&pairs))
        .map_err(|e| e.to_string())?;
    Ok(nick)
}

/// Какой аккаунт открыт в Astrum (ник и есть ли вход). Для окна «GameCenter и персонажи».
pub(super) fn info(exe: &Path) -> Result<GcInfo, String> {
    let ini = ini_path(exe)?;
    let bytes = std::fs::read(&ini).map_err(|e| format!("{}: {}", ini.display(), e))?;
    let (text, _) = decode_ini(&bytes);
    let logged_in = ini_get(&text, LOGIN_KEY).is_some_and(|m| !m.is_empty());
    let nick = ini_get(&text, "CurrentUserNick")
        .map(|v| display_value(&v))
        .unwrap_or_default();
    Ok(GcInfo {
        exe: exe.display().to_string(),
        nick,
        logged_in,
    })
}

/// Все запущенные Astrum Play.
fn astrum_pids() -> Vec<u32> {
    win::all_processes()
        .into_iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case(ASTRUM_EXE))
        .map(|(_, pid)| pid)
        .collect()
}

/// Закрывает все Astrum Play: без этого ini не записать, а при правке работающий Astrum перезапускается.
/// Возвращает, сколько закрыть не удалось.
fn close_astrum() -> u32 {
    let mut failed = 0;
    for pid in astrum_pids() {
        match win::kill_process(pid) {
            Ok(()) | Err(87) => {} // 87 — процесс уже завершился
            Err(_) => failed += 1,
        }
    }
    failed
}

/// Ждёт выхода закрытого Astrum и возвращает оставшихся: пока жив хоть один, новый экземпляр
/// не откроет игру, а передаст ссылку старому — и окно выйдет под чужим аккаунтом.
fn wait_astrum_gone() -> Vec<u32> {
    let deadline = Instant::now() + ASTRUM_EXIT_WAIT;
    loop {
        let alive = astrum_pids();
        if alive.is_empty() || Instant::now() >= deadline {
            return alive;
        }
        sleep(Duration::from_millis(100));
    }
}

/// Окно вопроса Astrum «Клиент игры уже запущен»: видимое, класс `TYesNoForm`, в заголовке есть
/// «Astrum Play». Окно «Попытка авторизации…» сюда не входит: Enter в нём прервал бы вход
/// (у GameCenter то же исключение стоит, см. `is_gc_dialog`).
fn is_launcher_dialog(class: &str, title: &str, visible: bool) -> bool {
    visible
        && class.ends_with(super::DIALOG_CLASS)
        && title.contains(ASTRUM_DIALOG_TITLE)
        && !title.to_lowercase().contains("авториз")
}

/// Окна вопроса всех запущенных Astrum Play.
fn find_dialogs() -> Vec<usize> {
    let pids = astrum_pids();
    if pids.is_empty() {
        return Vec::new();
    }
    win::windows_of(&pids)
        .into_iter()
        .filter(|w| is_launcher_dialog(&w.class, &w.title, w.visible))
        .map(|w| w.hwnd)
        .collect()
}

/// Дожидается нового клиента игры. Окно вопроса подтверждаем Enter, пока клиент не появился.
/// Возвращает `(pid клиента, нажали ли Enter)`.
fn await_client(before: &HashSet<u32>, wait: Duration) -> Option<(u32, bool)> {
    let expect_dialog = !before.is_empty();
    let dialog_deadline = Instant::now() + ASTRUM_DIALOG_WAIT;
    let client_deadline = Instant::now() + wait;
    let mut clicked = false;
    let mut last_press: Option<Instant> = None;
    loop {
        let due = last_press.is_none_or(|t| t.elapsed() >= ASTRUM_DIALOG_GAP);
        if expect_dialog && due && Instant::now() < dialog_deadline {
            let dialogs = find_dialogs();
            if !dialogs.is_empty() {
                clicked = true;
                last_press = Some(Instant::now());
                for hwnd in dialogs {
                    win::press_enter(hwnd);
                }
            }
        }
        if let Some(pid) = new_client_pid(before, &client_pids().unwrap_or_default()) {
            return Some((pid, clicked));
        }
        if Instant::now() >= client_deadline {
            return None;
        }
        sleep(CLIENT_POLL_STEP);
    }
}

/// Запуск аккаунта в Astrum Play: подстановка входа (если сохранён), запуск и ожидание клиента игры.
#[allow(clippy::too_many_arguments)]
fn launch_blocking(
    app: &tauri::AppHandle,
    exe: PathBuf,
    char_id: Option<String>,
    url: String,
    wait: Duration,
    window_title: Option<String>,
    icon_small: Option<Vec<u8>>,
    icon_big: Option<Vec<u8>>,
    login_saved: Option<bool>,
) -> Result<LaunchInfo, String> {
    let dir = exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Не удалось определить папку Astrum Play".to_string())?;
    let id = char_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let stored = id.map(get_magic).transpose()?.flatten();
    // Помечен как запомненный, а в хранилище ОС его нет: вход не подставится, а Astrum откроет
    // игру под тем аккаунтом, что уже выбран. Молча пропускать это нельзя.
    if stored.is_none() && login_saved.unwrap_or(false) {
        return Err(
            "Вход этого персонажа помечен как запомненный, но в хранилище ОС его нет. \
             Откройте «Инструменты» → «Окна игры» → «🎮 GameCenter и персонажи» \
             и нажмите «🔑 Запомнить вход» ещё раз"
                .to_string(),
        );
    }
    let pairs = stored.as_deref().map(stored_account).transpose()?;

    // Astrum закрываем перед каждым запуском, как GameCenter. Вход подставляем при закрытом Astrum:
    // иначе он перезапустится из-за правки ini. Если закрыть не удалось — отменяем запуск:
    // новый экземпляр передал бы ссылку старому, и игра вышла бы под прежним аккаунтом.
    let t_close = Instant::now();
    let failed = close_astrum();
    let alive = wait_astrum_gone();
    if !alive.is_empty() {
        return Err(format!(
            "Astrum Play не закрылся (запущенных осталось: {}). Новый экземпляр передал бы ему \
             ссылку, и окно открылось бы под чужим аккаунтом. Закройте Astrum Play вручную и \
             повторите; если он запущен от администратора — запустите Твиноферму от администратора",
            alive.len()
        ));
    }
    let ms_gc_close = t_close.elapsed().as_millis() as u64;

    let t_ini = Instant::now();
    let switched = match &pairs {
        Some(p) => {
            write_account(&ini_path(&exe)?, p)?;
            true
        }
        None => false,
    };
    let ms_account = t_ini.elapsed().as_millis() as u64;

    let t_client = Instant::now();
    let before: HashSet<u32> = client_pids()?.into_iter().collect();
    let child = Command::new(&exe)
        .current_dir(&dir)
        .arg(&url)
        .spawn()
        .map_err(|e| format!("{}: {}", exe.display(), e))?;
    let pid = child.id();

    let (client_pid, dialog_clicked) = await_client(&before, wait).ok_or_else(|| {
        format!(
            "Клиент игры не запустился за {} с (Astrum Play: {})",
            wait.as_secs(),
            exe.display()
        )
    })?;
    let ms_client_wait = t_client.elapsed().as_millis() as u64;

    if let Some(title) = window_title.as_deref().and_then(clean_title) {
        watch_client(app, client_pid, title, icon_small, icon_big);
    }

    Ok(LaunchInfo {
        pid,
        dialog_clicked,
        switched,
        client_pid,
        closed_other_gc: 0,
        gc_close_failed: failed,
        ms_gc_close,
        ms_account,
        ms_client_wait,
    })
}

/// Точка входа из `launcher_start` для Astrum Play.
#[allow(clippy::too_many_arguments)]
pub(super) async fn start(
    app: tauri::AppHandle,
    path: String,
    char_id: Option<String>,
    url: Option<String>,
    wait_secs: Option<u64>,
    window_title: Option<String>,
    icon_small: Option<Vec<u8>>,
    icon_big: Option<Vec<u8>>,
    login_saved: Option<bool>,
) -> Result<LaunchInfo, String> {
    let exe = resolve_exe(&path)?;
    let url = url.unwrap_or_else(|| ASTRUM_DEFAULT_URL.to_string());
    if !url_ok(&url) {
        return Err("Некорректная ссылка запуска Astrum Play".to_string());
    }
    let wait = Duration::from_secs(wait_secs.unwrap_or(60).clamp(5, 600));
    tauri::async_runtime::spawn_blocking(move || {
        launch_blocking(
            &app,
            exe,
            char_id,
            url,
            wait,
            window_title,
            icon_small,
            icon_big,
            login_saved,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{encode_ini, text_to_pairs};

    const ASTRUM_INI_TEXT: &str = "[UMS]\r\nastrum=1894\r\n\r\n[Main]\r\nLang=ru\r\nMyComUserLogin=user0@example.com\r\nMyComUserUid=1\r\nCurrentUserNick=Old\r\nMyComUserMagic2=OLDMAGIC\r\n\r\n[Chrome]\r\nCacheVersion=2\r\n";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tf-astrum-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_astrum_exe_is_accepted() {
        let dir = temp_dir("exe");
        let exe = dir.join(ASTRUM_EXE);
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(resolve_exe(dir.to_str().unwrap()).unwrap(), exe);
        assert_eq!(resolve_exe(exe.to_str().unwrap()).unwrap(), exe);
        assert!(resolve_exe("C:\\Windows\\notepad.exe").is_err());
        assert!(resolve_exe("").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_astrum_links_are_accepted() {
        assert!(url_ok("astrumplay://play/0.61"));
        assert!(!url_ok("vkplay://play/0.61"));
        assert!(!url_ok("astrumplay://play/0.61 --evil"));
        assert!(!url_ok("notepad.exe"));
    }

    #[test]
    fn dialog_is_matched_by_class_title_and_visibility() {
        // Полный заголовок окна вопроса у Astrum в разных сборках звучит по-разному, поэтому
        // решает часть заголовка плюс класс окна: вопрос — `TYesNoForm`, как и у GameCenter.
        assert!(is_launcher_dialog("TYesNoForm", "Astrum Play Launcher", true));
        assert!(is_launcher_dialog("TYesNoForm", "VK Play Astrum Play Launcher", true));

        // Скрытое окно, чужой класс и окно авторизации не подходят: Enter в окне
        // «Попытка авторизации…» прервал бы вход, у GameCenter то же исключение.
        assert!(!is_launcher_dialog("TYesNoForm", "Astrum Play Launcher", false));
        assert!(!is_launcher_dialog("TMainForm", "Astrum Play Launcher", true));
        assert!(!is_launcher_dialog(
            "TYesNoForm",
            "Astrum Play: попытка авторизации",
            true
        ));
        assert!(!is_launcher_dialog("TYesNoForm", "06 Страж пати", true));
        assert!(!is_launcher_dialog("TYesNoForm", "", true));
    }

    #[test]
    fn pairs_survive_text_roundtrip_and_keep_equals_in_values() {
        let pairs = vec![
            ("MyComUserLogin".to_string(), "user1@example.com".to_string()),
            (LOGIN_KEY.to_string(), "AB=CD".to_string()),
        ];
        assert_eq!(text_to_pairs(&pairs_to_text(&pairs)), pairs);
    }

    #[test]
    fn account_needs_the_login_token() {
        assert!(read_account("[Main]\r\nLang=ru\r\n").is_none());
        assert!(read_account("[Main]\r\nMyComUserMagic2=\r\n").is_none());
        let text = "[Main]\r\nMyComUserLogin=user1@example.com\r\nMyComUserUid=5\r\nCurrentUserNick=Nick\r\nMyComUserMagic2=TOKEN\r\n";
        let got = read_account(text).unwrap();
        assert_eq!(got.len(), 4);
        assert!(got.iter().any(|(k, v)| k == "MyComUserUid" && v == "5"));
    }

    #[test]
    fn write_account_keeps_utf16_and_other_lines() {
        let dir = temp_dir("write");
        let exe = dir.join(ASTRUM_EXE);
        std::fs::write(&exe, b"").unwrap();
        let ini = dir.join(ASTRUM_INI);
        let raw = encode_ini(ASTRUM_INI_TEXT, &super::super::IniEncoding::Utf16Le);
        std::fs::write(&ini, &raw).unwrap();

        let pairs = vec![
            ("MyComUserLogin".to_string(), "user2@example.com".to_string()),
            ("MyComUserUid".to_string(), "197268650".to_string()),
            ("CurrentUserNick".to_string(), "Twin".to_string()),
            ("MyComUserMagic2".to_string(), "NEWMAGIC".to_string()),
        ];
        write_account(&ini, &pairs).unwrap();

        let after = std::fs::read(&ini).unwrap();
        assert_eq!(&after[..2], &[0xFF, 0xFE], "BOM UTF-16 должен сохраниться");
        let (text, _) = decode_ini(&after);
        assert_eq!(ini_get(&text, "MyComUserLogin").as_deref(), Some("user2@example.com"));
        assert_eq!(ini_get(&text, "MyComUserUid").as_deref(), Some("197268650"));
        assert_eq!(ini_get(&text, "CurrentUserNick").as_deref(), Some("Twin"));
        assert_eq!(ini_get(&text, LOGIN_KEY).as_deref(), Some("NEWMAGIC"));
        // Чужие строки не потеряны: секция [Chrome] и её ключ на месте
        assert!(text.contains("[Chrome]\r\nCacheVersion=2\r\n"));
        assert!(dir.join("AstrumPlay.ini.tvinoferma-backup").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}

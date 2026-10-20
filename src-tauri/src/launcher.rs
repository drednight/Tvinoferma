//! Запуск игры: у каждого аккаунта свой GameCenter (VK Play) в своей папке.
//!
//! Что делает запуск аккаунта (`launcher_start`):
//! 1. Если для персонажа запомнен вход (`launcher_capture_account`), GameCenter этого аккаунта закрывается,
//!    а в его `GameCenter.ini` записывается весь набор ключей аккаунта — `MyComUserLogin`,
//!    `MyComUserUid`, `CurrentUserNick`, `MyComUserMagic2` (см. `ACCOUNT_KEYS`).
//!    Раньше записывались только ник и токен, и это было ошибкой: GameCenter опознаёт аккаунт
//!    по `MyComUserUid`, поэтому оставшийся uid от прошлого аккаунта открывал игру под ним же —
//!    первое окно выходило правильным, а все следующие — под тем же аккаунтом.
//!    Вход лежит только в хранилище ОС (keyring), в `state.json` и в интерфейс он не попадает.
//! 2. Запускается `GameCenter.exe vkplay://play/0.61`.
//! 3. Если клиент игры уже был запущен, GameCenter спрашивает «Клиент игры уже запущен»:
//!    в этом окне выбирается «Запустить новую копию клиента» (по умолчанию выбрана она, достаточно Enter).
//!    Окно «Попытка авторизации…» с кнопкой «Прервать» не трогаем: Enter в нём прервал бы вход.
//! 4. Ждём, пока появится новый процесс клиента игры.
//! 5. Если передан заголовок и значок класса, окну нового клиента ставятся название «Ник — Класс»
//!    и значок (в фоне: окно появляется не сразу). Следит за окнами один общий наблюдатель —
//!    перебор окон один на все запуски, а не поток с полным перебором на каждого аккаунта.
//!    Меняется только вид окна, сама игра не затрагивается.
//!
//! Безопасность: запускается только файл с именем `GameCenter.exe`, а ссылка запуска
//! должна начинаться с `vkplay://` и не содержать пробелов — произвольные программы отсюда не стартуют.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Astrum Play: отдельный лаунчер с другим ini и окном вопроса (см. launcher/astrum.rs)
mod astrum;

const GAMECENTER_EXE: &str = "GameCenter.exe";
/// Начало имени образа клиента игры: `elementclient_64.exe`, `elementclient.exe` и подобные
const CLIENT_PREFIX: &str = "elementclient";
/// Perfect World в VK Play (id проекта 0.61)
const DEFAULT_URL: &str = "vkplay://play/0.61";
/// Класс окон-вопросов GameCenter
const DIALOG_CLASS: &str = "TYesNoForm";
/// Заголовок окна вопроса «Клиент игры уже запущен» («VK Play Игровой центр»)
const DIALOG_TITLE: &str = "VK Play";
/// Сколько ждать это окно после старта GameCenter, если клиент уже был запущен
const DIALOG_WAIT: Duration = Duration::from_secs(30);
/// Как часто повторять Enter в окно вопроса (один клик может не дойти)
const DIALOG_PRESS_GAP: Duration = Duration::from_millis(700);
/// Как часто опрашивать процессы, ожидая новый клиент игры.
/// Опрос теперь почти бесплатный (снимок процессов, а не запуск `tasklist`), поэтому шаг мельче.
const CLIENT_POLL_STEP: Duration = Duration::from_millis(250);
/// Сколько ждать, пока закрытые GameCenter действительно завершатся.
/// Ждём по факту (обычно 0.2–0.5 с), но потолок большой: незакрывшийся GameCenter перехватит
/// ссылку запуска у нового и откроет игру под чужим аккаунтом, поэтому лучше не торопиться.
const GC_EXIT_WAIT: Duration = Duration::from_secs(5);
/// Сколько раз пробуем закрыть GameCenter, прежде чем отменить запуск.
///
/// Один остаток чаще всего означает не «доступа нет», а то, что лаунчер успел поднять новый
/// экземпляр между перебором и закрытием. Второй проход это снимает.
const GC_CLOSE_ATTEMPTS: u32 = 2;
/// Сколько ждать новый клиент игры, секунд (если не задано в вызове)
const DEFAULT_CLIENT_WAIT_SECS: u64 = 60;

/// Сколько искать окно нового клиента, чтобы подписать его и поставить значок
const DECORATE_WAIT: Duration = Duration::from_secs(90);
/// Сколько ещё следить за окном после первой подписи (игра может сама сменить заголовок при загрузке и входе в мир)
const DECORATE_KEEP: Duration = Duration::from_secs(180);
/// Как часто общий наблюдатель окон проверяет окна клиентов (один перебор на все запуски)
const DECORATE_STEP: Duration = Duration::from_millis(700);
/// Допустимый размер значка (сторона квадрата, пикселей)
const ICON_MIN: usize = 8;
const ICON_MAX: usize = 128;

const INI_NAME: &str = "GameCenter.ini";
/// Ключи аккаунта в ini лаунчера. Подставлять надо **все**: GameCenter и Astrum Play опознают
/// аккаунт по `MyComUserUid`, а не по токену, поэтому одного `MyComUserMagic2` мало —
/// с прежним uid игра открылась бы под прежним аккаунтом. Тот же набор ключей у обоих
/// лаунчеров и в том же формате ini, поэтому он общий.
pub(super) const ACCOUNT_KEYS: [&str; 4] = [
    "MyComUserLogin",
    "MyComUserUid",
    "CurrentUserNick",
    "MyComUserMagic2",
];
/// По этому ключу видно, что вход выполнен
pub(super) const LOGIN_KEY: &str = "MyComUserMagic2";
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
    /// Замеры этапов одного запуска, мс.
    ///
    /// Без них «запуск идёт долго» нечем превратить в действие: видно ли время уходит на
    /// закрытие GameCenter, на запись входа в `GameCenter.ini` или на ожидание окна игры.
    /// `ms_gc_close` — закрытие чужих и своего GameCenter и ожидание его выхода;
    /// `ms_account` — запись входа в `GameCenter.ini`;
    /// `ms_client_wait` — от запуска `GameCenter.exe` до появления окна игры.
    ms_gc_close: u64,
    ms_account: u64,
    ms_client_wait: u64,
}

/// Окна и клавиши Windows (user32) без лишних зависимостей.
#[cfg(windows)]
mod win {
    use std::collections::HashSet;
    use std::ffi::c_void;

    type Hwnd = *mut c_void;
    type EnumProc = unsafe extern "system" fn(Hwnd, isize) -> i32;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(proc_: EnumProc, lparam: isize) -> i32;
        fn GetClassNameW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
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
        fn IsHungAppWindow(hwnd: Hwnd) -> i32;
        fn GetWindowLongW(hwnd: Hwnd, index: i32) -> i32;
        fn GetWindow(hwnd: Hwnd, cmd: u32) -> Hwnd;
        // Значок из ресурсов нашего же exe (идентификатор `RT_GROUP_ICON`). Нужен большому
        // слоту окна: Tauri v2 не ставит `ICON_BIG`, а без него панель задач рисует пустой лист.
        fn LoadIconW(instance: *mut c_void, resource_id: *const u16) -> *mut c_void;
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
        fn GetCurrentProcess() -> *mut c_void;
        // Ожидание завершения помощника: приложение должно знать код его возврата,
        // иначе отказ в UAC (1223) неотличим от успеха
        fn WaitForSingleObject(handle: *mut c_void, ms: u32) -> u32;
        fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        // Снимок списка процессов: замена `tasklist` (тот запускал отдельный процесс на каждый
        // опрос, а в цикле ожидания клиента игры это сотни запусков на одну пати)
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        // Полный путь образа процесса: нужен, чтобы отличить «свой» GameCenter от чужих
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }

    /// FILETIME из Win32: время в единицах по 100 нс с 1601 года.
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct FileTime {
        pub low: u32,
        pub high: u32,
    }

    impl FileTime {
        /// Время в миллисекундах с 1970 года (для сопоставления с `Date.now()` в интерфейсе).
        pub fn unix_ms(self) -> u64 {
            const WINDOWS_TO_UNIX_MS: u64 = 11_644_473_600_000;
            let ticks = (u64::from(self.high) << 32) | u64::from(self.low);
            ticks / 10_000 - WINDOWS_TO_UNIX_MS
        }
    }

    /// PROCESSENTRY32W из Win32. Порядок и типы полей важны: структура читается как есть,
    /// поэтому `#[repr(C)]` и `th32DefaultHeapID: usize` (на 64 битах — 8 байт, на 32 — 4).
    #[repr(C)]
    pub struct ProcessEntry32W {
        pub dw_size: u32,
        pub cnt_usage: u32,
        pub th32_process_id: u32,
        pub th32_default_heap_id: usize,
        pub th32_module_id: u32,
        pub cnt_threads: u32,
        pub th32_parent_process_id: u32,
        pub pc_pri_class_base: i32,
        pub dw_flags: u32,
        pub sz_exe_file: [u16; 260],
    }

    /// Чистая структура нужного размера: Windows требует заполнить только `dw_size`,
    /// остальные байты значения не имеют, но должны быть нулями.
    impl ProcessEntry32W {
        fn blank() -> Self {
            // SAFETY: тип — простая структура из целых чисел и массива u16, всё нулевое — корректное значение
            unsafe { std::mem::zeroed() }
        }
    }

    /// Снимок списка процессов: только имена и PID.
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    /// `INVALID_HANDLE_VALUE` — снимок не создался.
    const INVALID_HANDLE_VALUE: isize = -1;

    /// Все процессы системы: (имя образа, PID).
    ///
    /// Быстрый способ: снимок делается прямо в нашем процессе за доли миллисекунды.
    /// Раньше здесь запускался `tasklist` — внешний процесс, 0.2–0.5 с на каждый опрос, а
    /// в цикле ожидания клиента игры он опрашивался каждые полсекунды.
    pub fn all_processes() -> Vec<(String, u32)> {
        let mut list: Vec<(String, u32)> = Vec::new();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot as isize == INVALID_HANDLE_VALUE {
                return list;
            }
            let size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut entry = ProcessEntry32W {
                dw_size: size,
                ..ProcessEntry32W::blank()
            };
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let name = String::from_utf16_lossy(&entry.sz_exe_file);
                    list.push((
                        name.trim_end_matches('\0').to_string(),
                        entry.th32_process_id,
                    ));
                    entry.dw_size = size;
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
        list
    }

    /// Полный путь образа процесса. `None` — не удалось (например, процесс от администратора,
    /// а мы нет): тогда считаем, что это «чужой» GameCenter, и закрыть его не сможем.
    pub fn process_image_path(pid: u32) -> Option<String> {
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 32768];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) != 0;
            CloseHandle(handle);
            if !ok {
                return None;
            }
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
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

    /// Заголовок окна с ограничением по времени.
    ///
    /// Заголовок чужого окна хранится в памяти чужого процесса, поэтому его читают не из
    /// общей памяти, а сообщением `WM_GETTEXT`, на которое окно обязано ответить.
    /// `GetWindowTextW` посылает это сообщение и ждёт, сколько понадобится чужому процессу:
    /// зависший отвечает до 200 мс, и одно такое окно задерживает весь перебор окон — при
    /// массовом запуске окон это и есть вероятная причина подвисаний. Поэтому отправляем
    /// сообщение сами, с признаком `SMTO_ABORTIFHUNG` и коротким таймаутом: окно, которое
    /// не ответило, считается окном без заголовка, а перебор окон не подвешивает.
    fn title_with_timeout(hwnd: Hwnd) -> String {
        const WM_GETTEXT: u32 = 0x000D;
        const SMTO_ABORTIFHUNG: u32 = 0x0002;
        /// Ждём ответа коротко: заголовки читаются в цикле, и зависшее окно не должно
        /// задерживать проход дольше, чем сам шаг цикла.
        const TIMEOUT_MS: u32 = 50;
        let mut buf = [0u16; 256];
        let mut copied: usize = 0;
        let ok = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_GETTEXT,
                buf.len(),
                buf.as_mut_ptr() as isize,
                SMTO_ABORTIFHUNG,
                TIMEOUT_MS,
                &mut copied,
            )
        };
        if ok == 0 {
            return String::new(); // окно не ответило: заголовок неизвестен
        }
        // Окно не обязано уложиться в буфер целиком, поэтому берём столько, сколько влезло
        let n = copied.min(buf.len() - 1);
        String::from_utf16_lossy(&buf[..n])
    }

    /// Что собирает `EnumWindows` по каждому окну.
    struct Collect<'a> {
        list: &'a mut Vec<WinInfo>,
        /// Процессы, у которых нужно читать заголовок и класс. `None` — у всех.
        /// Заголовок чужого окна — это сообщение чужому процессу (см. `title_with_timeout`),
        /// поэтому там, где чужие заголовки не нужны, их и не спрашивают.
        only: Option<HashSet<u32>>,
    }

    /// Нужно ли читать у окна процесса `pid` класс и заголовок. `None` — окна ищутся всех процессов.
    ///
    /// Вынесено из `collect` ради проверки без запуска Windows: чтение заголовка чужого окна —
    /// это сообщение чужому процессу (см. `title_with_timeout`), и там, где чужие заголовки
    /// не нужны, его не должно быть.
    pub(crate) fn window_wanted(only: Option<&HashSet<u32>>, pid: u32) -> bool {
        only.is_none_or(|want| want.contains(&pid))
    }

    unsafe extern "system" fn collect(hwnd: Hwnd, lparam: isize) -> i32 {
        let ctx = unsafe { &mut *(lparam as *mut Collect) };
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        // PID окна стоит копейки: это чтение общей структуры окна, а не сообщение процессу
        let visible = unsafe { IsWindowVisible(hwnd) } != 0;
        if !window_wanted(ctx.only.as_ref(), pid) {
            return 1; // окно чужого процесса: ни класс, ни заголовок не читаем
        }
        let class = read(|b, n| unsafe { GetClassNameW(hwnd, b, n) });
        let title = title_with_timeout(hwnd);
        ctx.list.push(WinInfo {
            hwnd: hwnd as usize,
            pid,
            class,
            title,
            visible,
        });
        1 // продолжать перебор окон
    }

    /// Перебор окон с фильтром: читать заголовки только у окон `only`.
    fn scan(only: Option<HashSet<u32>>) -> Vec<WinInfo> {
        let mut list: Vec<WinInfo> = Vec::new();
        let mut ctx = Collect {
            list: &mut list,
            only,
        };
        unsafe { EnumWindows(collect, &mut ctx as *mut Collect as isize) };
        list
    }

    /// Все окна верхнего уровня.
    pub fn all_windows() -> Vec<WinInfo> {
        scan(None)
    }

    /// Окна только этих процессов. Нужно там, где ищут окна одной игры: перебор один,
    /// а не по перебору на каждого клиента, да и заголовки чужих окон не читаются.
    pub fn windows_of(pids: &[u32]) -> Vec<WinInfo> {
        scan(Some(pids.iter().copied().collect()))
    }

    /// Отправка сообщения окну другого процесса с ограничением по времени: зависшее окно нас не подвесит.
    /// `Err(код)` — код ошибки Windows: 5 — отказано в доступе (окно запущено от администратора, а мы нет),
    /// 1460 — окно не ответило вовремя.
    ///
    /// Потолок намеренно маленький. Окно игры во время загрузки может не отвечать секунды, а
    /// наблюдатель окон у нас один на все запуски (`watch_loop`): каждое занятое окно задерживало
    /// подпись всех остальных на эти секунды. Не успевшая попытка ничего не стоит — следующий
    /// проход идёт через `DECORATE_STEP`, а за время ожидания окна попыток десятки. Терять одну
    /// попытку дёшево, задерживать подпись всех окон — дорого.
    fn send(hwnd: usize, msg: u32, wparam: usize, lparam: isize) -> Result<(), u32> {
        const SMTO_ABORTIFHUNG: u32 = 0x0002;
        const TIMEOUT_MS: u32 = 200;
        let mut result: usize = 0;
        unsafe {
            let ok = SendMessageTimeoutW(
                hwnd as Hwnd,
                msg,
                wparam,
                lparam,
                SMTO_ABORTIFHUNG,
                TIMEOUT_MS,
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

    /// Значок приложения из ресурсов нашего же exe (`RT_GROUP_ICON`, id 32512 — тот же,
    /// что вшивает tauri-build). Нужен большому слоту окна: Tauri v2 не ставит `ICON_BIG`,
    /// а без него панель задач рисует пустой лист. Ручка не уничтожается — окну нужна
    /// на всё время его жизни (та же договорённость, что в `make_icon`).
    pub fn app_resource_icon() -> usize {
        // Идентификатор подаётся как указатель на низкий `u16`, а не как строка.
        const APP_ICON_ID: u16 = 32512;
        unsafe {
            let module = GetModuleHandleW(std::ptr::null());
            if module.is_null() {
                return 0;
            }
            LoadIconW(module, APP_ICON_ID as *const u16) as usize
        }
    }

    /// Ставит окну малый (заголовок) и большой (панель задач, Alt+Tab) значки. 0 — этот значок не меняем.
    pub fn set_icons(hwnd: usize, small: usize, big: usize) -> Result<(), u32> {
        if small != 0 {
            send_icon(hwnd, 0, small)?; // ICON_SMALL
        }
        if big != 0 {
            send_icon(hwnd, 1, big)?; // ICON_BIG
        }
        Ok(())
    }

    /// Снимает с окна поставленные значки: Windows возвращается к значку класса окна
    /// (для клиента игры — к значку exe). Отдельная функция нужна потому, что в `set_icons`
    /// ноль означает «не менять»: вызов `set_icons(hwnd, 0, 0)` не делал вообще ничего,
    /// хотя интерфейс сообщал пользователю об успехе.
    pub fn clear_icons(hwnd: usize) -> Result<(), u32> {
        send_icon(hwnd, 0, 0)?; // ICON_SMALL
        send_icon(hwnd, 1, 0) // ICON_BIG
    }

    /// Одно сообщение `WM_SETICON`: `kind` 0 — малый значок, 1 — большой. Значок 0 снимает прежний.
    fn send_icon(hwnd: usize, kind: usize, icon: usize) -> Result<(), u32> {
        const WM_SETICON: u32 = 0x0080;
        send(hwnd, WM_SETICON, kind, icon as isize)
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

    /// Есть ли у токена процесса права администратора. `Err(код)` — токен открыть не удалось.
    fn token_elevated(process: *mut c_void) -> Result<bool, u32> {
        const TOKEN_QUERY: u32 = 0x0008;
        const TOKEN_ELEVATION: u32 = 20;
        unsafe {
            let mut token: *mut c_void = std::ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return Err(GetLastError());
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
            let err = if ok { 0 } else { GetLastError() };
            CloseHandle(token);
            if ok {
                Ok(elevation != 0)
            } else {
                Err(err)
            }
        }
    }

    /// Запущена ли сама Твиноферма с правами администратора.
    pub fn is_elevated() -> bool {
        unsafe { token_elevated(GetCurrentProcess()).unwrap_or(false) }
    }

    /// Запущен ли чужой процесс с правами администратора. `None` — узнать не удалось.
    /// Если токен процесса нам недоступен (отказано в доступе), это само по себе значит «выше нас»: `Some(true)`.
    pub fn process_elevated(pid: u32) -> Option<bool> {
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const ERROR_ACCESS_DENIED: u32 = 5;
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return (GetLastError() == ERROR_ACCESS_DENIED).then_some(true);
            }
            let res = token_elevated(h);
            CloseHandle(h);
            match res {
                Ok(v) => Some(v),
                Err(ERROR_ACCESS_DENIED) => Some(true),
                Err(_) => None,
            }
        }
    }

    /// Что Windows знает об окне: влияет на то, покажут ли его панель задач и Диспетчер задач.
    pub struct WinDetails {
        /// Окно-инструмент (`WS_EX_TOOLWINDOW`): в панели задач не показывается
        pub tool: bool,
        /// Окно приложения (`WS_EX_APPWINDOW`): показывается в панели задач принудительно
        pub app: bool,
        /// У окна есть владелец: такие окна панель задач тоже пропускает
        pub owned: bool,
        /// Окно «не отвечает»
        pub hung: bool,
        /// Малый и большой значок, которые сейчас у окна (0 — своих нет, берётся значок класса окна)
        pub small_icon: usize,
        pub big_icon: usize,
    }

    /// Значок окна через `WM_GETICON` (0 — малый, 1 — большой). 0 — своего значка нет или окно не ответило.
    ///
    /// Здесь окно только читается, а читается это дважды на каждое окно и на каждом проходе,
    /// поэтому таймаут ещё короче, чем у `send`. Всё то же рассуждение: проход повторяется
    /// каждые `DECORATE_STEP`, и не ответивший значок на следующем проходе прочитается снова.
    fn get_icon(hwnd: usize, kind: usize) -> usize {
        const WM_GETICON: u32 = 0x007F;
        const SMTO_ABORTIFHUNG: u32 = 0x0002;
        const TIMEOUT_MS: u32 = 120;
        let mut result: usize = 0;
        unsafe {
            let ok = SendMessageTimeoutW(
                hwnd as Hwnd,
                WM_GETICON,
                kind,
                0,
                SMTO_ABORTIFHUNG,
                TIMEOUT_MS,
                &mut result,
            );
            if ok != 0 {
                result
            } else {
                0
            }
        }
    }

    pub fn details(hwnd: usize) -> WinDetails {
        const GWL_EXSTYLE: i32 = -20;
        const GW_OWNER: u32 = 4;
        const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
        const WS_EX_APPWINDOW: u32 = 0x0004_0000;
        let h = hwnd as Hwnd;
        unsafe {
            let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
            WinDetails {
                tool: ex & WS_EX_TOOLWINDOW != 0,
                app: ex & WS_EX_APPWINDOW != 0,
                owned: !GetWindow(h, GW_OWNER).is_null(),
                hung: IsHungAppWindow(h) != 0,
                small_icon: get_icon(hwnd, 0),
                big_icon: get_icon(hwnd, 1),
            }
        }
    }

    /// Текущий заголовок окна (см. `title_with_timeout` — почему с таймаутом).
    pub fn title_of(hwnd: usize) -> String {
        title_with_timeout(hwnd as Hwnd)
    }

    /// Когда процесс был запущен, мс с 1970. `None` — процесс недоступен (например, запущен от администратора).
    pub fn process_start_ms(pid: u32) -> Option<u64> {
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut creation = FileTime::default();
            let mut exit = FileTime::default();
            let mut kernel = FileTime::default();
            let mut user = FileTime::default();
            let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
            CloseHandle(handle);
            if !ok || creation.unix_ms() == 0 {
                return None;
            }
            Some(creation.unix_ms())
        }
    }

    /// Главные окна всех процессов сразу: `{ pid: (hwnd, заголовок) }`.
    ///
    /// Список запущенных окон игры нужен перед каждым запуском пати (проверки перед запуском,
    /// кнопка закрытия окна в карточке, вкладка «Сегодня»). Раньше для каждого клиента окна
    /// перебирались отдельно — при десяти открытых окнах это десять полных обходов всех окон
    /// системы. Теперь обход один.
    pub fn main_windows_by_pid() -> std::collections::HashMap<u32, (usize, String)> {
        let mut map = std::collections::HashMap::new();
        for w in all_windows() {
            if !w.visible || w.title.is_empty() {
                continue;
            }
            // Берём первое видимое с заголовком: у клиента игры главное окно одно
            map.entry(w.pid).or_insert((w.hwnd, w.title));
        }
        map
    }

    /// Возвращает окну значки, которые у него уже были (проверка права менять значки без изменения вида).
    pub fn restore_icons(hwnd: usize, small: usize, big: usize) -> Result<(), u32> {
        set_icons(hwnd, small, big)
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

    /// Общая часть запуска от администратора: `wait` — ждать ли завершения нового процесса.
    ///
    /// Разделено на два вызова, потому что ждать можно не всегда: помощник живёт секунды
    /// и его результат действительно нужен, а перезапуск самого приложения ждать нельзя —
    /// новая копия живёт часами.
    fn shell_runas(exe: &str, params: &str, wait: bool) -> Result<Option<i32>, u32> {
        type Hinstance = *mut c_void;
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn ShellExecuteExW(info: *mut ShellExecuteInfoW) -> i32;
        }
        /// Минимальная структура SHELLEXECUTEINFOW: нужны поля до `lpVerb`.
        #[repr(C)]
        struct ShellExecuteInfoW {
            cb_size: u32,
            f_mask: u32,
            hwnd: Hinstance,
            lp_verb: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show: i32,
            // …дальше lpIDList, lpClass, hkeyClass, dwHotKey, hIcon, hProcess — нам не нужны
            rest: [usize; 9],
        }
        const SEE_MASK_NOCLOSEPROCESS: u32 = 0x0000_0040;
        const SW_HIDE: i32 = 0;
        let verb = wide("runas");
        let file = wide(exe);
        let params = wide(params);
        let mut info = ShellExecuteInfoW {
            cb_size: std::mem::size_of::<ShellExecuteInfoW>() as u32,
            // Без ожидания дескриптор процесса не нужен: он всё равно никому не передаётся.
            f_mask: if wait { SEE_MASK_NOCLOSEPROCESS } else { 0 },
            hwnd: std::ptr::null_mut(),
            lp_verb: verb.as_ptr(),
            lp_file: file.as_ptr(),
            lp_parameters: params.as_ptr(),
            lp_directory: std::ptr::null(),
            n_show: SW_HIDE,
            rest: [0; 9],
        };
        unsafe {
            if ShellExecuteExW(&mut info) <= 0 {
                return Err(GetLastError());
            }
            if !wait {
                return Ok(None);
            }
            let process = info.rest[5] as Hinstance; // hProcess по раскладке структуры
            WaitForSingleObject(process, 60_000);
            let mut code: u32 = 0;
            GetExitCodeProcess(process, &mut code);
            CloseHandle(process);
            Ok(Some(code as i32))
        }
    }

    /// Запуск программы с правами администратора (глагол «runas»): Windows покажет запрос UAC.
    ///
    /// Код возврата — результат процесса: 1223 означает, что пользователь отказал.
    /// `None` — сама оболочка не смогла запустить.
    pub fn shell_run_elevated(exe: &str, flag: &str, token: &str) -> Option<i32> {
        shell_runas(exe, &format!("{} {}", flag, token), true)
            .ok()
            .flatten()
    }

    /// Запуск программы с правами администратора **без ожидания** её завершения.
    ///
    /// Для перезапуска самого приложения: новая копия живёт долго, ждать её выхода нельзя.
    /// `Err` — код Windows, который вернула оболочка (`1223`, если пользователь закрыл UAC).
    pub fn shell_run_elevated_detached(exe: &str, args: &str) -> Result<(), u32> {
        shell_runas(exe, args, false).map(|_| ())
    }

    /// Строка UTF-16 с нулём на конце.
    fn wide(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}

#[cfg(not(windows))]
mod win {
    /// Запуск от администратора — только Windows; на других системах прав администратора нет
    pub fn shell_run_elevated(_exe: &str, _flag: &str, _token: &str) -> Option<i32> {
        None
    }

    /// Перезапуск от администратора — тоже только Windows
    pub fn shell_run_elevated_detached(_exe: &str, _args: &str) -> Result<(), u32> {
        Err(0)
    }

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
    /// Окна только этих процессов (на Windows — заголовки чужих окон не читаются).
    pub fn windows_of(_pids: &[u32]) -> Vec<WinInfo> {
        Vec::new()
    }
    pub fn all_processes() -> Vec<(String, u32)> {
        Vec::new()
    }
    pub fn process_image_path(_pid: u32) -> Option<String> {
        None
    }
    pub fn press_enter(_hwnd: usize) {}
    pub fn set_title(_hwnd: usize, _title: &str) -> Result<(), u32> {
        Err(1)
    }
    pub fn make_icon(_bgra: &[u8], _size: usize) -> usize {
        0
    }
    pub fn app_resource_icon() -> usize {
        0
    }
    pub fn set_icons(_hwnd: usize, _small: usize, _big: usize) -> Result<(), u32> {
        Err(1)
    }
    pub fn clear_icons(_hwnd: usize) -> Result<(), u32> {
        Err(1)
    }
    pub fn kill_process(_pid: u32) -> Result<(), u32> {
        Err(1)
    }
    pub fn is_elevated() -> bool {
        false
    }
    pub fn process_elevated(_pid: u32) -> Option<bool> {
        None
    }
    pub struct WinDetails {
        pub tool: bool,
        pub app: bool,
        pub owned: bool,
        pub hung: bool,
        pub small_icon: usize,
        pub big_icon: usize,
    }
    pub fn details(_hwnd: usize) -> WinDetails {
        WinDetails {
            tool: false,
            app: false,
            owned: false,
            hung: false,
            small_icon: 0,
            big_icon: 0,
        }
    }
    pub fn title_of(_hwnd: usize) -> String {
        String::new()
    }
    pub fn process_start_ms(_pid: u32) -> Option<u64> {
        None
    }
    pub fn main_windows_by_pid() -> std::collections::HashMap<u32, (usize, String)> {
        std::collections::HashMap::new()
    }
    pub fn restore_icons(_hwnd: usize, _small: usize, _big: usize) -> Result<(), u32> {
        Err(1)
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
pub(crate) fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Клиент игры: образ называется `elementclient_64.exe`, `elementclient.exe` и подобными.
/// Проверка по началу имени повторяет фильтр `tasklist /FI "IMAGENAME eq elementclient*"`.
fn is_client_image(name: &str) -> bool {
    name.get(..CLIENT_PREFIX.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(CLIENT_PREFIX))
}

/// Все запущенные клиенты игры: (имя образа, PID).
///
/// Снимок процессов делается прямо здесь (см. `win::all_processes`). Раньше запускался
/// `tasklist` — внешний процесс на 0.2–0.5 с, а в цикле ожидания нового клиента игры он
/// опрашивался каждые полсекунды: на запуск десяти окон это сотни запусков и десятки секунд.
fn client_processes() -> Result<Vec<(String, u32)>, String> {
    Ok(win::all_processes()
        .into_iter()
        .filter(|(name, _)| is_client_image(name))
        .collect())
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

/// Нажимает Enter во всех окнах вопроса GameCenter. Один клик может не дойти (окно ещё
/// перехватывает фокус), поэтому Enter повторяется, пока окно не исчезнет.
fn press_dialog_enter() {
    for _ in 0..5 {
        let dialogs = find_dialogs();
        if dialogs.is_empty() {
            return;
        }
        for hwnd in dialogs {
            win::press_enter(hwnd);
        }
        sleep(DIALOG_PRESS_GAP);
    }
}

/// Дожидается нового клиента игры, попутно подтверждая окно «Клиент игры уже запущен».
///
/// Раньше это были два последовательных ожидания: сначала полностью ждалось окно вопроса
/// (до 30 с), и только потом начинался поиск нового процесса клиента. Оба ожидания независимы,
/// поэтому идут одним циклом: как только клиент появился, возврат происходит сразу.
///
/// Окно вопроса нажимается не чаще, чем раз в `DIALOG_PRESS_GAP`: спамить Enter нельзя,
/// а в окно «Попытка авторизации…» его посылать нельзя вовсе (см. `is_gc_dialog`).
///
/// Возвращает `(pid нового клиента, нажали ли Enter в окно вопроса)`.
fn await_new_client(
    before: &HashSet<u32>,
    wait: Duration,
    expect_dialog: bool,
) -> Option<(u32, bool)> {
    let dialog_deadline = Instant::now() + DIALOG_WAIT;
    let client_deadline = Instant::now() + wait;
    let mut dialog_clicked = false;
    let mut last_press: Option<Instant> = None;
    loop {
        if expect_dialog && Instant::now() < dialog_deadline {
            let due = last_press.is_none_or(|t| t.elapsed() >= DIALOG_PRESS_GAP);
            if due && !find_dialogs().is_empty() {
                dialog_clicked = true;
                last_press = Some(Instant::now());
                press_dialog_enter();
            }
        }
        if let Some(pid) = new_client_pid(before, &client_pids().unwrap_or_default()) {
            return Some((pid, dialog_clicked));
        }
        if Instant::now() >= client_deadline {
            return None;
        }
        sleep(CLIENT_POLL_STEP);
    }
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

/// Окно клиента, которое стоит подписывать: видимое и принадлежит нужному процессу.
///
/// Заголовок намеренно **не требуется**: сразу после старта окно клиента уже видимо, но заголовок
/// у него ещё пустой — раньше такие окна пропускались, и подпись не ставилась совсем. Пустой
/// заголовок у окна этого процесса — как раз то, что нужно заполнить.
fn is_client_window(w: &win::WinInfo, pid: u32) -> bool {
    w.pid == pid && w.visible
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
    /// Окна, которые в прошлом проходе не ответили вовсе: в этом их не трогаем.
    ///
    /// Окно игры в это время бывает занято (загрузка мира, чтение с диска), а не «зависло»,
    /// поэтому `SMTO_ABORTIFHUNG` его не прерывает, и мы платим таймаут на каждое сообщение.
    /// На проход на окно их до четырёх (два `WM_GETICON` на проверку, `WM_SETTEXT`, два
    /// `WM_SETICON`), а наблюдатель один на все запуски — то есть одно занятое окно задерживало
    /// подпись всех остальных. Пропуск стоит одного прохода: следующий идёт через `DECORATE_STEP`.
    busy: Vec<usize>,
}

/// Код Windows «окно не ответило за отведённое время» (или зависло — `SMTO_ABORTIFHUNG`).
const WINDOW_TIMEOUT: u32 = 1460;

/// Один проход по окнам: подписывает окна клиента `pid`. `Some(код)` — дальше пробовать бессмысленно (нет доступа).
///
/// `has_icons` проверяет, есть ли у окна свой значок прямо сейчас. Проверка нужна потому, что игра
/// перезаписывает вид окна при загрузке и входе в мир: если поставить значок один раз и больше
/// не проверять, он пропадёт — раньше так и было.
fn decorate_step(
    progress: &mut DecorateProgress,
    windows: &[win::WinInfo],
    pid: u32,
    title: &str,
    set_title: &mut impl FnMut(usize, &str) -> Result<(), u32>,
    set_icons: &mut impl FnMut(usize) -> Result<(), u32>,
    has_icons: &impl Fn(usize) -> bool,
) -> Option<u32> {
    // Занятые в прошлом проходе окна в этом пропускаем: `take` уже очистил список, поэтому
    // следующим проходом окно пробуется снова — пропуск ровно один, а не навсегда.
    let skip = std::mem::take(&mut progress.busy);
    for w in windows.iter().filter(|w| is_client_window(w, pid)) {
        progress.seen = true;
        if skip.contains(&w.hwnd) {
            continue;
        }
        let mut touched = false;
        let mut timeout = false;
        if w.title == title {
            progress.verified = true;
        } else {
            // заголовка нет или игра сама его переписала — ставим снова
            touched = true;
            if let Err(code) = set_title(w.hwnd, title) {
                progress.last_error = code;
                timeout |= code == WINDOW_TIMEOUT;
                if code == ERROR_ACCESS_DENIED {
                    return Some(code);
                }
            }
        }
        // Значок проверяем по факту, а не по «уже ставили»: игра может его сбросить,
        // и тогда значок нужно поставить заново
        if !has_icons(w.hwnd) {
            if let Err(code) = set_icons(w.hwnd) {
                progress.last_error = code;
                timeout |= code == WINDOW_TIMEOUT;
                if code == ERROR_ACCESS_DENIED {
                    return Some(code);
                }
            }
        }
        if timeout {
            progress.busy.push(w.hwnd);
        }
        if touched && !progress.with_icons.contains(&w.hwnd) {
            progress.with_icons.push(w.hwnd);
        }
    }
    None
}

/// Одно окно(-а) клиента, за которым нужно следить: заголовок «Ник — Класс» и значок класса.
///
/// Окно появляется не сразу (загрузка клиента), поэтому его ищем в фоне; после первой подписи
/// ещё `DECORATE_KEEP` следим за заголовком и значком — игра переписывает их при входе в мир.
struct WatchJob {
    /// PID клиента игры
    pid: u32,
    /// Какой заголовок должен быть у окна
    title: String,
    /// Значки окна (0 — этот значок не ставить)
    small: usize,
    big: usize,
    /// Куда сообщить итог — в приложении это событие `launcher-decorate`
    report: Box<dyn Fn(Decorated, u32) + Send>,
    /// Что накопилось за время слежения
    progress: DecorateProgress,
    /// До какого момента искать окно клиента
    deadline: Instant,
    /// Когда заголовок впервые совпал с нужным
    verified_at: Option<Instant>,
    /// Итог уже сообщён: «Ок» и ошибка сообщаются один раз
    reported: bool,
}

impl WatchJob {
    /// Один проход по окнам. `true` — следить больше не нужно.
    ///
    /// Вызовы Windows принимаются параметрами, как в `decorate_step`: в тесте подписывать
    /// настоящие окна нечем, а поведение прохода проверяется целиком.
    fn step(
        &mut self,
        windows: &[win::WinInfo],
        now: Instant,
        set_title: &mut impl FnMut(usize, &str) -> Result<(), u32>,
        set_icons: &mut impl FnMut(usize) -> Result<(), u32>,
        has_icons: &impl Fn(usize) -> bool,
    ) -> bool {
        // Сначала срок: раньше это было условие выхода из цикла наблюдателя
        if now >= self.deadline {
            if !self.reported {
                let status = if self.progress.seen {
                    Decorated::Failed
                } else {
                    Decorated::Missing
                };
                self.report(status, self.progress.last_error);
            }
            return true;
        }
        if let Some(code) = decorate_step(
            &mut self.progress,
            windows,
            self.pid,
            &self.title,
            set_title,
            set_icons,
            has_icons,
        ) {
            self.report(Decorated::Denied, code);
            return true;
        }
        if self.progress.verified {
            if !self.reported {
                self.reported = true;
                self.verified_at = Some(now);
                self.report(Decorated::Ok, 0);
            }
            if self
                .verified_at
                .is_some_and(|t| now.duration_since(t) > DECORATE_KEEP)
            {
                return true;
            }
        }
        false
    }

    fn report(&self, status: Decorated, code: u32) {
        (self.report)(status, code);
    }
}

/// Задания, ожидающие общего наблюдателя окон.
struct Watcher {
    queue: Vec<WatchJob>,
}

/// Наблюдатель окон один на всё приложение: раньше каждый запуск окна заводил свой поток,
/// и каждый из них раз в `DECORATE_STEP` перебирал все окна системы — при десяти клиентах
/// это десять переборов вместо одного (а перебор окон — это сообщения чужим окнам).
/// Теперь перебор один на все задания, а `WAKE` будит наблюдателя, когда есть работа.
static WATCHER: Mutex<Watcher> = Mutex::new(Watcher { queue: Vec::new() });
static WAKE: Condvar = Condvar::new();
/// Наблюдатель уже запущен. Поток не завершается: без заданий он ждёт на условии.
static WATCHING: AtomicBool = AtomicBool::new(false);

fn watch_lock() -> std::sync::MutexGuard<'static, Watcher> {
    WATCHER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Ставит окно клиента в очередь наблюдателя: тот найдёт окно, поставит заголовок и значок
/// и сообщит итог (`Ok`, `Denied`, …). Поведение прежнее, нагрузка — нет: перебор окон
/// один на все запуски, а не поток с перебором окон на каждого аккаунта.
fn watch_client(
    app: &tauri::AppHandle,
    pid: u32,
    title: String,
    icon_small: Option<Vec<u8>>,
    icon_big: Option<Vec<u8>>,
) {
    let shown = title.clone();
    let app = app.clone();
    let job = WatchJob {
        pid,
        title,
        small: icon_from_rgba(icon_small.as_deref()),
        big: icon_from_rgba(icon_big.as_deref()),
        report: Box::new(move |status, code| {
            let _ = app.emit(
                "launcher-decorate",
                DecorateEvent {
                    pid,
                    title: shown.clone(),
                    status,
                    code,
                },
            );
        }),
        progress: DecorateProgress::default(),
        deadline: Instant::now() + DECORATE_WAIT,
        verified_at: None,
        reported: false,
    };
    {
        let mut watcher = watch_lock();
        watcher.queue.push(job);
    }
    // Поток заводится один раз и живёт, пока живо приложение: без заданий он спит на условии
    if !WATCHING.swap(true, Ordering::SeqCst) {
        let started = std::thread::Builder::new()
            .name("twino-windows".into())
            .spawn(watch_loop)
            .is_ok();
        if !started {
            WATCHING.store(false, Ordering::SeqCst);
        }
    }
    WAKE.notify_one();
}

/// Цикл общего наблюдателя окон.
fn watch_loop() {
    let mut jobs: Vec<WatchJob> = Vec::new();
    loop {
        if jobs.is_empty() {
            // Работы нет: спим до нового задания (шаг `DECORATE_STEP` — предохранитель,
            // чтобы пропущенное пробуждение не стоило нам вечного ожидания)
            let mut watcher = watch_lock();
            if watcher.queue.is_empty() {
                watcher = WAKE
                    .wait_timeout(watcher, DECORATE_STEP)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
            // Новое задание: проход начинаем сразу, не дожидаясь следующего шага
            jobs.append(&mut watcher.queue);
            continue;
        }
        // Один перебор окон на все задания: заголовки читаются только у окон этих процессов
        let pids: Vec<u32> = jobs.iter().map(|job| job.pid).collect();
        let windows = win::windows_of(&pids);
        let now = Instant::now();
        jobs.retain_mut(|job| {
            let (small, big) = (job.small, job.big);
            !job.step(
                &windows,
                now,
                &mut |hwnd, t| win::set_title(hwnd, t),
                &mut |hwnd| win::set_icons(hwnd, small, big),
                // Свой значок у окна есть? Если игра его сбросила — поставим заново
                &|hwnd| {
                    if small == 0 && big == 0 {
                        return true; // значки не запрашивали: проверять нечего
                    }
                    let d = win::details(hwnd);
                    (small == 0 || d.small_icon != 0) && (big == 0 || d.big_icon != 0)
                },
            )
        });
        if !jobs.is_empty() {
            sleep(DECORATE_STEP);
        }
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
/// Для записи в ini не используется: сохранение проверяет `writable_ini_value` по кодировке файла.
#[allow(dead_code)]
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

/// Набор «ключ=значение» для хранилища ОС. Значения в одну строку (переводов строк в них не бывает).
pub(super) fn pairs_to_text(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn text_to_pairs(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// Значения входа из текста ini. `None` — вход не выполнен.
pub(super) fn read_account(text: &str) -> Option<Vec<(String, String)>> {
    ini_get(text, LOGIN_KEY).filter(|m| !m.is_empty())?;
    Some(
        ACCOUNT_KEYS
            .iter()
            .filter_map(|k| ini_get(text, k).map(|v| (k.to_string(), v)))
            .collect(),
    )
}

/// Значение, которое можно записать в ini одной строкой.
///
/// Файл бывает и в однобайтовой кодировке, и в UTF-16: в однобайтовую не-ASCII попасть нельзя
/// (испортит файл), в UTF-16 — можно. Проверка идёт по кодировке, которую увидели в файле.
fn writable_ini_value(value: &str, enc: &IniEncoding) -> bool {
    let plain = !value.is_empty() && value.len() <= 512 && !value.contains(['\r', '\n']);
    match enc {
        IniEncoding::Utf16Le => plain,
        IniEncoding::Bytes => plain && value.chars().all(|c| c.is_ascii_graphic()),
    }
}

/// Подставляет значения входа в ini лаунчера. При первой подмене рядом остаётся резервная копия.
/// Писать надо при закрытом лаунчере: работающий GameCenter файл не перечитывает, а Astrum
/// после правки перезапускается сам.
pub(super) fn write_account(ini: &Path, pairs: &[(String, String)]) -> Result<(), String> {
    let bytes = std::fs::read(ini).map_err(|e| format!("{}: {}", ini.display(), e))?;
    let backup = ini.with_extension("ini.tvinoferma-backup");
    if !backup.exists() {
        let _ = std::fs::copy(ini, &backup);
    }
    let (mut text, enc) = decode_ini(&bytes);
    for (key, value) in pairs {
        if !writable_ini_value(value, &enc) {
            continue;
        }
        text = ini_set(&text, key, value);
    }
    write_atomic(ini, &encode_ini(&text, &enc))
}

/// Значения входа из хранилища ОС в виде набора ключей для ini.
///
/// Старые записи хранили только токен (одна строка без `=`). Подставить их нельзя: без `MyComUserUid`
/// лаунчер оставит uid прошлого аккаунта и откроет игру под ним. Поэтому такая запись — явная
/// ошибка с указанием, что сделать, а не тихая подстановка половины аккаунта.
pub(super) fn stored_account(stored: &str) -> Result<Vec<(String, String)>, String> {
    let pairs = text_to_pairs(stored);
    if pairs.is_empty() {
        return Err(
            "Сохранённый вход в старом виде: в нём только токен, а лаунчеру нужен ещё uid аккаунта. \
             Войдите этим аккаунтом в лаунчер и нажмите «🔑 Запомнить вход» ещё раз \
             («Инструменты» → «Окна игры» → «🎮 GameCenter и персонажи»)"
                .to_string(),
        );
    }
    Ok(pairs)
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
    /// Из них сколько — из папки самого запуска (его закрывали, чтобы подставить вход)
    own_failed: u32,
}

/// PID всех запущенных GameCenter.
fn gamecenter_pids() -> Vec<u32> {
    win::all_processes()
        .into_iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case(GAMECENTER_EXE))
        .map(|(_, pid)| pid)
        .collect()
}

/// Путь образа GameCenter. `None` — узнать не удалось (обычно процесс от администратора).
fn gamecenter_path(pid: u32) -> Option<String> {
    win::process_image_path(pid).map(|p| p.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(p))
}

/// Запущенные GameCenter, разделённые на свои (из папки `exe`) и чужие.
/// Путь процесса, который не прочитался, считается чужим: закрыть его безопаснее, чем оставить.
fn split_gamecenters(exe: &Path) -> (Vec<u32>, Vec<u32>) {
    let me = plain_path(exe);
    let (mut mine, mut others) = (Vec::new(), Vec::new());
    for pid in gamecenter_pids() {
        let path = gamecenter_path(pid).unwrap_or_default();
        if !path.is_empty() && path.eq_ignore_ascii_case(&me) {
            mine.push(pid);
        } else {
            others.push(pid);
        }
    }
    (mine, others)
}

/// Закрывает GameCenter перед запуском. Запущенные клиенты игры продолжают работать.
///
/// GameCenter работает в одном экземпляре на компьютер: если уже открыт GameCenter из другой папки,
/// новый просто передаёт ему ссылку запуска, и игра стартует под тем аккаунтом, что открыт там.
/// Поэтому GameCenter из **других** папок закрываются всегда, а из этого `exe` — только если `close_own`
/// (когда подставляется сохранённый вход).
///
/// Раньше здесь запускался PowerShell с `Get-CimInstance Win32_Process` — 1–2.5 с на КАЖДЫЙ аккаунт
/// (WMI самый медленный способ узнать про процессы). Теперь это прямой перебор: миллисекунды.
fn close_gamecenters(exe: &Path, close_own: bool) -> Result<GcClosed, String> {
    let (mine, others) = split_gamecenters(exe);
    let mut report = GcClosed::default();
    for (pid, is_mine) in others
        .iter()
        .map(|p| (p, false))
        .chain(mine.iter().filter(|_| close_own).map(|p| (p, true)))
    {
        match win::kill_process(*pid) {
            Ok(()) => {}
            // 87 — процесс уже завершился между перебором и закрытием: для нас это то же «закрыт»
            Err(87) => {}
            Err(_) => {
                report.failed += 1;
                if is_mine {
                    report.own_failed += 1;
                }
                continue;
            }
        }
        if !is_mine {
            report.others += 1;
        }
    }
    Ok(report)
}

/// Ждёт, пока закрытые GameCenter действительно завершатся (нужно, чтобы они освободили
/// единственный экземпляр), и возвращает оставшихся. На практике процессы заканчиваются
/// за 0.2–0.5 с, поэтому ждём по факту, а не фиксированное время.
fn wait_gamecenters_gone() -> Vec<u32> {
    let deadline = Instant::now() + GC_EXIT_WAIT;
    loop {
        let alive = gamecenter_pids();
        if alive.is_empty() || Instant::now() >= deadline {
            return alive;
        }
        sleep(Duration::from_millis(100));
    }
}

/// Не осталось ли GameCenter, который перехватит ссылку запуска.
///
/// Пока жив хоть один чужой или свой (когда вход подменяется) экземпляр, новый `GameCenter.exe`
/// не откроет игру, а только передаст ссылку старому — и окно выйдет под чужим аккаунтом,
/// причём с правильным заголовком. Поэтому такой запуск отменяется с внятной ошибкой.
/// Свой GameCenter оставляется только когда вход не подменяется: тогда это ожидаемое поведение
/// (окно откроется под тем аккаунтом, что выбран в лаунчере сейчас, — такие персонажи
/// отсеиваются проверкой до запуска).
///
/// Закрытие повторяется: один остаток — это часто не «не далось закрыть», а лаунчер успел
/// поднять новый экземпляр между перебором и закрытием. Повторный проход снимает это, и запуск
/// не срывается зря. Повторов два: больше — значит процесс действительно чужой или зависший,
/// и дальше ждать только впустую.
fn ensure_gamecenter_free(exe: &Path, switched: bool) -> Result<(), String> {
    for attempt in 0..GC_CLOSE_ATTEMPTS {
        let alive = wait_gamecenters_gone();
        if alive.is_empty() {
            return Ok(());
        }
        let (mine, _) = split_gamecenters(exe);
        if !switched && mine.len() == alive.len() {
            return Ok(());
        }
        if attempt + 1 < GC_CLOSE_ATTEMPTS {
            close_gamecenters(exe, switched)?;
        } else {
            // Остаток после повторов: сообщаем так, чтобы совет был по делу
            let how = if self_elevated() {
                "Закройте GameCenter вручную и повторите"
            } else {
                "Закройте GameCenter вручную и повторите; если он запущен от администратора — \
                 запустите Твиноферму от администратора"
            };
            return Err(format!(
                "GameCenter не закрылся после {} попыток закрытия (запущенных осталось: {}). \
                 Новый экземпляр передал бы ему ссылку, и окно открылось бы под чужим аккаунтом. \
                 {how}",
                GC_CLOSE_ATTEMPTS,
                alive.len()
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

/// Проверка пути из настроек: возвращает полный путь к `GameCenter.exe`.
#[tauri::command]
pub fn launcher_check_path(path: String, kind: Option<String>) -> Result<String, String> {
    if kind.as_deref() == Some("astrum") {
        return astrum::resolve_exe(&path).map(|p| p.display().to_string());
    }
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
    let logged_in = read_account(&text).is_some();
    let nick = ini_get(&text, "CurrentUserNick")
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
pub async fn launcher_gc_info(path: String, kind: Option<String>) -> Result<GcInfo, String> {
    if kind.as_deref() == Some("astrum") {
        let exe = astrum::resolve_exe(&path)?;
        return tauri::async_runtime::spawn_blocking(move || astrum::info(&exe))
            .await
            .map_err(|e| e.to_string())?;
    }
    let exe = resolve_gamecenter_exe(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_gc_info(&exe))
        .await
        .map_err(|e| e.to_string())?
}

/// Окно проводника «Открыть файл» (системное, через Windows Forms): пользователь указывает
/// `GameCenter.exe` или `AstrumPlay.exe`. Скрипт ничего не запускает и не читает, только
/// возвращает выбранный путь; заголовок и фильтр подставляет `picker_script`.
#[cfg(windows)]
const PICKER_SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = '__TITLE__'
$dlg.Filter = '__FILTER__'
$dlg.CheckFileExists = $true
if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }
$owner.Dispose()
"#;

/// Диалог выбора файла для одного типа лаунчера (`kind`) или для обоих сразу (без `kind`).
///
/// Без `kind` фильтр показывает и `GameCenter.exe`, и `AstrumPlay.exe` — так «Обзор…» из карточки
/// персонажа умеет указать любой лаунчер, а какой это тип, режется по имени выбранного файла.
#[cfg(windows)]
fn picker_script(kind: Option<&str>) -> String {
    let (title, filter) = match kind {
        Some("astrum") => (
            "Укажите файл AstrumPlay.exe",
            "AstrumPlay.exe|AstrumPlay.exe|Программы (*.exe)|*.exe",
        ),
        Some(_) => (
            "Укажите файл GameCenter.exe",
            "GameCenter.exe|GameCenter.exe|Программы (*.exe)|*.exe",
        ),
        None => (
            "Укажите файл GameCenter.exe или AstrumPlay.exe",
            "GameCenter.exe;AstrumPlay.exe|GameCenter.exe;AstrumPlay.exe|Программы (*.exe)|*.exe",
        ),
    };
    PICKER_SCRIPT
        .replace("__TITLE__", title)
        .replace("__FILTER__", filter)
}

/// Проверка выбранного в проводнике файла.
///
/// `kind` задан — принимается только этот лаунчер. Без `kind` подходит любой из двух: какой
/// именно, узнаём по имени файла, чтобы «свой путь» из карточки персонажа работал и с Astrum Play.
#[cfg(windows)]
fn resolve_picked(path: &str, kind: Option<&str>) -> Result<PathBuf, String> {
    let is_astrum = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(astrum::ASTRUM_EXE));
    match kind {
        Some("astrum") => astrum::resolve_exe(path),
        Some(_) => resolve_gamecenter_exe(path),
        None if is_astrum => astrum::resolve_exe(path),
        None => resolve_gamecenter_exe(path),
    }
}

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

/// Открывает проводник и возвращает полный путь к `GameCenter.exe` или `AstrumPlay.exe`
/// (`None` — окно закрыли без выбора). `kind` ограничивает выбор одним лаунчером.
#[tauri::command]
pub async fn launcher_pick_gamecenter(kind: Option<String>) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let script = picker_script(kind.as_deref());
        let out = tauri::async_runtime::spawn_blocking(move || {
            hidden(Command::new("powershell").args([
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                script.as_str(),
            ]))
            .output()
            .map_err(|e| format!("powershell: {}", e))
        })
        .await
        .map_err(|e| e.to_string())??;
        match parse_picker_output(&String::from_utf8_lossy(&out.stdout)) {
            Some(path) => {
                resolve_picked(&path, kind.as_deref()).map(|p| Some(p.display().to_string()))
            }
            None => Ok(None),
        }
    }
    #[cfg(not(windows))]
    {
        Err("Выбор файла доступен только в Windows".to_string())
    }
}

/// Запоминает вход, который сейчас открыт в этом GameCenter: значения входа — в хранилище ОС,
/// ник возвращается для показа. Перед этим войдите в нужный аккаунт в самом GameCenter.
///
/// Запоминаются все ключи аккаунта (`ACCOUNT_KEYS`), а не один токен: лаунчер опознаёт аккаунт
/// по `MyComUserUid`, и подстановка одного токена оставляла бы uid прошлого аккаунта.
#[tauri::command]
pub async fn launcher_capture_account(
    char_id: String,
    path: String,
    kind: Option<String>,
) -> Result<CaptureReport, String> {
    if kind.as_deref() == Some("astrum") {
        return tauri::async_runtime::spawn_blocking(move || {
            match astrum::capture(&char_id, &path) {
                Ok(nick) => CaptureReport {
                    ok: true,
                    nick,
                    steps: vec!["Astrum Play: вход запомнен".to_string()],
                },
                Err(e) => CaptureReport {
                    ok: false,
                    nick: String::new(),
                    steps: vec![format!("ОШИБКА (Astrum Play): {}", e)],
                },
            }
        })
        .await
        .map_err(|e| e.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || capture_gc_steps(&char_id, &path))
        .await
        .map_err(|e| e.to_string())
}

/// Итог «Запомнить»: результат и что удалось на каждом шаге. Сами значения (токен, email) в отчёт не попадают.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReport {
    ok: bool,
    nick: String,
    steps: Vec<String>,
}

fn capture_gc_steps(char_id: &str, path: &str) -> CaptureReport {
    let mut steps: Vec<String> = Vec::new();
    match capture_gc_inner(char_id, path, &mut steps) {
        Ok(nick) => {
            steps.push("Готово: вход запомнен".to_string());
            CaptureReport {
                ok: true,
                nick,
                steps,
            }
        }
        Err((step, why)) => {
            steps.push(format!("ОШИБКА на шаге «{}»: {}", step, why));
            CaptureReport {
                ok: false,
                nick: String::new(),
                steps,
            }
        }
    }
}

fn capture_gc_inner(
    char_id: &str,
    path: &str,
    steps: &mut Vec<String>,
) -> Result<String, (&'static str, String)> {
    let exe = resolve_gamecenter_exe(path).map_err(|e| ("1. Поиск GameCenter.exe", e))?;
    steps.push(format!("1. GameCenter.exe: {}", exe.display()));

    let ini = gc_ini_path(&exe).map_err(|e| ("2. Путь к GameCenter.ini", e))?;
    steps.push(format!("2. Файл настроек: {}", ini.display()));

    let bytes = std::fs::read(&ini).map_err(|e| ("3. Чтение GameCenter.ini", e.to_string()))?;
    let (text, enc) = decode_ini(&bytes);
    let enc_name = match enc {
        IniEncoding::Utf16Le => "UTF-16",
        IniEncoding::Bytes => "ANSI/UTF-8",
    };
    steps.push(format!(
        "3. Файл прочитан: {} байт, кодировка {}",
        bytes.len(),
        enc_name
    ));

    let pairs = read_account(&text)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            (
                "4. Поиск входа в файле",
                "в этом GameCenter не выполнен вход: войдите в аккаунт и повторите".to_string(),
            )
        })?;
    let key_names: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
    steps.push(format!(
        "4. Найдено ключей входа: {} {:?}",
        pairs.len(),
        key_names
    ));

    // Проверка по кодировке файла, а не только по ASCII: ник на русском в UTF-16 записывается без проблем.
    let mut usable: Vec<(String, String)> = Vec::new();
    for (key, value) in pairs {
        if value.is_empty() {
            steps.push(format!("5. Ключ {} пустой — пропущен", key));
            continue;
        }
        if !writable_ini_value(&value, &enc) {
            return Err((
                "5. Проверка значения",
                format!(
                    "ключ {}: {} симв., такое значение нельзя записать в файл в кодировке {}",
                    key,
                    value.chars().count(),
                    enc_name
                ),
            ));
        }
        usable.push((key, value));
    }
    steps.push(format!(
        "5. Значения проверены: {} ключей подходят",
        usable.len()
    ));

    let nick = ini_get(&text, "CurrentUserNick")
        .map(|v| display_value(&v))
        .unwrap_or_default();

    let entry = magic_entry(char_id).map_err(|e| ("6. Открытие записи в хранилище Windows", e))?;
    let stored = pairs_to_text(&usable);
    // Запись через vault: если keyring не может писать в эту сессию входа
    // (Windows 1312) — vault пишет запасным способом, видным чтению keyring.
    crate::vault::set_password(
        &entry,
        VAULT_SERVICE,
        &format!("gc-magic:{}", char_id),
        &stored,
    )
    .map_err(|e| ("6. Запись в хранилище Windows", e))?;
    steps.push("6. Записано в хранилище Windows".to_string());

    let back = entry
        .get_password()
        .map_err(|e| ("7. Проверка записи", e.to_string()))?;
    if back != stored {
        return Err((
            "7. Проверка записи",
            "прочитано значение, отличное от записанного".to_string(),
        ));
    }
    steps.push("7. Запись проверена: совпадает".to_string());

    steps.push(format!(
        "8. Ник в GameCenter: {}",
        if nick.is_empty() {
            "не найден".to_string()
        } else {
            nick.clone()
        }
    ));
    Ok(nick)
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
///    Если закрыть не удалось (запущен от администратора) — запуск отменяется: подставлять вход в ini
///    при живом лаунчере бессмысленно, он файл не перечитывает, а игра выйдет под прежним аккаунтом.
/// 2. Запоминает, сколько клиентов игры уже запущено, и стартует `GameCenter.exe <ссылка>`.
/// 3. Если клиенты уже были — ждёт окно «Клиент игры уже запущен» и выбирает «Запустить новую копию клиента».
///    Если не было — ничего не нажимает.
/// 4. Ждёт, пока появится новый клиент игры (до `wait_secs`, по умолчанию 60 с); иначе — ошибка.
/// 5. Если передан `window_title`, в фоне подписывает окно нового клиента и ставит значок (`icon_small`, `icon_big` — RGBA);
///    итог приходит событием `launcher-decorate`.
///
/// `login_saved` — считает ли интерфейс вход персонажа запомненным. Если да, а в хранилище ОС его нет,
/// запуск прекращается: иначе вход не подставится, а окно откроется под тем аккаунтом, что уже был
/// выбран в лаунчере, — с правильным заголовком и чужим персонажем внутри.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn launcher_start(
    app: tauri::AppHandle,
    path: String,
    char_id: Option<String>,
    url: Option<String>,
    wait_secs: Option<u64>,
    window_title: Option<String>,
    icon_small: Option<Vec<u8>>,
    icon_big: Option<Vec<u8>>,
    kind: Option<String>,
    login_saved: Option<bool>,
) -> Result<LaunchInfo, String> {
    if kind.as_deref() == Some("astrum") {
        return astrum::start(
            app,
            path,
            char_id,
            url,
            wait_secs,
            window_title,
            icon_small,
            icon_big,
            login_saved,
        )
        .await;
    }
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
        let stored = id.map(get_magic).transpose()?.flatten();
        // Интерфейс считает, что вход персонажа запомнен, а в хранилище ОС его нет (перенесли
        // state.json, почистили менеджер паролей). Раньше это проходило молча: GameCenter не
        // закрывался, ссылку запуска перехватывал старый экземпляр, и окно выходило под чужим
        // аккаунтом. Теперь такой запуск останавливается с внятным объяснением.
        if stored.is_none() && login_saved.unwrap_or(false) {
            return Err(
                "Вход этого персонажа помечен как запомненный, но в хранилище ОС его нет. \
                 Откройте «Инструменты» → «Окна игры» → «🎮 GameCenter и персонажи» \
                 и нажмите «🔑 Запомнить вход» ещё раз"
                    .to_string(),
            );
        }
        // Набор ключей разбираем до закрытия лаунчера: старый вход (только токен, без uid) —
        // ошибка, и закрывать ради него GameCenter незачем.
        let pairs = stored.as_deref().map(stored_account).transpose()?;

        // Замеры по этапам: пользователь видит в журнале, на что именно ушло время.
        // Без них «запуск идёт долго» нечем превратить в конкретное действие.
        let t_gc = Instant::now();
        let closed = close_gamecenters(&exe, pairs.is_some())?;
        // Ждём освобождения единственного экземпляра GameCenter по факту и отменяем запуск,
        // если кто-то всё же остался: новый экземпляр передал бы ему ссылку, и игра открылась бы
        // под тем аккаунтом, что был открыт раньше (окно при этом получит правильный заголовок).
        if pairs.is_some() || closed.others > 0 || closed.own_failed > 0 {
            ensure_gamecenter_free(&exe, pairs.is_some())?;
        }
        let ms_gc_close = t_gc.elapsed().as_millis() as u64;

        let t_ini = Instant::now();
        let switched = match &pairs {
            Some(pairs) => {
                write_account(&gc_ini_path(&exe)?, pairs)?;
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

        // Окно вопроса «Запустить новую копию клиента» и появление нового клиента ждём одним
        // циклом: раньше сначала полностью ждалось окно вопроса, и только потом начинался
        // поиск процесса клиента — на каждый аккаунт это лишние секунды ожидания.
        let (client_pid, dialog_clicked) = await_new_client(&before, wait, !before.is_empty())
            .ok_or_else(|| {
                format!(
                    "Клиент игры не запустился за {} с (GameCenter: {})",
                    wait.as_secs(),
                    exe.display()
                )
            })?;
        let ms_client = t_client.elapsed().as_millis() as u64;

        // Название «Ник — Класс» и значок: окно появится не сразу, поэтому работаем в фоне, запуск следующего аккаунта не ждёт.
        // Следит один общий наблюдатель окон — отдельный поток с полным перебором окон на каждый
        // аккаунт превращался при десяти клиентах в десять переборов вместо одного.
        if let Some(title) = window_title.as_deref().and_then(clean_title) {
            watch_client(&app, client_pid, title, icon_small, icon_big);
        }

        Ok::<LaunchInfo, String>(LaunchInfo {
            pid,
            dialog_clicked,
            switched,
            client_pid,
            closed_other_gc: closed.others,
            gc_close_failed: closed.failed,
            ms_gc_close,
            ms_account,
            ms_client_wait: ms_client,
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

/// Один запущенный клиент игры для списка «какие окна закрыть».
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunningClient {
    /// Идентификатор процесса
    pub pid: u32,
    /// Имя образа (`elementclient_64.exe`)
    pub image: String,
    /// Когда процесс запущен, мс с 1970; `None` — узнать не удалось (процесс от администратора)
    pub started_at: Option<u64>,
    /// Заголовок главного окна (у окон, подписанных Твинофермой, это «Ник — Класс»)
    pub title: String,
    /// Идентификатор окна
    pub hwnd: Option<u64>,
    /// Запущена ли игра от имени администратора (`None` — не удалось определить)
    pub elevated: Option<bool>,
}

/// Запущенные клиенты игры с подробностями для списка окон.
///
/// Ник и класс Твиноферма не хранит в процессе: она подписывает окно клиента заголовком «Ник — Класс»
/// (см. `launcher_start`). Поэтому ник берётся из заголовка окна, а у окон, запущенных не из Твинофермы,
/// заголовок будет игровым — интерфейс покажет такой клиент как «PID 1234».
#[tauri::command]
pub async fn launcher_running_details() -> Result<Vec<RunningClient>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let list = client_processes()?;
        // Все окна системы перебираются один раз на весь список, а не по одному на клиента
        let windows = win::main_windows_by_pid();
        Ok::<Vec<RunningClient>, String>(
            list.into_iter()
                .map(|(image, pid)| {
                    let window = windows.get(&pid);
                    RunningClient {
                        pid,
                        image,
                        started_at: win::process_start_ms(pid),
                        title: window.as_ref().map(|(_, t)| t.clone()).unwrap_or_default(),
                        hwnd: window.map(|(h, _)| *h as u64),
                        elevated: win::process_elevated(pid),
                    }
                })
                .collect(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Закрыть выбранные клиенты игры по PID. Возвращает отчёт в том же виде, что закрытие всех окон.
/// PID — только числа, поэтому подставлять их в вызов безопасно.
#[tauri::command]
pub async fn launcher_close_clients_pids(pids: Vec<u32>) -> Result<CloseReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let all = client_processes()?;
        // Закрываем только те PID, которые действительно клиенты игры: остальное игнорируем
        let wanted: Vec<(String, u32)> = all
            .into_iter()
            .filter(|(_, pid)| pids.contains(pid))
            .collect();
        Ok::<CloseReport, String>(close_with(wanted, win::is_elevated(), win::kill_process))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Что должно быть подписано у одного окна игры.
///
/// `Serialize` нужен помощнику от администратора (`elevate`): он читает задание из файла и
/// должен записать его в том же виде, в каком его ждёт основной процесс.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecorateTarget {
    /// PID клиента игры
    pub pid: u32,
    /// Ожидаемое название окна («Ник — Класс»)
    pub title: String,
    /// Значок для заголовка окна (RGBA), если его нужно поставить
    #[serde(default)]
    pub icon_small: Option<Vec<u8>>,
    /// Значок для панели задач (RGBA)
    #[serde(default)]
    pub icon_big: Option<Vec<u8>>,
}

/// Значок класса для ручной смены значка у запущенного окна.
///
/// Пиксели RGBA обычно присылает интерфейс (`icon_small`/`icon_big`, конвертация в canvas):
/// у окна браузера значок есть всегда, а рядом с exe — не всегда. Если пикселей нет, файл значка ищется
/// в папке значков; `None` — класса нет в списке или файл не читается.
fn class_icon_bytes(class: &str) -> Option<Vec<u8>> {
    // Список классов и имена файлов повторяют `js/core/constants.js` (CLASS_ICON_MAP).
    // Держим их здесь, чтобы команда смены значка работала без участия интерфейса.
    const ICONS: &[(&str, &str)] = &[
        ("Оборотень", "tank.webp"),
        ("Друид", "dru.webp"),
        ("Странник", "mk.webp"),
        ("Воин", "var.webp"),
        ("Маг", "mag.webp"),
        ("Стрелок", "gan.webp"),
        ("Жрец", "prist.webp"),
        ("Лучник", "luk.webp"),
        ("Паладин", "pal.webp"),
        ("Убийца", "sin.webp"),
        ("Шаман", "sham.webp"),
        ("Бард", "bard.webp"),
        ("Мистик", "mist.webp"),
        ("Страж", "sik.webp"),
        ("Дух Крови", "dk.webp"),
        ("Жнец", "kosa.webp"),
        ("Призрак", "gost.webp"),
        ("Канглонг", "canglong.webp"),
    ];
    let file = ICONS.iter().find(|(name, _)| *name == class)?.1;
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // Значки лежат рядом с исполняемым файлом (в сборке Tauri — resources) и в папке разработки.
    // Ищем и по дереву вверх: разметка релиза может быть глубже, чем ждём.
    let mut base = dir.to_path_buf();
    loop {
        for sub in [
            None,
            Some(Path::new("assets").join("icons").join("classes")),
            Some(
                Path::new("public")
                    .join("assets")
                    .join("icons")
                    .join("classes"),
            ),
        ] {
            let path = match sub {
                Some(p) => base.join(p),
                None => base.to_path_buf(),
            };
            if let Ok(bytes) = std::fs::read(path.join(file)) {
                return Some(bytes);
            }
        }
        if !base.pop() {
            return None;
        }
    }
}

/// Значки окна (малый для заголовка, большой для панели задач) для смены вида по требованию.
///
/// Два источника, и порядок важен: сначала **сырые пиксели RGBA** от интерфейса (canvas всегда
/// может прочитать значок класса), и только если их нет — файл значка из папки значков. Пиксели нельзя
/// скормить `image::load_from_memory`: это декодер файлов (PNG/JPEG), а не сырых буферов, и он
/// вернёт ошибку. Раньше код путал эти пути, из-за чего при выборе класса значок не ставился,
/// а название менялось — то есть «иконка не обновляется».
///
/// `None` — значок собрать не удалось: тогда окно не трогаем вовсе. Важно не вернуть «нулевые»
/// значки, иначе Windows снимет текущий значок и окно останется вообще без иконки.
fn style_icons(
    small_rgba: Option<&[u8]>,
    big_rgba: Option<&[u8]>,
    class: &str,
) -> Option<(usize, usize)> {
    if class.is_empty() {
        return None;
    }
    // Пиксели от интерфейса: каждый размер идёт в свой значок как есть, без пересжатия
    let small = icon_from_rgba(small_rgba);
    let big = icon_from_rgba(big_rgba);
    if small != 0 || big != 0 {
        return Some((small, big));
    }
    // Пикселей нет (картинка не прочиталась) — пробуем значок класса (WebP) рядом с exe
    let img = image::load_from_memory(&class_icon_bytes(class)?)
        .ok()?
        .to_rgba8();
    let small = icon_from_rgba(Some(&resize_icon(&img, WINDOW_ICON_SMALL)));
    let big = icon_from_rgba(Some(&resize_icon(&img, WINDOW_ICON_BIG)));
    (small != 0 || big != 0).then_some((small, big))
}

/// Меняет название и значок уже запущенного окна игры по требованию пользователя
/// (кнопка «Изменить» в списке запущенных окон).
///
/// `class` — класс персонажа для значка; `icon_small`/`icon_big` — пиксели значка от интерфейса
/// (RGBA из canvas); пустая строка класса — значок не менять; `clear_icon` — вернуть значок файла игры.
#[tauri::command]
pub async fn launcher_apply_window_style(
    pid: u32,
    title: Option<String>,
    class: Option<String>,
    clear_icon: Option<bool>,
    icon_small: Option<Vec<u8>>,
    icon_big: Option<Vec<u8>>,
) -> Result<DecorateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let windows: Vec<_> = win::all_windows()
            .into_iter()
            .filter(|w| w.pid == pid && w.visible)
            .collect();
        if windows.is_empty() {
            return Ok(DecorateResult {
                pid,
                status: "missing".into(),
                title: String::new(),
            });
        }

        let want_title = title.as_deref().and_then(clean_title);
        let want_class = class.as_deref().map(str::trim).filter(|c| !c.is_empty());
        // Пиксели от интерфейса — основной источник; PNG класса — запасной (см. `style_icons`).
        // `None` значит «значок не собрали»: тогда окно оставляем с прежним значком.
        let icons =
            want_class.and_then(|cls| style_icons(icon_small.as_deref(), icon_big.as_deref(), cls));

        let mut applied = false;
        let mut denied = false;
        let mut last = String::new();
        for w in &windows {
            if let Some(t) = want_title.as_deref() {
                if win::set_title(w.hwnd, t).is_err() {
                    denied = true;
                    continue;
                }
                applied = true;
            }
            match (&icons, clear_icon.unwrap_or(false)) {
                // Пользователь выбрал класс: ставим его значок
                (Some((small, big)), _) => {
                    if win::set_icons(w.hwnd, *small, *big).is_err() {
                        denied = true;
                        continue;
                    }
                    applied = true;
                }
                // «Убрать значок»: снимаем поставленные, Windows вернёт значок файла игры
                (None, true) => {
                    if win::clear_icons(w.hwnd).is_err() {
                        denied = true;
                        continue;
                    }
                    applied = true;
                }
                (None, false) => {}
            }
            last = win::title_of(w.hwnd);
        }

        Ok(DecorateResult {
            pid,
            status: if denied && !applied {
                "failed"
            } else if applied {
                "fixed"
            } else {
                "ok"
            }
            .into(),
            title: last,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Размер стороны значка окна (совпадает с интерфейсом: см. `WINDOW_ICON_*` в launch.js).
const WINDOW_ICON_SMALL: usize = 16;
const WINDOW_ICON_BIG: usize = 48;

/// Уменьшает картинку класса до нужного размера значка (RGBA).
fn resize_icon(img: &image::RgbaImage, size: usize) -> Vec<u8> {
    let resized = image::imageops::resize(
        img,
        size as u32,
        size as u32,
        image::imageops::FilterType::Lanczos3,
    );
    resized.into_raw()
}

/// Итог повторной подписи одного окна.
///
/// `Deserialize` нужен помощнику от администратора (`elevate`): он читает задание и пишет
/// ответ тем же типом, что и обычная команда, — иначе пришлось бы держать две одинаковые структуры.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecorateResult {
    pub pid: u32,
    /// `ok` — название и (если задан) значок на месте; `fixed` — удалось поправить; `failed`/`missing` — нет
    pub status: String,
    /// Что сейчас в заголовке окна
    pub title: String,
}

/// Заново ставит название и значок уже запущенным окнам клиентов.
///
/// Нужно после запуска пати: окно клиента появляется не сразу, а игра при загрузке может переписать
/// заголовок. `launcher_start` подписывает окно в фоне и о результате не сообщает, поэтому интерфейс
/// после запуска всех аккаунтов проверяет итог этой командой и повторяет попытку для тех, где не вышло.
#[tauri::command]
pub async fn launcher_decorate_clients(
    targets: Vec<DecorateTarget>,
) -> Result<Vec<DecorateResult>, String> {
    // Работа — в `decorate_targets`: тем же кодом пользуется помощник от администратора
    tauri::async_runtime::spawn_blocking(move || decorate_targets(&targets))
        .await
        .map_err(|e| e.to_string())
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

/// Запущена ли Твиноферма с правами администратора.
pub(crate) fn self_elevated() -> bool {
    win::is_elevated()
}

/// Запускает эту же программу с правами администратора и ждёт её.
///
/// `args` — ключи помощника (см. `elevate`). Windows покажет запрос UAC один раз; если
/// пользователь отказал, вернётся код `1223`. Основной процесс при этом не перезапускается:
/// права нужны только отдельному короткому процессу.
///
/// Через `ShellExecuteW`, а не `Command::new`: запуск с повышенными правами другим способом
/// не предусмотрен — это делает оболочка Windows по глаголу «runas».
pub fn run_elevated_self(exe: &str, flag: &str, token: &str) -> Option<i32> {
    win::shell_run_elevated(exe, flag, token)
}

/// Запускает эту же программу с правами администратора, **не дожидаясь** её завершения.
///
/// Для перезапуска самого приложения: в отличие от помощника, новая копия живёт долго,
/// и ждать её выхода бессмысленно. `Err(code)` — код Windows (`1223`, если отказ в UAC).
pub fn run_elevated_self_detached(exe: &str, args: &str) -> Result<(), u32> {
    win::shell_run_elevated_detached(exe, args)
}

/// Подписывает окна клиентов: заголовок «Ник — Класс» и значок класса.
///
/// Вынесено из команды, чтобы тем же кодом пользовался помощник с правами администратора
/// (`elevate::run_job`) — иначе «подписать от администратора» было бы другой реализацией.
pub fn decorate_targets(targets: &[DecorateTarget]) -> Vec<DecorateResult> {
    let mut out = Vec::new();
    for target in targets {
        let Some(title) = clean_title(&target.title) else {
            continue;
        };
        let small = icon_from_rgba(target.icon_small.as_deref());
        let big = icon_from_rgba(target.icon_big.as_deref());
        // Заголовок может быть ещё пустым: окно клиента видно сразу, а подпись ставится позже
        let windows: Vec<_> = win::all_windows()
            .into_iter()
            .filter(|w| w.pid == target.pid && w.visible)
            .collect();
        if windows.is_empty() {
            out.push(DecorateResult {
                pid: target.pid,
                status: "missing".into(),
                title: String::new(),
            });
            continue;
        }
        let mut fixed = false;
        let mut denied = false;
        let mut last_title = String::new();
        for w in &windows {
            last_title = w.title.clone();
            // Заголовок: ставим, если отличается от нужного
            if w.title != title && win::set_title(w.hwnd, &title).is_err() {
                denied = true;
                continue;
            }
            // Значок: ставим, если задан и у окна его нет
            let has_small = win::details(w.hwnd).small_icon != 0;
            let has_big = win::details(w.hwnd).big_icon != 0;
            if ((small != 0 && !has_small) || (big != 0 && !has_big))
                && win::set_icons(w.hwnd, small, big).is_err()
            {
                denied = true;
                continue;
            }
            fixed = true;
            last_title = win::title_of(w.hwnd);
        }
        let status = if denied && !fixed {
            "failed"
        } else if fixed {
            "fixed"
        } else {
            "ok"
        };
        out.push(DecorateResult {
            pid: target.pid,
            status: status.into(),
            title: last_title,
        });
    }
    out
}

/// Ставит главному окну большой значок панели задач (Alt+Tab и кнопка на панели).
///
/// Tauri v2 не заполняет слот `ICON_BIG` (его `set_icon` пишет только `ICON_SMALL`), а класс
/// окна `Tauri Window` регистрируется без иконок — поэтому панель задач Windows рисует пустой
/// лист вместо кота. Здесь значок берётся из ресурса 32512 того же exe (тот, что вшивает
/// tauri-build) и ставится в оба слота через `win::set_icons`.
#[cfg(windows)]
pub fn apply_app_taskbar_icon(hwnd: usize) {
    let icon = win::app_resource_icon();
    if icon != 0 {
        // Малый слот тоже ставим: он отвечает за заголовок и Alt+Tab, и держать его
        // согласованным с большим дешевле, чем отдельно восстанавливать.
        let _ = win::set_icons(hwnd, icon, icon);
    }
}

/// Запущена ли Твиноферма с правами администратора (для проверок перед запуском: окна игры от администратора
/// нельзя подписать и закрыть из обычной Твинофермы).
#[tauri::command]
pub fn launcher_self_elevated() -> bool {
    self_elevated()
}

// ---------------------------------------------------------------------------
// Диагностика окон игры
// ---------------------------------------------------------------------------

/// Заголовок, который на секунду ставится окну при проверке (потом возвращается прежний).
const PROBE_TITLE: &str = "Твиноферма — проверка";

/// Одно окно клиента игры и результат пробы «поставить заголовок и значки».
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowProbe {
    hwnd: String,
    class: String,
    title: String,
    visible: bool,
    /// Окно-инструмент, окно с владельцем, «не отвечает», принудительно в панели задач
    tool: bool,
    owned: bool,
    hung: bool,
    app: bool,
    /// Есть ли у окна свои значки (малый, большой); иначе панель задач берёт значок из файла игры
    has_small_icon: bool,
    has_big_icon: bool,
    /// Проба: `None` — удалось, иначе код ошибки Windows (5 — нет доступа)
    title_error: Option<u32>,
    /// Заголовок, который прочитан сразу после пробы (должен совпасть с `PROBE_TITLE`)
    title_after: String,
    icon_error: Option<u32>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClientProbe {
    pid: u32,
    /// Запущен ли клиент от администратора (`None` — узнать не удалось)
    elevated: Option<bool>,
    windows: Vec<WindowProbe>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InspectReport {
    /// Запущена ли сама Твиноферма от администратора
    self_elevated: bool,
    clients: Vec<ClientProbe>,
}

/// Окна клиента, которые интересны панели задач: видимые или с заголовком (служебные безымянные окна пропускаем).
fn probe_worthy(w: &win::WinInfo, pid: u32) -> bool {
    w.pid == pid && (w.visible || !w.title.is_empty())
}

fn probe_window(w: &win::WinInfo) -> WindowProbe {
    let d = win::details(w.hwnd);
    let mut title_error = None;
    let mut title_after = w.title.clone();
    let mut icon_error = None;
    if w.visible && !w.title.is_empty() {
        title_error = win::set_title(w.hwnd, PROBE_TITLE).err();
        title_after = win::title_of(w.hwnd);
        // вернуть прежний заголовок и (если были) значки: проба ничего не должна менять
        let _ = win::set_title(w.hwnd, &w.title);
        icon_error = win::restore_icons(w.hwnd, d.small_icon, d.big_icon).err();
    }
    WindowProbe {
        hwnd: format!("{:#x}", w.hwnd),
        class: w.class.clone(),
        title: w.title.clone(),
        visible: w.visible,
        tool: d.tool,
        owned: d.owned,
        hung: d.hung,
        app: d.app,
        has_small_icon: d.small_icon != 0,
        has_big_icon: d.big_icon != 0,
        title_error,
        title_after,
        icon_error,
    }
}

fn inspect_windows() -> Result<InspectReport, String> {
    let pids = client_pids()?;
    let all = win::all_windows();
    let clients = pids
        .into_iter()
        .map(|pid| ClientProbe {
            pid,
            elevated: win::process_elevated(pid),
            windows: all
                .iter()
                .filter(|w| probe_worthy(w, pid))
                .take(12)
                .map(probe_window)
                .collect(),
        })
        .collect();
    Ok(InspectReport {
        self_elevated: win::is_elevated(),
        clients,
    })
}

/// Проверка окон игры: какие окна есть у каждого клиента, можно ли менять им заголовок и значок,
/// запущена ли игра от администратора. Окнам на мгновение ставится проверочный заголовок и возвращается прежний.
#[tauri::command]
pub async fn launcher_inspect_windows() -> Result<InspectReport, String> {
    tauri::async_runtime::spawn_blocking(inspect_windows)
        .await
        .map_err(|e| e.to_string())?
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
    fn canvas_pixels_are_not_an_image_file() {
        // Пиксели от интерфейса (`classIconRgba` из canvas) — это сырой RGBA, а не PNG/JPEG/WebP.
        // Декодеру файлов их скормить нельзя: раньше код пытался именно это, `load_from_memory`
        // возвращал ошибку, и значок молча не ставился — окно получало только название.
        let rgba = vec![200u8; 16 * 16 * 4];
        assert!(
            image::load_from_memory(&rgba).is_err(),
            "сырые пиксели не должны приниматься за файл картинки"
        );
        // А из этих же пикселей значок Windows собирается нормально
        assert_ne!(
            icon_from_rgba(Some(&rgba)),
            0,
            "сырые пиксели должны давать значок"
        );
    }

    #[test]
    fn style_icons_take_pixels_from_the_interface() {
        // Пиксели для заголовка и панели задач приходят разного размера — каждый идёт в свой значок
        let small = vec![10u8; 16 * 16 * 4];
        let big = vec![20u8; 48 * 48 * 4];
        let (s, b) = style_icons(Some(&small), Some(&big), "Воин")
            .expect("значок должен собраться из пикселей");
        assert_ne!(s, 0, "малый значок (заголовок) должен быть создан");
        assert_ne!(b, 0, "большой значок (панель задач) должен быть создан");
    }

    #[test]
    fn clearing_an_icon_actually_sends_a_zero() {
        // «Вернуть значок игры» должно снимать поставленный значок. В `set_icons` ноль значит
        // «не менять», поэтому снятие живёт в отдельной функции — иначе действие молча ничего
        // не делало, а пользователю сообщалось об успехе.
        let src = include_str!("launcher.rs");
        assert!(
            src.contains("pub fn clear_icons(hwnd: usize) -> Result<(), u32>"),
            "снятие значка должно быть отдельной функцией"
        );
        assert!(
            src.contains("send_icon(hwnd, 0, 0)?; // ICON_SMALL"),
            "снятие обязано отправить нулевой малый значок"
        );
        assert!(
            src.contains("send_icon(hwnd, 1, 0) // ICON_BIG"),
            "снятие обязано отправить нулевой большой значок"
        );
        // Ветка «убрать значок» должна идти через снятие: обнулять значки через `set_icons`
        // бессмысленно, там ноль означает «не менять». Ищем именно вызов в рабочем коде.
        assert!(src.contains("win::clear_icons(w.hwnd)"));
        let set_icons_zero = format!("win::set_icons(w.hwnd, {})", "0, 0");
        assert!(
            !src.contains(&set_icons_zero),
            "снятие значка не должно идти через set_icons с нулями"
        );
    }

    #[test]
    fn main_window_sets_the_big_taskbar_icon() {
        // Панель задач Windows рисует кнопку из слота `ICON_BIG`. Tauri v2 его не заполняет
        // (его `set_icon` пишет только `ICON_SMALL`), а класс окна `Tauri Window` регистрируется
        // без иконок — поэтому на панели задач вместо кота был пустой лист. Проверяем, что мы
        // явно ставим большой слот и берём для него ресурс 32512 того же exe.
        let src = include_str!("launcher.rs");
        assert!(
            src.contains("pub fn apply_app_taskbar_icon(hwnd: usize)"),
            "обходной путь для большого слота должен существовать"
        );
        assert!(
            src.contains("win::set_icons(hwnd, icon, icon)"),
            "значок обязан уйти в оба слота окна, включая большой"
        );
        assert!(
            src.contains("const APP_ICON_ID: u16 = 32512"),
            "значок панели задач берётся из ресурса 32512 того же exe (та же иконка, что у Tauri)"
        );
    }

    #[test]
    fn class_png_is_a_real_fallback() {
        // Запасной путь должен работать на настоящем файле значка, а не только «не падать».
        // Путь от папки пакета (`src-tauri`), где запускаются тесты Cargo.
        let png = std::fs::read("../public/assets/icons/classes/var.webp")
            .expect("значок класса «Воин» должен лежать в репозитории");
        let img = image::load_from_memory(&png)
            .expect("WebP должен читаться")
            .to_rgba8();
        let small = icon_from_rgba(Some(&resize_icon(&img, WINDOW_ICON_SMALL)));
        let big = icon_from_rgba(Some(&resize_icon(&img, WINDOW_ICON_BIG)));
        assert_ne!(small, 0, "малый значок из WebP должен собраться");
        assert_ne!(big, 0, "большой значок из WebP должен собраться");
    }

    #[test]
    fn style_icons_without_pixels_fall_back_to_the_class_png() {
        // Пикселей нет и файла значка класса рядом с exe нет — значок собрать нечем, окно не трогаем.
        // Важно именно `None`, а не пара нулей: нули заставили бы Windows снять текущий значок.
        assert_eq!(style_icons(None, None, "НетТакогоКласса"), None);
        // Класс не задан — значок не меняем вовсе
        assert_eq!(style_icons(None, None, ""), None);
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
                                                                      // Окно клиента видно сразу после старта, но заголовок у него ещё пустой: его и нужно подписать,
                                                                      // поэтому пустой заголовок больше не причина пропустить окно
        assert!(is_client_window(&w(7, "", true), 7));
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
            // Значка у окна ещё нет — его надо поставить
            &|_| false,
        );
        assert_eq!(denied, None);
        assert_eq!(titled, vec![(1, "Ник — Класс".to_string())]); // чужое окно не тронуто
        assert_eq!(iconed, vec![1]);
        assert!(progress.seen && !progress.verified); // совпадение видно только на следующем проходе
    }

    #[test]
    fn icons_are_reapplied_after_the_game_resets_them() {
        // Игра сбрасывает вид окна при загрузке и входе в мир: значок нужно ставить заново,
        // а не один раз за весь запуск (раньше он пропадал именно из-за этого)
        let mut progress = DecorateProgress::default();
        let mut iconed = 0;
        // Счётчик живёт в Cell: замыкание-постановщик значков держит изменяемую ссылку,
        // поэтому читать обычную переменную рядом нельзя
        for has in [true, false, false] {
            let counter = std::cell::Cell::new(0);
            decorate_step(
                &mut progress,
                &[client_window(1, 100, "Ник — Класс")],
                100,
                "Ник — Класс",
                &mut |_, _| Ok(()),
                &mut |_| {
                    counter.set(counter.get() + 1);
                    Ok(())
                },
                &|_| has,
            );
            iconed += counter.get();
        }
        // Первый проход: значок на месте — не трогали. Дальше игра его сбросила — поставили дважды
        assert_eq!(iconed, 2);
    }

    #[test]
    fn empty_title_window_is_signed() {
        // Окно клиента появляется раньше заголовка: подпись должна ставиться и в этот момент
        let mut progress = DecorateProgress::default();
        let mut titled: Vec<String> = Vec::new();
        decorate_step(
            &mut progress,
            &[client_window(1, 100, "")],
            100,
            "Ник — Класс",
            &mut |_, t| {
                titled.push(t.to_string());
                Ok(())
            },
            &mut |_| Ok(()),
            &|_| true,
        );
        assert_eq!(titled, vec!["Ник — Класс".to_string()]);
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
                &|_| false,
            )
        };
        step(&mut progress, "Perfect World"); // первая подпись
        step(&mut progress, "Ник — Класс"); // заголовок совпал: название не трогаем
        assert!(progress.verified);
        step(&mut progress, "Perfect World"); // игра переписала заголовок: ставим снова
        assert_eq!(titles, 2);
        // Значок проверяется по факту (`has_icons` всегда false), поэтому ставится в каждом проходе
        assert_eq!(icons, 3);
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
            &|_| false,
        );
        assert_eq!(denied, Some(ERROR_ACCESS_DENIED));
        assert_eq!(progress.last_error, ERROR_ACCESS_DENIED);
    }

    /// Задание наблюдателю для теста: итог уходит в канал, настоящие окна не нужны.
    fn watch_job(
        pid: u32,
        title: &str,
        wait: Duration,
    ) -> (WatchJob, std::sync::mpsc::Receiver<(Decorated, u32)>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let job = WatchJob {
            pid,
            title: title.to_string(),
            small: 0,
            big: 0,
            report: Box::new(move |status, code| {
                let _ = tx.send((status, code));
            }),
            progress: DecorateProgress::default(),
            deadline: Instant::now() + wait,
            verified_at: None,
            reported: false,
        };
        (job, rx)
    }

    #[test]
    fn titles_are_read_only_for_the_processes_being_looked_for() {
        // Заголовок чужого окна — сообщение чужому процессу: там, где чужие заголовки
        // не нужны, их не спрашивают вовсе
        let want: HashSet<u32> = [100, 200].into_iter().collect();
        assert!(win::window_wanted(Some(&want), 100));
        assert!(win::window_wanted(Some(&want), 200));
        assert!(!win::window_wanted(Some(&want), 300));
        // Ищем окна всех процессов: фильтра нет
        assert!(win::window_wanted(None, 300));
    }

    #[test]
    fn watch_job_reports_ok_once_and_watches_for_the_keep_time() {
        // Заголовок не наш: «подписали» ничем; значок проверять нечему — кладём замыканиями
        fn keep_title(_hwnd: usize, _t: &str) -> Result<(), u32> {
            Ok(())
        }
        fn keep_icons(_hwnd: usize) -> Result<(), u32> {
            Ok(())
        }
        fn icons_in_place(_hwnd: usize) -> bool {
            true
        }
        let (mut job, rx) = watch_job(
            100,
            "Ник — Класс",
            DECORATE_WAIT + DECORATE_KEEP + DECORATE_KEEP,
        );
        let windows = [client_window(1, 100, "Ник — Класс")];
        let now = Instant::now();
        // Заголовок совпал: сообщаем «Ок», но ещё следим DECORATE_KEEP — игра переписала бы его при входе в мир
        assert!(!job.step(
            &windows,
            now,
            &mut keep_title,
            &mut keep_icons,
            &icons_in_place
        ));
        assert_eq!(rx.try_recv().unwrap(), (Decorated::Ok, 0));
        // Второй проход «Ок» уже не шлём
        assert!(!job.step(
            &windows,
            now + Duration::from_secs(1),
            &mut keep_title,
            &mut keep_icons,
            &icons_in_place
        ));
        assert!(rx.try_recv().is_err());
        // Ровно на границе DECORATE_KEEP ещё следим…
        assert!(!job.step(
            &windows,
            now + DECORATE_KEEP,
            &mut keep_title,
            &mut keep_icons,
            &icons_in_place
        ));
        // …а после неё следить больше нечему
        assert!(job.step(
            &windows,
            now + DECORATE_KEEP + Duration::from_secs(1),
            &mut keep_title,
            &mut keep_icons,
            &icons_in_place
        ));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn watch_job_that_never_saw_the_window_reports_missing() {
        let (mut job, rx) = watch_job(100, "Ник — Класс", Duration::from_millis(1));
        let windows = [client_window(2, 200, "Чужое окно")];
        let now = Instant::now() + Duration::from_secs(5);
        assert!(
            job.step(&windows, now, &mut |_, _| Ok(()), &mut |_| Ok(()), &|_| {
                true
            })
        );
        assert_eq!(rx.try_recv().unwrap(), (Decorated::Missing, 0));
    }

    #[test]
    fn watch_job_that_saw_the_window_reports_failed_after_the_deadline() {
        // Окно было, но заголовок так и не совпал (игра переписывает его при загрузке)
        let (mut job, rx) = watch_job(100, "Ник — Класс", DECORATE_WAIT);
        let windows = [client_window(1, 100, "Perfect World")];
        let start = Instant::now();
        assert!(!job.step(
            &windows,
            start,
            &mut |_, _| Ok(()),
            &mut |_| Ok(()),
            &|_| true
        ));
        assert!(rx.try_recv().is_err()); // пока срок не вышел, итог не сообщаем
        assert!(job.step(
            &windows,
            start + DECORATE_WAIT + Duration::from_secs(1),
            &mut |_, _| Ok(()),
            &mut |_| Ok(()),
            &|_| true
        ));
        assert_eq!(rx.try_recv().unwrap(), (Decorated::Failed, 0));
    }

    #[test]
    fn a_window_we_cannot_reach_ends_the_watching_with_denied() {
        let (mut job, rx) = watch_job(100, "Ник — Класс", DECORATE_WAIT);
        let windows = [client_window(1, 100, "Perfect World")];
        assert!(job.step(
            &windows,
            Instant::now(),
            &mut |_, _| Err(ERROR_ACCESS_DENIED),
            &mut |_| Ok(()),
            &|_| true
        ));
        assert_eq!(
            rx.try_recv().unwrap(),
            (Decorated::Denied, ERROR_ACCESS_DENIED)
        );
    }

    #[test]
    fn other_errors_are_remembered_but_do_not_stop() {
        let mut progress = DecorateProgress::default();
        let denied = decorate_step(
            &mut progress,
            &[client_window(1, 100, "Perfect World")],
            100,
            "Ник — Класс",
            &mut |_, _| Err(WINDOW_TIMEOUT),
            &mut |_| Ok(()),
            &|_| false,
        );
        assert_eq!(denied, None);
        assert_eq!(progress.last_error, WINDOW_TIMEOUT);
    }

    #[test]
    fn a_busy_window_is_skipped_for_one_pass_so_others_are_not_starved() {
        // Окно игры не ответило: в этом проходе мы его не трогаем вовсе — ни заголовка,
        // ни значка. Наблюдатель один на все запуски, и не отвечающее окно иначе съедало бы
        // таймауты на каждом проходе и задерживало подпись всех остальных.
        let mut progress = DecorateProgress::default();
        let windows = [client_window(1, 100, "Perfect World")];
        let step = |progress: &mut DecorateProgress| {
            let mut titled: Vec<usize> = Vec::new();
            decorate_step(
                progress,
                &windows,
                100,
                "Ник — Класс",
                &mut |hwnd, _| {
                    titled.push(hwnd);
                    Err(WINDOW_TIMEOUT)
                },
                &mut |_| Ok(()),
                &|_| true,
            );
            titled
        };

        // Первый проход: окно ещё пробуем — оно только что появилось
        assert_eq!(step(&mut progress), vec![1]);
        // Второй проход: помечено занятым, к нему не обращаемся вообще
        assert_eq!(step(&mut progress), Vec::<usize>::new());
        // Третий: снова пробуем — окно к этому времени могло освободиться
        assert_eq!(step(&mut progress), vec![1]);
    }

    #[test]
    fn skip_applies_per_window_and_does_not_hide_a_recovered_one() {
        // Занятым было только одно окно из трёх: остальные подписываются как обычно.
        // pid у всех один — это окна одного клиента игры, как и в настоящем запуске.
        let mut progress = DecorateProgress::default();
        let windows = [
            client_window(1, 100, "Perfect World"),
            client_window(2, 100, "Perfect World"),
            client_window(3, 100, "Perfect World"),
        ];
        let mut touched: Vec<usize> = Vec::new();
        let run = |progress: &mut DecorateProgress, touched: &mut Vec<usize>| {
            decorate_step(
                progress,
                &windows,
                100,
                "Ник — Класс",
                &mut |hwnd, _| {
                    touched.push(hwnd);
                    if hwnd == 1 {
                        Err(WINDOW_TIMEOUT)
                    } else {
                        Ok(())
                    }
                },
                &mut |_| Ok(()),
                &|_| true,
            )
        };
        run(&mut progress, &mut touched);
        touched.clear();
        run(&mut progress, &mut touched);
        assert_eq!(touched, vec![2, 3]);
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
    fn picker_output_is_a_single_path() {
        assert_eq!(parse_picker_output(""), None);
        assert_eq!(parse_picker_output("\r\n"), None);
        assert_eq!(
            parse_picker_output("\u{feff}D:\\GC 2\\GameCenter.exe\r\n").as_deref(),
            Some("D:\\GC 2\\GameCenter.exe")
        );
    }

    #[test]
    fn picker_filter_lists_both_launchers_only_when_kind_is_unspecified() {
        // С указанным типом фильтр показывает только его: из окна «Добавить GameCenter»
        // нельзя случайно добавить AstrumPlay и наоборот.
        let gc = picker_script(Some("gamecenter"));
        assert!(gc.contains("'GameCenter.exe|GameCenter.exe|"), "{gc}");
        assert!(!gc.contains("AstrumPlay"), "{gc}");

        let astrum = picker_script(Some("astrum"));
        assert!(
            astrum.contains("'AstrumPlay.exe|AstrumPlay.exe|"),
            "{astrum}"
        );
        assert!(!astrum.contains("GameCenter"), "{astrum}");

        // Без типа — оба: так «Обзор…» из карточки персонажа работает с любым лаунчером.
        let both = picker_script(None);
        assert!(both.contains("GameCenter.exe;AstrumPlay.exe"), "{both}");
        assert!(
            !both.contains("__TITLE__") && !both.contains("__FILTER__"),
            "{both}"
        );
    }

    #[test]
    fn picked_file_is_recognised_by_name_when_kind_is_unspecified() {
        let dir = std::env::temp_dir().join(format!("tf-pick-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let gc = dir.join("GameCenter.exe");
        let ap = dir.join("AstrumPlay.exe");
        let txt = dir.join("notepad.exe");
        std::fs::write(&gc, b"").unwrap();
        std::fs::write(&ap, b"").unwrap();
        std::fs::write(&txt, b"").unwrap();

        // Без типа: по имени файла — GameCenter.exe и AstrumPlay.exe оба проходят,
        // посторонняя программа нет.
        assert_eq!(resolve_picked(gc.to_str().unwrap(), None).unwrap(), gc);
        assert_eq!(resolve_picked(ap.to_str().unwrap(), None).unwrap(), ap);
        assert!(resolve_picked(txt.to_str().unwrap(), None).is_err());

        // С указанным типом чужой лаунчер не проходит: пункт «Добавить GameCenter»
        // не должен принять AstrumPlay.exe.
        assert!(resolve_picked(ap.to_str().unwrap(), Some("gamecenter")).is_err());
        assert!(resolve_picked(gc.to_str().unwrap(), Some("astrum")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clients_are_recognised_by_image_name_prefix() {
        assert!(is_client_image("elementclient_64.exe"));
        assert!(is_client_image("elementclient.exe"));
        // Регистр не важен: `tasklist` тоже сравнивал без учёта регистра
        assert!(is_client_image("ElementClient_64.exe"));
        // Совпадение по началу имени, а не по вхождению (как фильтр `elementclient*`)
        assert!(is_client_image("elementclient"));
        assert!(!is_client_image("GameCenter.exe"));
        assert!(!is_client_image("мой elementclient.exe"));
        assert!(!is_client_image(""));
    }

    #[test]
    fn gamecenters_are_recognised_by_image_name() {
        let name = |n: &str| n.eq_ignore_ascii_case(GAMECENTER_EXE);
        assert!(name("GameCenter.exe"));
        assert!(name("gamecenter.EXE"));
        assert!(!name("GameCenterApi.exe"));
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

    const INI: &str = "[UMS]\r\ngamecenter4=1916\r\n\r\n[Main]\r\nLang=ru\r\nMyComUserLogin=old@example.com\r\nMyComUserUid=111\r\nCurrentUserNick=Dred\r\nMyComUserMagic2=OLDTOKEN\r\nForm_State=0\r\n\r\n[Chrome]\r\nCacheVersion=2\r\n";

    #[test]
    fn reads_account_keys() {
        assert_eq!(ini_get(INI, "CurrentUserNick").as_deref(), Some("Dred"));
        assert_eq!(ini_get(INI, "mycomusermagic2").as_deref(), Some("OLDTOKEN"));
        assert_eq!(ini_get(INI, "Nope"), None);
    }

    #[test]
    fn account_is_read_as_a_whole_set() {
        // Аккаунт опознаётся по uid, поэтому в наборе обязаны быть все ключи, а не один токен
        let pairs = read_account(INI).unwrap();
        assert_eq!(pairs.len(), ACCOUNT_KEYS.len());
        assert!(pairs.iter().any(|(k, v)| k == "MyComUserUid" && v == "111"));
        assert!(pairs.iter().any(|(k, v)| k == LOGIN_KEY && v == "OLDTOKEN"));
        assert_eq!(read_account("[Main]\r\nMyComUserMagic2=\r\n"), None);
        assert_eq!(read_account("[Main]\r\nLang=ru\r\n"), None);
    }

    #[test]
    fn old_stored_login_is_refused_not_half_written() {
        // Старая запись хранилища — один токен без «=». Подставить её нельзя: без uid лаунчер
        // оставит uid прошлого аккаунта и откроет игру под ним. Поэтому такая запись — ошибка.
        let err = stored_account("OLDTOKEN").unwrap_err();
        assert!(
            err.contains("Запомнить вход"),
            "сообщение должно говорить, что делать: {}",
            err
        );
        // Новая запись — набор ключей: он и подставляется как есть
        let pairs = read_account(INI).unwrap();
        assert_eq!(stored_account(&pairs_to_text(&pairs)).unwrap(), pairs);
    }

    #[test]
    fn replaces_keys_and_keeps_everything_else() {
        let out = ini_set(
            &ini_set(INI, LOGIN_KEY, "NEWTOKEN"),
            "CurrentUserNick",
            "Twin",
        );
        assert_eq!(ini_get(&out, LOGIN_KEY).as_deref(), Some("NEWTOKEN"));
        assert_eq!(ini_get(&out, "CurrentUserNick").as_deref(), Some("Twin"));
        let expected = INI
            .replace("OLDTOKEN", "NEWTOKEN")
            .replace("CurrentUserNick=Dred", "CurrentUserNick=Twin");
        assert_eq!(out, expected); // остальные строки и CRLF не изменились
    }

    #[test]
    fn inserts_missing_key_after_main_section() {
        let ini = "[Main]\nLang=ru\n[Chrome]\nCacheVersion=2\n";
        let out = ini_set(ini, LOGIN_KEY, "T1");
        assert_eq!(
            out,
            "[Main]\nMyComUserMagic2=T1\nLang=ru\n[Chrome]\nCacheVersion=2\n"
        );
        assert_eq!(ini_set("A=1", LOGIN_KEY, "T1"), "A=1\nMyComUserMagic2=T1\n");
    }

    #[test]
    fn ini_bytes_survive_roundtrip() {
        // cp1251: «Дред» — байты C4 F0 E5 E4; файл не должен измениться вне правки
        let mut raw = b"[Main]\r\nCurrentUserName=".to_vec();
        raw.extend_from_slice(&[0xC4, 0xF0, 0xE5, 0xE4]);
        raw.extend_from_slice(b"\r\nMyComUserMagic2=OLD\r\n");
        let (text, enc) = decode_ini(&raw);
        let out = encode_ini(&ini_set(&text, LOGIN_KEY, "NEW"), &enc);
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
        assert_eq!(
            ini_get(&decoded, "CurrentUserNick").as_deref(),
            Some("Дред")
        );
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
    fn not_ascii_nick_goes_only_into_utf16_ini() {
        // Ник бывает кириллицей. В UTF-16 файл он пишется как есть, в однобайтовый — нельзя:
        // он бы испортил файл. Такое значение пропускаем, а не заменяем мусором.
        let bytes = IniEncoding::Bytes;
        assert!(!writable_ini_value("Сик", &bytes));
        assert!(writable_ini_value("Sik", &bytes));
        assert!(writable_ini_value("Сик", &IniEncoding::Utf16Le));
        assert!(!writable_ini_value("a\r\nb=c", &IniEncoding::Utf16Le));
        assert!(!writable_ini_value("", &IniEncoding::Utf16Le));
    }

    #[test]
    fn write_account_rewrites_ini_next_to_exe() {
        let dir = std::env::temp_dir().join(format!("tf-gc-switch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(GAMECENTER_EXE);
        std::fs::write(&exe, b"").unwrap();
        let ini = dir.join(INI_NAME);
        std::fs::write(&ini, INI).unwrap();

        // Новый вход: подставляются все ключи, включая uid прошлого аккаунта
        let pairs = stored_account(&pairs_to_text(&[
            ("MyComUserLogin".to_string(), "new@example.com".to_string()),
            ("MyComUserUid".to_string(), "222".to_string()),
            ("CurrentUserNick".to_string(), "Twin".to_string()),
            (LOGIN_KEY.to_string(), "NEWTOKEN".to_string()),
        ]))
        .unwrap();
        write_account(&ini, &pairs).unwrap();
        let after = std::fs::read_to_string(&ini).unwrap();
        assert_eq!(ini_get(&after, LOGIN_KEY).as_deref(), Some("NEWTOKEN"));
        assert_eq!(ini_get(&after, "CurrentUserNick").as_deref(), Some("Twin"));
        assert_eq!(
            ini_get(&after, "MyComUserUid").as_deref(),
            Some("222"),
            "uid прошлого аккаунта обязан смениться, иначе игра выйдет под ним"
        );
        assert_eq!(
            ini_get(&after, "MyComUserLogin").as_deref(),
            Some("new@example.com")
        );

        // исходный файл сохранён рядом один раз
        let backup = std::fs::read_to_string(dir.join("GameCenter.ini.tvinoferma-backup")).unwrap();
        assert_eq!(backup, INI);
        write_account(
            &ini,
            &stored_account(&pairs_to_text(&[(
                LOGIN_KEY.to_string(),
                "OTHER".to_string(),
            )]))
            .unwrap(),
        )
        .unwrap();
        let backup2 =
            std::fs::read_to_string(dir.join("GameCenter.ini.tvinoferma-backup")).unwrap();
        assert_eq!(backup2, INI); // повторная подмена копию не затирает
        let _ = std::fs::remove_dir_all(dir);
    }
}

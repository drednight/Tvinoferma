//! Всплывающие уведомления Windows.
//!
//! Зачем своя команда, если есть `tauri-plugin-notification`: плагин на Windows молча пропускает
//! показ, когда приложение не зарегистрировано как источник уведомлений. Установленная версия
//! получает регистрацию от ярлыка установщика, а сборка для разработки (`cargo run`,
//! `npm run tauri dev`) — нет: всплывающее сообщение не появляется и об ошибке ничего не сообщает.
//!
//! Здесь мы сами:
//! 1) записываем идентификатор приложения в `HKCU\Software\Classes\AppUserModelId\<id>` с именем
//!    и значком — после этого Windows считает приложение источником уведомлений;
//! 2) показываем уведомление и возвращаем причину отказа, если показ не удался.
//!
//! Идентификатор тот же, что у установленной версии (`tauri.conf.json` → `identifier`), поэтому
//! список уведомлений и переключатели в параметрах Windows остаются общими для обеих сборок.

use tauri::Runtime;

/// Идентификатор приложения — совпадает с `identifier` в tauri.conf.json.
pub const APP_ID: &str = "com.tvinoferma.desktop";
/// Имя приложения в уведомлениях.
pub const APP_NAME: &str = "Твиноферма";

/// Проверка готовности уведомлений: возвращает причину, если показывать нельзя.
#[tauri::command]
pub fn tf_notify_check() -> Option<String> {
    #[cfg(windows)]
    {
        match registered() {
            Ok(()) => None,
            Err(e) => Some(format!(
                "Windows не считает приложение источником уведомлений ({e}). Проверьте: Параметры → Система → Уведомления → «Твиноферма» включено, и не включён режим «Не беспокоить»."
            )),
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Показать системное уведомление. Возвращает ошибку с причиной, если показать не удалось.
#[tauri::command]
pub async fn tf_notify<R: Runtime>(
    app: tauri::AppHandle<R>,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    #[cfg(windows)]
    if let Err(e) = registered() {
        // Регистрация — условие показа: без неё Windows отбросит уведомление
        return Err(format!("не удалось зарегистрировать приложение в Windows: {e}"));
    }

    app.notification()
        .builder()
        .title(if title.is_empty() { APP_NAME.to_string() } else { title })
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Записать идентификатор приложения и его имя в `HKCU\Software\Classes\AppUserModelId`.
/// Идемпотентно: повторный вызов просто перезаписывает те же значения.
#[cfg(windows)]
fn registered() -> Result<(), String> {
    use windows::core::w;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
    };

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let subkey = wide(&format!("Software\\Classes\\AppUserModelId\\{APP_ID}"));
    let mut key = HKEY::default();

    // RegCreateKeyW создаёт ключ вместе с родительскими (Classes, AppUserModelId — есть в любой Windows)
    let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, windows::core::PCWSTR(subkey.as_ptr()), &mut key) };
    if status != ERROR_SUCCESS {
        return Err(format!("RegCreateKeyW: код {}", status.0));
    }

    let set = |key: HKEY, name: windows::core::PCWSTR, value: &str| -> Result<(), String> {
        let data = value.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let bytes = unsafe {
            std::slice::from_raw_parts(data.as_ptr() as *const u8, std::mem::size_of_val(&data[..]))
        };
        let status = unsafe { RegSetValueExW(key, name, None, REG_SZ, Some(bytes)) };
        if status != ERROR_SUCCESS {
            return Err(format!("RegSetValueExW: код {}", status.0));
        }
        Ok(())
    };

    // DisplayName — то, что видно в списке уведомлений; IconUri — значок приложения.
    // Пустой значок не записываем: пустое значение в реестре дало бы белый квадрат вместо иконки.
    let icon = icon_uri();
    let result = set(key, w!("DisplayName"), APP_NAME).and_then(|_| {
        if icon.is_empty() {
            Ok(())
        } else {
            set(key, w!("IconUri"), &icon)
        }
    });

    unsafe { let _ = RegCloseKey(key); }
    result
}

/// Путь к значку приложения: установленная версия или папка рядом с исполняемым файлом.
#[cfg(windows)]
fn icon_uri() -> String {
    if let Ok(exe) = tauri::utils::platform::current_exe() {
        if let Some(dir) = exe.parent() {
            // В сборке рядом с exe лежит `tvinoferma.ico`; в dev-запуске иконок нет —
            // тогда лучше оставить поле пустым, чем показать битый значок
            for name in ["tvinoferma.ico", "icon.ico"] {
                let ico = dir.join(name);
                if ico.exists() {
                    return ico.display().to_string();
                }
            }
        }
    }
    String::new()
}

#[cfg(not(windows))]
fn registered() -> Result<(), String> {
    Ok(())
}

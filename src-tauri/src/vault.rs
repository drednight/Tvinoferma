//! Запись «Запомнить вход» и других секретов в хранилище ОС с запасным
//! способом для Windows.
//!
//! `keyring` на Windows всегда пишет учётные данные с признаком «роуминг»
//! (`CRED_PERSIST_ENTERPRISE`). У части пользователей такая запись не проходит:
//! `CredWriteW` отвечает `ERROR_NO_SUCH_LOGON_SESSION` (1312) — в этой сессии
//! входа нет своего набора учётных данных (известная особенность Windows
//! Credential Manager, например при нестандартной сессии или запуске до полного
//! входа пользователя).
//!
//! Чтение (`CredReadW`) и удаление (`CredDeleteW`) от признака persistence не
//! зависят и находят запись только по имени. Поэтому запасная запись делается
//! с тем же именем (`{пользователь}.{сервис}`, как строит его сам `keyring`),
//! но с признаком «только этот компьютер» (`CRED_PERSIST_LOCAL_MACHINE`) —
//! последующее чтение и удаление через `keyring` работают без изменений.
//! Формат содержимого — как у `keyring`: строка в UTF-16LE без нулевого
//! терминатора.
//!
//! На системах, отличных от Windows, запасной способ не нужен: любая ошибка
//! `keyring` возвращается как есть.

use keyring::Entry;

/// Пишет `value` в хранилище ОС для записи `entry`.
///
/// Сначала — обычный путь `keyring`. Если на Windows он упёрся в невозможность
/// записи (`NoStorageAccess`, `PlatformFailure` — сюда попадает и ошибка 1312),
/// запись повторяется напрямую через `CredWriteW` с признаком «только этот
/// компьютер». Прочие ошибки `keyring` возвращаются как есть.
pub fn set_password(entry: &Entry, service: &str, user: &str, value: &str) -> Result<(), String> {
    match entry.set_password(value) {
        Ok(()) => Ok(()),
        Err(e) => fallback_on_failure(e, service, user, value),
    }
}

/// Что делать, если обычная запись не прошла.
#[cfg(windows)]
fn fallback_on_failure(
    err: keyring::Error,
    service: &str,
    user: &str,
    value: &str,
) -> Result<(), String> {
    match err {
        // Обе группы — «хранилище недоступно / не разрешает запись»: сюда из
        // `CredWriteW` попадает в том числе ERROR_NO_SUCH_LOGON_SESSION (1312).
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            match win::write_local_machine(&cred_target_name(service, user), user, value) {
                Ok(()) => Ok(()),
                Err(msg) => Err(format!("{msg} (обычный способ тоже не сработал: {err})")),
            }
        }
        other => Err(other.to_string()),
    }
}

#[cfg(not(windows))]
fn fallback_on_failure(
    err: keyring::Error,
    _service: &str,
    _user: &str,
    _value: &str,
) -> Result<(), String> {
    Err(err.to_string())
}

/// Имя записи в Credential Manager, каким его строит `keyring` для
/// `Entry::new(service, user)`: `{пользователь}.{сервис}`. Windows ищет запись
/// только по этому имени, поэтому чтение и удаление через `keyring` видят и
/// запасную запись.
fn cred_target_name(service: &str, user: &str) -> String {
    format!("{user}.{service}")
}

#[cfg(test)]
mod tests {
    use super::cred_target_name;

    #[test]
    fn target_name_matches_keyring() {
        assert_eq!(
            cred_target_name("com.tvinoferma.desktop", "gc-magic:1"),
            "gc-magic:1.com.tvinoferma.desktop"
        );
    }
}

#[cfg(windows)]
mod win {
    use std::ptr;

    use windows::core::PWSTR;
    use windows::Win32::Foundation::{
        GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, ERROR_NO_SUCH_LOGON_SESSION,
        FILETIME, WIN32_ERROR,
    };
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_MAX_CREDENTIAL_BLOB_SIZE,
        CRED_MAX_GENERIC_TARGET_NAME_LENGTH, CRED_MAX_STRING_LENGTH, CRED_MAX_USERNAME_LENGTH,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    /// Строка в том виде, в каком `keyring` кладёт её в blob записи: UTF-16LE
    /// без нулевого терминатора (ср. `to_wstr_no_null` в windows.rs keyring).
    fn blob_utf16le(value: &str) -> Vec<u8> {
        value.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    /// Пишет generic-запись напрямую через `CredWriteW` с признаком «только
    /// этот компьютер». Текст ошибки — готовый к показу пользователю.
    pub(super) fn write_local_machine(
        target_name: &str,
        username: &str,
        value: &str,
    ) -> Result<(), String> {
        // Те же лимиты, что проверяет keyring перед записью — известные
        // константы Credential Manager, чтобы отклонять раньше Windows.
        if username.chars().count() > CRED_MAX_USERNAME_LENGTH as usize {
            return Err(format!(
                "имя учётной записи длиннее лимита Credential Manager ({} символов)",
                CRED_MAX_USERNAME_LENGTH
            ));
        }
        if target_name.chars().count() > CRED_MAX_GENERIC_TARGET_NAME_LENGTH as usize {
            return Err(format!(
                "имя записи длиннее лимита Credential Manager ({} символов)",
                CRED_MAX_GENERIC_TARGET_NAME_LENGTH
            ));
        }

        // Комментарий виден пользователю в Менеджере учётных данных, это тоже
        // строка с лимитом.
        const COMMENT: &str = "Твиноферма: запомнить вход (локальная запись)";
        if COMMENT.chars().count() > CRED_MAX_STRING_LENGTH as usize {
            return Err(format!(
                "комментарий записи длиннее лимита Credential Manager ({} символов)",
                CRED_MAX_STRING_LENGTH
            ));
        }

        let blob = blob_utf16le(value);
        if blob.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
            return Err(format!(
                "значение не помещается в Credential Manager: {} байт при лимите {}",
                blob.len(),
                CRED_MAX_CREDENTIAL_BLOB_SIZE
            ));
        }

        // Строки для Windows — null-terminated UTF-16. Векторы живут до вызова.
        let mut username_w: Vec<u16> = username.encode_utf16().collect();
        username_w.push(0);
        let mut target_w: Vec<u16> = target_name.encode_utf16().collect();
        target_w.push(0);
        let mut comment_w: Vec<u16> = COMMENT.encode_utf16().collect();
        comment_w.push(0);

        // `LastWritten` проставляет сама Windows при записи; на входе значение не важно.
        let credential = CREDENTIALW {
            Flags: CRED_FLAGS::default(),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR::from_raw(target_w.as_mut_ptr()),
            Comment: PWSTR::from_raw(comment_w.as_mut_ptr()),
            LastWritten: FILETIME::default(),
            CredentialBlobSize: blob.len() as u32,
            // `CredWriteW` копирует содержимое, менять его не будет.
            CredentialBlob: blob.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: ptr::null_mut(),
            TargetAlias: PWSTR::null(),
            UserName: PWSTR::from_raw(username_w.as_mut_ptr()),
        };

        unsafe {
            if let Err(e) = CredWriteW(&credential, 0) {
                // `CredWriteW` из windows-обёртки превращает ошибку в
                // `windows::core::Error`; пользователю нужен код от Windows.
                let code = GetLastError();
                let hint = code_hint(code);
                let hint = if hint.is_empty() {
                    String::new()
                } else {
                    format!(": {hint}")
                };
                return Err(format!(
                    "Запасная запись входа не удалась: {}. Windows вернула код {}{}",
                    e, code.0, hint
                ));
            }
        }
        Ok(())
    }

    /// Расшифровка кода Windows простыми словами для сообщения пользователю.
    fn code_hint(code: WIN32_ERROR) -> String {
        match code {
            ERROR_NO_SUCH_LOGON_SESSION => {
                "В этой сессии входа Windows не нашла своего набора учётных данных; \
                 попробуйте перезапустить приложение и сохранить вход снова"
                    .to_string()
            }
            ERROR_ACCESS_DENIED => "Windows запретила запись в хранилище паролей".to_string(),
            ERROR_INVALID_PARAMETER => "Windows отклонила данные записи".to_string(),
            _ => String::new(),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{blob_utf16le, code_hint};
        use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_NO_SUCH_LOGON_SESSION};

        #[test]
        fn blob_matches_keyring_format() {
            // ASCII — по два байта на символ, порядок LE.
            assert_eq!(blob_utf16le("ab"), vec![0x61, 0x00, 0x62, 0x00]);
            // Пустая строка — пустой blob.
            assert_eq!(blob_utf16le(""), Vec::<u8>::new());
            // Кириллица: U+044F «я» → 4F 04.
            assert_eq!(blob_utf16le("я"), vec![0x4F, 0x04]);
            // Без нулевого терминатора: длины равны 2 байта на символ.
            assert_eq!(blob_utf16le("мёд").len(), 3 * 2);
        }

        #[test]
        fn code_hints_are_friendly() {
            // 1312 — та самая ошибка пользователя: подсказка про сессию входа.
            assert!(code_hint(ERROR_NO_SUCH_LOGON_SESSION).contains("сессии входа"));
            assert!(code_hint(ERROR_ACCESS_DENIED).contains("запретила"));
            // Неизвестный код — без лишней отсебятины.
            assert!(code_hint(windows::Win32::Foundation::WIN32_ERROR(1)).is_empty());
        }
    }
}

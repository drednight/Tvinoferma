//! Имя ярлыка в меню «Пуск».
//!
//! Установщик называет ярлык по `productName`, то есть «Tvinoferma». Пользователь же ищет
//! приложение и по-русски — «Твиноферма», и Windows Search в этом случае ничего не находит.
//!
//! Почему переименование, а не настройка установщика: имя ярлыка в MSI берётся из `productName`,
//! а его смена изменила бы папку установки и имя исполняемого файла — появилась бы кириллица
//! в пути и вторая копия приложения рядом (так уже случилось с версией 0.2.0). Переименование
//! ярлыка решает задачу поиска, ничего не меняя в установке.
//!
//! Регистрация выполняется при запуске и не критична для работы: если прав на папку меню «Пуск»
//! нет, просто ничего не происходит — приложение ищется ещё и по `DisplayName` (см. `notify.rs`).

use std::path::{Path, PathBuf};

/// Имя ярлыка, которое создаёт установщик.
pub const LATIN_NAME: &str = "Tvinoferma.lnk";
/// Имя ярлыка, которое должно быть: пользователь ищет приложение по-русски.
pub const RUSSIAN_NAME: &str = "Твиноферма.lnk";

/// Что делать с ярлыками, которые нашлись в меню «Пуск».
///
/// Отдельная чистая функция: решение не зависит от файловой системы, поэтому его можно проверить
/// тестами, а уже потом применять к диску.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ShortcutAction {
    /// Есть только латинский ярлык — переименовать в русский
    Rename,
    /// Есть оба (например, после обновления установщик снова создал латинский) — латинский лишний
    RemoveLatin,
    /// Делать нечего: русского нет, но и латинского тоже, либо уже всё правильно
    Nothing,
}

/// Решение по наличию ярлыков.
pub fn decide(has_latin: bool, has_russian: bool) -> ShortcutAction {
    match (has_latin, has_russian) {
        (true, false) => ShortcutAction::Rename,
        (true, true) => ShortcutAction::RemoveLatin,
        _ => ShortcutAction::Nothing,
    }
}

/// Папки меню «Пуск»: общая для всех пользователей и личная.
fn start_menu_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(common) = std::env::var("ProgramData") {
        out.push(Path::new(&common).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Ok(roaming) = std::env::var("APPDATA") {
        out.push(Path::new(&roaming).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    out
}

/// Найти ярлыки с нужным именем в папке меню «Пуск» (на пару уровней вглубь:
/// установщик кладёт ярлык в подпапку с именем приложения).
fn find(dir: &Path, name: &str, depth: usize, found: &mut Vec<PathBuf>) {
    let Ok(list) = std::fs::read_dir(dir) else { return };
    for entry in list.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                find(&path, name, depth - 1, found);
            }
        } else if path.file_name().is_some_and(|n| n.eq_ignore_ascii_case(name)) {
            found.push(path);
        }
    }
}

/// Привести имя ярлыка к русскому. Best-effort: ошибки не поднимаются наружу.
pub fn ensure_russian_shortcut() {
    for dir in start_menu_dirs() {
        if !dir.is_dir() {
            continue;
        }
        let mut latin = Vec::new();
        let mut russian = Vec::new();
        find(&dir, LATIN_NAME, 2, &mut latin);
        find(&dir, RUSSIAN_NAME, 2, &mut russian);

        for path in &latin {
            match decide(true, !russian.is_empty()) {
                ShortcutAction::Rename => {
                    let target = path.with_file_name(RUSSIAN_NAME);
                    match std::fs::rename(path, &target) {
                        Ok(()) => println!("[SHORTCUT] ярлык переименован: {}", target.display()),
                        // Прав на общую папку может не быть — это не ошибка приложения
                        Err(e) => println!("[SHORTCUT] не удалось переименовать ярлык: {e}"),
                    }
                }
                ShortcutAction::RemoveLatin => match std::fs::remove_file(path) {
                    Ok(()) => println!("[SHORTCUT] лишний латинский ярлык удалён: {}", path.display()),
                    Err(e) => println!("[SHORTCUT] не удалось удалить лишний ярлык: {e}"),
                },
                ShortcutAction::Nothing => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_latin_shortcut_is_renamed() {
        assert_eq!(decide(true, false), ShortcutAction::Rename);
    }

    #[test]
    fn both_shortcuts_leave_the_latin_one_removed() {
        // После обновления установщик снова создаёт латинский ярлык — он лишний
        assert_eq!(decide(true, true), ShortcutAction::RemoveLatin);
    }

    #[test]
    fn russian_shortcut_needs_nothing() {
        assert_eq!(decide(false, true), ShortcutAction::Nothing);
    }

    #[test]
    fn no_shortcuts_at_all_needs_nothing() {
        assert_eq!(decide(false, false), ShortcutAction::Nothing);
    }

    #[test]
    fn names_differ_and_carry_both_spellings() {
        // Имя ярлыка — только русское; латиница видна в DisplayName (notify.rs)
        assert!(RUSSIAN_NAME.contains("Твиноферма"));
        assert!(LATIN_NAME.contains("Tvinoferma"));
        assert_ne!(LATIN_NAME, RUSSIAN_NAME);
    }
}

//! Метка запущенного экземпляра программы.
//!
//! Зачем она нужна: тестовая сборка всегда стартует от администратора, и перед повышением
//! прав надо понять, запущен ли уже экземпляр этой же программы и есть ли у него права.
//! Плагин «один экземпляр» этого не различает — он просто показывает окно, а окно копии
//! с правами администратора не примет сообщение от обычного процесса: Windows запрещает
//! сообщения снизу вверх (UIPI). Без метки второй запуск тестовой сборки выглядел бы так:
//! запрос UAC, тишина и старое окно в трее.
//!
//! Метка — обычный файл во временном каталоге: в нём PID и путь к программе. Путь нужен
//! для проверки, что PID не переиспользован Windows'ом для постороннего процесса.

use std::path::PathBuf;

/// Метка запущенного экземпляра.
pub struct Marker {
    /// Идентификатор процесса.
    pub pid: u32,
    /// Полный путь к исполняемому файлу программы.
    pub exe: String,
}

/// Короткий хеш строки: имя файла метки должно отличаться у разных копий программы.
///
/// FNV-1a: нам не нужно криптографическое качество, только разные имена файлов.
fn short_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Путь к файлу-метке текущей программы (во временном каталоге).
pub fn marker_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = format!(
        "tvinoferma-instance-{}.marker",
        short_hash(&exe.to_string_lossy())
    );
    Some(std::env::temp_dir().join(name))
}

/// Записать метку текущего процесса.
pub fn write_marker() {
    let Some(path) = marker_path() else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let text = format!("{}\n{}", std::process::id(), exe.display());
    let _ = std::fs::write(path, text);
}

/// Прочитать метку. `None` — метки нет или она не читается.
pub fn read_marker() -> Option<Marker> {
    let path = marker_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    let pid = lines.next()?.trim().parse::<u32>().ok()?;
    let exe = lines.next().unwrap_or_default().trim().to_string();
    Some(Marker { pid, exe })
}

/// Убрать метку: процесс закончил работу.
pub fn clear_marker() {
    if let Some(path) = marker_path() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_differs_for_different_paths() {
        assert_eq!(
            short_hash("C:\\a\\tvinoferma.exe"),
            short_hash("C:\\a\\tvinoferma.exe")
        );
        assert_ne!(
            short_hash("C:\\a\\tvinoferma.exe"),
            short_hash("C:\\b\\tvinoferma.exe")
        );
        assert_eq!(short_hash("").len(), 16);
    }

    #[test]
    fn marker_roundtrips_through_the_file() {
        let path = marker_path().expect("путь к метке");
        let _ = std::fs::remove_file(&path);
        write_marker();
        let marker = read_marker().expect("метка прочитана");
        assert_eq!(marker.pid, std::process::id());
        assert!(!marker.exe.is_empty());
        clear_marker();
        // После удаления метки читать нечего: тест не должен зависеть от других процессов.
        assert!(read_marker().is_none());
    }
}

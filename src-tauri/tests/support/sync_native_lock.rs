//! Отключённая тестовая модель native-lock; приложение этот файл не использует.
//!
//! На Linux она использует advisory flock через std::fs::File::try_lock (Rust >= 1.89).
//! Это один постоянный пустой файл на каталог состояния. Его нельзя удалять на release:
//! иначе разные процессы могут заблокировать разные inode с одним именем. Все писатели
//! должны добровольно использовать тот же lock; внешние редакторы ему не подчиняются.
//! На других системах, включая Windows, модель намеренно сообщает Unsupported.
//!
//! Проверка inode обнаруживает уже произошедшую подмену файла на Linux, но не закрывает
//! TOCTOU между проверкой и дальнейшей записью. Она не защищает от переименования родителя,
//! произвольного вмешательства, непроверенной сетевой ФС, fsync или сбоев питания. Код не
//! интегрирован с обычным state, vault, factory reset, IPC или облачной синхронизацией.

use std::path::Path;

#[cfg(target_os = "linux")]
pub const LOCK_FILE_NAME: &str = ".tvinoferma-cloud-sync.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockError {
    #[cfg(target_os = "linux")]
    Busy,
    #[cfg(target_os = "linux")]
    Unavailable,
    #[cfg(target_os = "linux")]
    UnsafeFile,
    #[cfg(not(target_os = "linux"))]
    Unsupported,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{LockError, Path, LOCK_FILE_NAME};
    use std::fs::{self, File, OpenOptions, TryLockError};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::path::PathBuf;

    // Linux O_NOFOLLOW: open не следует последнему symlink даже при гонке после проверки.
    const O_NOFOLLOW_LINUX: i32 = 0o400000;

    #[derive(Debug)]
    pub struct NativeSyncLock {
        file: File,
        path: PathBuf,
    }

    fn verify_file(file: &File, path: &Path) -> Result<(), LockError> {
        let opened = file.metadata().map_err(|_| LockError::UnsafeFile)?;
        let current = fs::symlink_metadata(path).map_err(|_| LockError::UnsafeFile)?;
        if !opened.file_type().is_file()
            || !current.file_type().is_file()
            || opened.len() != 0
            || current.len() != 0
            || opened.nlink() != 1
            || current.nlink() != 1
            || opened.dev() != current.dev()
            || opened.ino() != current.ino()
        {
            return Err(LockError::UnsafeFile);
        }
        Ok(())
    }

    impl NativeSyncLock {
        /// Неблокирующая попытка на едином постоянном файле каталога состояния.
        /// Ошибки не содержат путь или данные; fallback на отсутствие блокировки нет.
        pub fn try_acquire(state_dir: &Path) -> Result<Self, LockError> {
            let dir = fs::canonicalize(state_dir).map_err(|_| LockError::Unavailable)?;
            if !fs::metadata(&dir)
                .map_err(|_| LockError::Unavailable)?
                .is_dir()
            {
                return Err(LockError::Unavailable);
            }
            let path = dir.join(LOCK_FILE_NAME);
            match fs::symlink_metadata(&path) {
                Ok(meta) if !meta.file_type().is_file() || meta.len() != 0 || meta.nlink() != 1 => {
                    return Err(LockError::UnsafeFile);
                }
                Ok(_) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(LockError::Unavailable),
            }

            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(O_NOFOLLOW_LINUX)
                .open(&path)
                .map_err(|_| LockError::Unavailable)?;
            verify_file(&file, &path)?;
            match file.try_lock() {
                Ok(()) => {}
                Err(TryLockError::WouldBlock) => return Err(LockError::Busy),
                Err(TryLockError::Error(_)) => return Err(LockError::Unavailable),
            }
            verify_file(&file, &path)?;
            Ok(Self { file, path })
        }

        /// Проверяет путь и открытый inode; после возврата остаётся окно гонки.
        pub fn verify(&self) -> Result<(), LockError> {
            verify_file(&self.file, &self.path)
        }
    }
    // Drop закрывает File и освобождает flock. Пустой lock-файл намеренно остаётся.
}

#[cfg(target_os = "linux")]
pub use linux::NativeSyncLock;

#[cfg(not(target_os = "linux"))]
#[derive(Debug)]
pub struct NativeSyncLock;

#[cfg(not(target_os = "linux"))]
impl NativeSyncLock {
    pub fn try_acquire(_state_dir: &Path) -> Result<Self, LockError> {
        Err(LockError::Unsupported)
    }
}

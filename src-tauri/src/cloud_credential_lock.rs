//! Межпроцессная координация операций над экспериментальным хранилищем облака.
//!
//! На Windows используется постоянный пустой lock-файл и `share_mode(0)`.
//! Все участники должны добровольно брать тот же lock. Файл нельзя удалять при
//! release. Это не защита от неучаствующего процесса, подмены родительского
//! каталога, сетевой ФС или потери питания. На других платформах fallback на
//! отсутствие блокировки запрещён.

use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LockError {
    #[cfg(windows)]
    Unavailable,
    #[cfg(windows)]
    UnsafeFile,
    #[cfg(not(windows))]
    Unsupported,
}

#[cfg(windows)]
mod windows_lock {
    use super::{LockError, Path};
    use std::ffi::c_void;
    use std::fs::{self, File, OpenOptions};
    use std::mem::MaybeUninit;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;

    const LOCK_FILE: &str = ".tvinoferma-cloud-credentials.lock";
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_SHARE_READ_WRITE_DELETE: u32 = 0x0000_0007;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct FileInformation {
        attributes: u32,
        creation: FileTime,
        access: FileTime,
        write: FileTime,
        volume_serial: u32,
        size_high: u32,
        size_low: u32,
        link_count: u32,
        index_high: u32,
        index_low: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut c_void, info: *mut FileInformation) -> i32;
    }

    fn info(file: &File) -> Result<FileInformation, LockError> {
        let mut value = MaybeUninit::<FileInformation>::uninit();
        // Windows инициализирует структуру целиком при ненулевом результате.
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), value.as_mut_ptr()) };
        if ok == 0 {
            return Err(LockError::UnsafeFile);
        }
        let value = unsafe { value.assume_init() };
        if !file
            .metadata()
            .map_err(|_| LockError::UnsafeFile)?
            .file_type()
            .is_file()
            || value.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || value.link_count != 1
            || value.size_high != 0
            || value.size_low != 0
        {
            return Err(LockError::UnsafeFile);
        }
        Ok(value)
    }

    pub(crate) struct CredentialLock {
        file: File,
        path: PathBuf,
    }

    impl CredentialLock {
        pub(crate) fn try_acquire(app_dir: &Path) -> Result<Self, LockError> {
            fs::create_dir_all(app_dir).map_err(|_| LockError::Unavailable)?;
            let directory = fs::symlink_metadata(app_dir).map_err(|_| LockError::Unavailable)?;
            if !directory.file_type().is_dir()
                || directory.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(LockError::UnsafeFile);
            }
            let canonical = fs::canonicalize(app_dir).map_err(|_| LockError::Unavailable)?;
            let path = canonical.join(LOCK_FILE);
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                // Даже при гонке open не следует последнему reparse point.
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .share_mode(0)
                .open(&path)
                .map_err(|_| LockError::Unavailable)?;
            let lock = Self { file, path };
            lock.verify()?;
            Ok(lock)
        }

        /// Повторная проверка открытого объекта и имени. Не устраняет гонки при
        /// подмене родителя после проверки и не защищает от другого API.
        pub(crate) fn verify(&self) -> Result<(), LockError> {
            let opened = info(&self.file)?;
            // Нулевая запрошенная access mask позволяет запросить сведения о
            // файле, не ослабляя эксклюзивный share_mode основного дескриптора.
            let path_handle = OpenOptions::new()
                .read(true)
                .access_mode(0)
                .share_mode(FILE_SHARE_READ_WRITE_DELETE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&self.path)
                .map_err(|_| LockError::UnsafeFile)?;
            let current = info(&path_handle)?;
            if opened.volume_serial != current.volume_serial
                || opened.index_high != current.index_high
                || opened.index_low != current.index_low
            {
                return Err(LockError::UnsafeFile);
            }
            Ok(())
        }
    }
    // Drop закрывает handle; пустой файл остаётся постоянным.
}

#[cfg(windows)]
pub(crate) use windows_lock::CredentialLock;

#[cfg(not(windows))]
pub(crate) struct CredentialLock;

#[cfg(not(windows))]
impl CredentialLock {
    pub(crate) fn try_acquire(_app_dir: &Path) -> Result<Self, LockError> {
        Err(LockError::Unsupported)
    }

    pub(crate) fn verify(&self) -> Result<(), LockError> {
        Err(LockError::Unsupported)
    }
}

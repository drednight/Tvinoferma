//! Изолированные тесты модели блокировки. Никакие настоящие файлы приложения не открываются.
//! Можно отдельно запустить `rustc --edition=2021 --test tests/sync_native_lock.rs` из src-tauri.

#[path = "support/sync_native_lock.rs"]
mod sync_native_lock;

#[cfg(target_os = "linux")]
mod linux_tests {
    use super::sync_native_lock::{LockError, NativeSyncLock, LOCK_FILE_NAME};
    use std::fs::{self, File};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let base = std::env::temp_dir();
            for _ in 0..100 {
                let path = base.join(format!(
                    "tvinoferma-lock-test-{}-{}",
                    std::process::id(),
                    NEXT_DIR.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(_) => panic!("could not create test directory"),
                }
            }
            panic!("could not allocate a unique test directory")
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn lock_path(&self) -> PathBuf {
            self.0.join(LOCK_FILE_NAME)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct Holder {
        child: Child,
    }

    impl Holder {
        fn start(dir: &Path) -> Self {
            let mut child = Command::new(std::env::current_exe().expect("current test executable"))
                .arg("--exact")
                .arg("linux_tests::worker_hold_lock")
                .arg("--nocapture")
                .env("TF_NATIVE_LOCK_TEST_DIR", dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("test child process");
            let output = child.stdout.take().expect("test child stdout");
            let (sent, received) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(output).lines() {
                    match line {
                        Ok(line) if line.contains("TF_TEST_LOCK_HELD") => {
                            let _ = sent.send(());
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            });
            let holder = Self { child };
            // Таймаут не оставляет осиротевший процесс при ошибке или зависании fixture.
            received
                .recv_timeout(Duration::from_secs(10))
                .expect("test child failed to acquire lock");
            holder
        }

        fn release_and_wait(&mut self) {
            self.child
                .stdin
                .as_mut()
                .expect("test child stdin")
                .write_all(b"x")
                .expect("test child release");
            let status = self.child.wait().expect("test child exit");
            assert!(status.success());
        }

        fn kill_and_wait(&mut self) {
            self.child.kill().expect("terminate test child");
            self.child.wait().expect("reap test child");
        }
    }

    impl Drop for Holder {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    // Фикстура запускается как отдельный экземпляр test executable и не получает реальных путей.
    #[test]
    fn worker_hold_lock() {
        let Some(dir) = std::env::var_os("TF_NATIVE_LOCK_TEST_DIR") else {
            return;
        };
        let _guard = NativeSyncLock::try_acquire(Path::new(&dir)).expect("fixture lock");
        println!("TF_TEST_LOCK_HELD");
        std::io::stdout().flush().expect("fixture ready");
        let mut byte = [0u8; 1];
        std::io::stdin()
            .read_exact(&mut byte)
            .expect("fixture release");
    }

    #[test]
    fn separate_handles_conflict_and_file_is_not_deleted_on_release() {
        let dir = TestDir::new();
        let first = NativeSyncLock::try_acquire(dir.path()).unwrap();
        assert_eq!(first.verify(), Ok(()));
        assert_eq!(
            NativeSyncLock::try_acquire(dir.path()).err(),
            Some(LockError::Busy)
        );
        assert_eq!(fs::metadata(dir.lock_path()).unwrap().len(), 0);
        assert_eq!(
            fs::metadata(dir.lock_path()).unwrap().permissions().mode() & 0o077,
            0
        );
        drop(first);
        assert!(dir.lock_path().exists());
        let second = NativeSyncLock::try_acquire(dir.path()).unwrap();
        assert_eq!(second.verify(), Ok(()));
    }

    #[test]
    fn separate_process_excludes_then_allows_fresh_acquisition() {
        let dir = TestDir::new();
        let mut holder = Holder::start(dir.path());
        assert_eq!(
            NativeSyncLock::try_acquire(dir.path()).err(),
            Some(LockError::Busy)
        );
        holder.release_and_wait();
        assert!(dir.lock_path().exists());
        let next = NativeSyncLock::try_acquire(dir.path()).unwrap();
        assert_eq!(next.verify(), Ok(()));
    }

    #[test]
    fn killed_process_releases_lock_but_not_the_sentinel() {
        let dir = TestDir::new();
        let mut holder = Holder::start(dir.path());
        assert_eq!(
            NativeSyncLock::try_acquire(dir.path()).err(),
            Some(LockError::Busy)
        );
        holder.kill_and_wait();
        assert!(dir.lock_path().exists());
        assert!(NativeSyncLock::try_acquire(dir.path()).is_ok());
    }

    #[test]
    fn canonical_directory_aliases_share_one_lock() {
        let root = TestDir::new();
        let actual = root.path().join("actual");
        let alias = root.path().join("alias");
        fs::create_dir(&actual).unwrap();
        symlink(&actual, &alias).unwrap();
        let first = NativeSyncLock::try_acquire(&actual).unwrap();
        assert_eq!(
            NativeSyncLock::try_acquire(&alias).err(),
            Some(LockError::Busy)
        );
        drop(first);
        assert!(NativeSyncLock::try_acquire(&alias).is_ok());
    }

    #[test]
    fn symlink_as_lock_file_is_rejected_without_touching_target() {
        let dir = TestDir::new();
        let target = dir.path().join("target");
        fs::write(&target, b"PRIVATE-SENTINEL").unwrap();
        symlink(&target, dir.lock_path()).unwrap();
        assert_eq!(
            NativeSyncLock::try_acquire(dir.path()).err(),
            Some(LockError::UnsafeFile)
        );
        assert_eq!(fs::read(&target).unwrap(), b"PRIVATE-SENTINEL");
    }

    #[test]
    fn dangling_symlink_is_not_followed_or_created() {
        let dir = TestDir::new();
        let target = dir.path().join("missing-target");
        symlink(&target, dir.lock_path()).unwrap();
        assert_eq!(
            NativeSyncLock::try_acquire(dir.path()).err(),
            Some(LockError::UnsafeFile)
        );
        assert!(!target.exists());
    }

    #[test]
    fn hard_link_and_nonempty_existing_file_are_rejected_unchanged() {
        let dir = TestDir::new();
        let target = dir.path().join("target");
        File::create(&target).unwrap();
        fs::hard_link(&target, dir.lock_path()).unwrap();
        assert_eq!(
            NativeSyncLock::try_acquire(dir.path()).err(),
            Some(LockError::UnsafeFile)
        );
        assert_eq!(fs::metadata(&target).unwrap().len(), 0);
        fs::remove_file(dir.lock_path()).unwrap();
        fs::write(dir.lock_path(), b"PRIVATE-EXISTING").unwrap();
        assert_eq!(
            NativeSyncLock::try_acquire(dir.path()).err(),
            Some(LockError::UnsafeFile)
        );
        assert_eq!(fs::read(dir.lock_path()).unwrap(), b"PRIVATE-EXISTING");
    }

    #[test]
    fn detects_unlink_but_an_uncooperative_replacement_can_take_a_new_lock() {
        let dir = TestDir::new();
        let first = NativeSyncLock::try_acquire(dir.path()).unwrap();
        fs::remove_file(dir.lock_path()).unwrap(); // это действие намеренно нарушает протокол
        assert_eq!(first.verify(), Err(LockError::UnsafeFile));
        let second = NativeSyncLock::try_acquire(dir.path()).unwrap();
        assert_eq!(second.verify(), Ok(()));
        assert_eq!(first.verify(), Err(LockError::UnsafeFile));
        // Оба держат разные inode: проверка не защищает от подмены после проверки.
    }

    #[test]
    fn missing_directory_and_regular_file_fail_closed_without_disclosing_paths() {
        let dir = TestDir::new();
        let missing = dir.path().join("PRIVATE-MISSING");
        let error = NativeSyncLock::try_acquire(&missing).unwrap_err();
        assert_eq!(error, LockError::Unavailable);
        assert!(!format!("{error:?}").contains("PRIVATE"));
        assert!(!missing.exists());
        let file = dir.path().join("PRIVATE-FILE");
        fs::write(&file, b"PRIVATE-CONTENT").unwrap();
        assert_eq!(
            NativeSyncLock::try_acquire(&file).err(),
            Some(LockError::Unavailable)
        );
        assert_eq!(fs::read(file).unwrap(), b"PRIVATE-CONTENT");
    }
}

#[cfg(not(target_os = "linux"))]
#[test]
fn unsupported_platform_fails_closed() {
    use sync_native_lock::{LockError, NativeSyncLock};
    assert_eq!(
        NativeSyncLock::try_acquire(std::path::Path::new("unused")).err(),
        Some(LockError::Unsupported)
    );
}

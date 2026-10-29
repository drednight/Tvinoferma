//! Настоящие Windows-файлы в отдельном временном каталоге; это не данные приложения.
//! Эти тесты проверяют lock из production-модуля, но не доказывают устойчивость
//! сетевой ФС, защиту от некооперативного процесса или потери питания.

#[cfg(windows)]
#[path = "../src/cloud_credential_lock.rs"]
mod cloud_credential_lock;

#[cfg(windows)]
mod windows_tests {
    use super::cloud_credential_lock::{CredentialLock, LockError};
    use std::fs::{self, File};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    const LOCK_FILE: &str = ".tvinoferma-cloud-credentials.lock";
    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            for _ in 0..100 {
                let path = std::env::temp_dir().join(format!(
                    "tf-credential-lock-test-{}-{}",
                    std::process::id(),
                    NEXT_DIR.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(_) => panic!("could not create a separate test directory"),
                }
            }
            panic!("could not allocate a separate test directory")
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn lock_path(&self) -> PathBuf {
            self.0.join(LOCK_FILE)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct Holder(Child);

    impl Holder {
        fn start(dir: &Path) -> Self {
            let mut child = Command::new(std::env::current_exe().expect("test executable"))
                .arg("--exact")
                .arg("windows_tests::worker_holds_lock")
                .arg("--nocapture")
                .env("TF_CREDENTIAL_LOCK_TEST_DIR", dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("test worker");
            let output = child.stdout.take().expect("worker stdout");
            let (sender, receiver) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(output).lines() {
                    match line {
                        Ok(line) if line.contains("TF_TEST_CREDENTIAL_LOCK_HELD") => {
                            let _ = sender.send(());
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            });
            let holder = Self(child);
            // Drop завершает процесс и при неудачном запуске/таймауте.
            receiver
                .recv_timeout(Duration::from_secs(15))
                .expect("worker failed to acquire the lock");
            holder
        }

        fn release(&mut self) {
            self.0
                .stdin
                .as_mut()
                .expect("worker stdin")
                .write_all(b"x")
                .expect("worker release");
            assert!(self.0.wait().expect("worker exit").success());
        }

        fn terminate(&mut self) {
            self.0.kill().expect("terminate worker");
            self.0.wait().expect("reap worker");
        }
    }

    impl Drop for Holder {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn worker_holds_lock() {
        let Some(dir) = std::env::var_os("TF_CREDENTIAL_LOCK_TEST_DIR") else {
            return;
        };
        let guard = CredentialLock::try_acquire(Path::new(&dir)).expect("worker lock");
        assert_eq!(guard.verify(), Ok(()));
        println!("TF_TEST_CREDENTIAL_LOCK_HELD");
        std::io::stdout().flush().expect("worker ready");
        let mut byte = [0u8; 1];
        std::io::stdin()
            .read_exact(&mut byte)
            .expect("worker release");
    }

    #[test]
    fn separate_handles_exclude_each_other_and_verify_path() {
        let dir = TestDir::new();
        let first = CredentialLock::try_acquire(dir.path()).expect("first lock");
        assert_eq!(first.verify(), Ok(()));
        assert_eq!(
            CredentialLock::try_acquire(dir.path()).err(),
            Some(LockError::Unavailable)
        );
        // Windows не должна разрешать удалить имя удерживаемого lock-файла.
        assert!(fs::remove_file(dir.lock_path()).is_err());
        assert_eq!(first.verify(), Ok(()));
        drop(first);
        assert_eq!(fs::metadata(dir.lock_path()).unwrap().len(), 0);
        let second = CredentialLock::try_acquire(dir.path()).expect("next lock");
        assert_eq!(second.verify(), Ok(()));
    }

    #[test]
    fn a_different_process_is_excluded_and_can_release_normally() {
        let dir = TestDir::new();
        let mut holder = Holder::start(dir.path());
        assert_eq!(
            CredentialLock::try_acquire(dir.path()).err(),
            Some(LockError::Unavailable)
        );
        holder.release();
        assert!(dir.lock_path().exists());
        assert_eq!(
            CredentialLock::try_acquire(dir.path()).unwrap().verify(),
            Ok(())
        );
    }

    #[test]
    fn terminating_the_holder_releases_the_handle_but_keeps_the_sentinel() {
        let dir = TestDir::new();
        let mut holder = Holder::start(dir.path());
        assert_eq!(
            CredentialLock::try_acquire(dir.path()).err(),
            Some(LockError::Unavailable)
        );
        holder.terminate();
        assert!(dir.lock_path().exists());
        assert_eq!(
            CredentialLock::try_acquire(dir.path()).unwrap().verify(),
            Ok(())
        );
    }

    #[test]
    fn nonempty_file_is_not_truncated_or_accepted() {
        let dir = TestDir::new();
        fs::write(dir.lock_path(), b"TEST-EXISTING-CONTENT").unwrap();
        assert_eq!(
            CredentialLock::try_acquire(dir.path()).err(),
            Some(LockError::UnsafeFile)
        );
        assert_eq!(fs::read(dir.lock_path()).unwrap(), b"TEST-EXISTING-CONTENT");
    }

    #[test]
    fn a_hard_link_is_not_accepted_or_modified() {
        let dir = TestDir::new();
        let target = dir.path().join("target");
        File::create(&target).unwrap();
        fs::hard_link(&target, dir.lock_path()).expect("test filesystem must support hard links");
        assert_eq!(
            CredentialLock::try_acquire(dir.path()).err(),
            Some(LockError::UnsafeFile)
        );
        assert_eq!(fs::metadata(&target).unwrap().len(), 0);
    }
}

//! Низкоуровневые операции с одним файлом состояния и его резервными копиями.
//!
//! Все временные файлы находятся в той же папке, создаются без перезаписи и не
//! попадают в обычный список резервных копий. Это НЕ межпроцессная транзакция:
//! вызывающий обязан сериализовать операции приложения и защищаться от внешних
//! изменений отдельно. После ошибки, возникшей ПОСЛЕ rename, исход записи неизвестен.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
const MAX_NAME_ATTEMPTS: usize = 1024;
const BUFFER_SIZE: usize = 64 * 1024;
pub(super) const WRITE_UNCERTAIN_PREFIX: &str = "TF_STATE_WRITE_UNCERTAIN:";

// Only command-layer errors known to have occurred before replacement receive
// this marker. A lost IPC response must remain an unknown outcome to the UI.
pub(super) fn classify_write_error(error: String) -> String {
    if error.starts_with(WRITE_UNCERTAIN_PREFIX) {
        error
    } else {
        format!("TF_STATE_WRITE_UNCHANGED: {}", error)
    }
}

pub(super) fn uncertain_write_error() -> String {
    format!(
        "{} Файл состояния мог быть заменён, но подтверждение не получено; проверьте данные",
        WRITE_UNCERTAIN_PREFIX
    )
}

struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        // Удаляется только созданный нами временный файл. При аварийном завершении
        // он может остаться; это не является подтверждённой резервной копией.
        let _ = fs::remove_file(&self.0);
    }
}

fn unique_temp(dir: &Path) -> io::Result<(TempFile, File)> {
    for _ in 0..MAX_NAME_ATTEMPTS {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(".tvinoferma-{}-{}.part", std::process::id(), id));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => return Ok((TempFile(path), file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "temporary file names exhausted",
    ))
}

fn files_equal(left: &mut File, right: &mut File) -> io::Result<bool> {
    left.seek(SeekFrom::Start(0))?;
    right.seek(SeekFrom::Start(0))?;
    let size = left.metadata()?.len();
    if size != right.metadata()?.len() {
        return Ok(false);
    }
    let mut a = vec![0; BUFFER_SIZE];
    let mut b = vec![0; BUFFER_SIZE];
    let mut remaining = size;
    while remaining > 0 {
        let count = remaining.min(BUFFER_SIZE as u64) as usize;
        left.read_exact(&mut a[..count])?;
        right.read_exact(&mut b[..count])?;
        if a[..count] != b[..count] {
            return Ok(false);
        }
        remaining -= count as u64;
    }
    // Обнаруживаем также увеличение файла во время проверки.
    Ok(left.read(&mut a[..1])? == 0 && right.read(&mut b[..1])? == 0)
}

fn sync_directory(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        // std не предоставляет переносимый flush каталога на Windows. Не выдаём
        // это за гарантию сохранности после отключения питания.
        let _ = dir;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackupStage {
    TempCreated,
    Copied,
    Synced,
    Verified,
    Published,
}

fn backup_inner<F>(
    source_path: &Path,
    dir: &Path,
    timestamp: u64,
    label: &str,
    mut hook: F,
) -> io::Result<String>
where
    F: FnMut(BackupStage) -> io::Result<()>,
{
    if !label
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || label.len() > 32
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid backup label",
        ));
    }
    let mut source = File::open(source_path)?;
    if !source.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "state is not a regular file",
        ));
    }
    let (temp, mut output) = unique_temp(dir)?;
    hook(BackupStage::TempCreated)?;
    io::copy(&mut source, &mut output)?;
    hook(BackupStage::Copied)?;
    output.sync_all()?;
    hook(BackupStage::Synced)?;
    if !files_equal(&mut source, &mut output)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "backup verification failed",
        ));
    }
    hook(BackupStage::Verified)?;
    drop(output);

    let suffix = if label.is_empty() {
        String::new()
    } else {
        format!("-{}", label)
    };
    let mut published = None;
    for _ in 0..MAX_NAME_ATTEMPTS {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            "state.backup-{}{}-{}-{}.json",
            timestamp,
            suffix,
            std::process::id(),
            id
        );
        // hard_link атомарно создаёт новое имя и не заменяет существующую копию.
        // На файловой системе без поддержки hard link операция безопасно отклоняется.
        match fs::hard_link(&temp.0, dir.join(&name)) {
            Ok(()) => {
                published = Some(name);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    let name = published
        .ok_or_else(|| io::Error::new(io::ErrorKind::AlreadyExists, "backup names exhausted"))?;
    hook(BackupStage::Published)?;
    fs::remove_file(&temp.0)?;
    sync_directory(dir)?;
    Ok(name)
}

/// Создать проверенную побайтную копию без перезаписи и без ротации других копий.
pub(super) fn create_verified_backup(
    source_path: &Path,
    dir: &Path,
    timestamp: u64,
    label: &str,
) -> io::Result<String> {
    backup_inner(source_path, dir, timestamp, label, |_| Ok(()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WriteStage {
    TempCreated,
    Written,
    Synced,
    Verified,
    ReadyToPublish,
    Renamed,
}

// `create_only` publishes a previously missing state with a no-clobber hard link.
// Checking for absence followed by rename would overwrite a file created in between.
fn replace_inner_mode<F>(
    path: &Path,
    contents: &[u8],
    create_only: bool,
    mut hook: F,
) -> Result<(), String>
where
    F: FnMut(WriteStage) -> io::Result<()>,
{
    let dir = path
        .parent()
        .ok_or_else(|| "Не удалось определить папку состояния".to_string())?;
    let before =
        || "Не удалось подготовить сохранение состояния; прежний файл не заменён".to_string();
    let after = uncertain_write_error;
    let (temp, mut output) = unique_temp(dir).map_err(|_| before())?;
    hook(WriteStage::TempCreated).map_err(|_| before())?;
    output.write_all(contents).map_err(|_| before())?;
    hook(WriteStage::Written).map_err(|_| before())?;
    output.sync_all().map_err(|_| before())?;
    hook(WriteStage::Synced).map_err(|_| before())?;
    output.seek(SeekFrom::Start(0)).map_err(|_| before())?;
    let mut expected = io::Cursor::new(contents);
    let mut buffer = [0u8; BUFFER_SIZE];
    let mut comparison = [0u8; BUFFER_SIZE];
    let mut remaining = contents.len();
    if output.metadata().map_err(|_| before())?.len() != contents.len() as u64 {
        return Err(before());
    }
    while remaining > 0 {
        let count = remaining.min(BUFFER_SIZE);
        output
            .read_exact(&mut buffer[..count])
            .map_err(|_| before())?;
        expected
            .read_exact(&mut comparison[..count])
            .map_err(|_| before())?;
        if buffer[..count] != comparison[..count] {
            return Err(before());
        }
        remaining -= count;
    }
    hook(WriteStage::Verified).map_err(|_| before())?;
    drop(output);
    hook(WriteStage::ReadyToPublish).map_err(|_| before())?;
    if create_only {
        match fs::hard_link(&temp.0, path) {
            Ok(()) => {}
            // A newly appeared file belongs to someone else and was not replaced.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Err(before()),
            // For other publication errors we cannot assume the link was not made.
            Err(_) => return Err(after()),
        }
    } else {
        fs::rename(&temp.0, path).map_err(|_| after())?;
    }
    hook(WriteStage::Renamed).map_err(|_| after())?;
    let mut saved = File::open(path).map_err(|_| after())?;
    if saved.metadata().map_err(|_| after())?.len() != contents.len() as u64 {
        return Err(after());
    }
    let mut expected = io::Cursor::new(contents);
    let mut remaining = contents.len();
    while remaining > 0 {
        let count = remaining.min(BUFFER_SIZE);
        saved
            .read_exact(&mut buffer[..count])
            .map_err(|_| after())?;
        expected
            .read_exact(&mut comparison[..count])
            .map_err(|_| after())?;
        if buffer[..count] != comparison[..count] {
            return Err(after());
        }
        remaining -= count;
    }
    sync_directory(dir).map_err(|_| after())?;
    Ok(())
}

fn replace_inner<F>(path: &Path, contents: &[u8], hook: F) -> Result<(), String>
where
    F: FnMut(WriteStage) -> io::Result<()>,
{
    replace_inner_mode(path, contents, false, hook)
}

/// Сначала проверяется подготовленный файл, затем выполняется rename и проверка результата.
/// На ошибку после rename нельзя отвечать автоматическим повтором или откатом вслепую.
pub(super) fn replace_state(path: &Path, contents: &[u8]) -> Result<(), String> {
    replace_inner(path, contents, |_| Ok(()))
}

/// Проверка повторяется ПОСЛЕ подготовки временного файла, непосредственно перед
/// rename. Она сужает окно гонки, но не заменяет межпроцессную блокировку или CAS.
fn replace_guarded_inner<F>(
    path: &Path,
    contents: &[u8],
    expected: &[u8],
    mut hook: F,
) -> Result<(), String>
where
    F: FnMut(WriteStage) -> io::Result<()>,
{
    replace_inner(path, contents, |stage| {
        hook(stage)?;
        if stage == WriteStage::Verified {
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.file_type().is_file() || fs::read(path)? != expected {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "state changed before replacement",
                ));
            }
        }
        Ok(())
    })
}

pub(super) fn replace_state_if_unchanged(
    path: &Path,
    contents: &[u8],
    expected: &[u8],
) -> Result<(), String> {
    replace_guarded_inner(path, contents, expected, |_| Ok(()))
}

// Compare with bounded memory even if another process grows a file during the
// last check. This is not a no-follow open or an interprocess CAS.
fn regular_file_matches(path: &Path, expected: &[u8]) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_file() || metadata.len() != expected.len() as u64 {
        return Ok(false);
    }
    let mut file = File::open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.len() != expected.len() as u64 {
        return Ok(false);
    }
    let mut buffer = vec![0u8; BUFFER_SIZE];
    for chunk in expected.chunks(BUFFER_SIZE) {
        match file.read_exact(&mut buffer[..chunk.len()]) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(false),
            Err(error) => return Err(error),
        }
        if &buffer[..chunk.len()] != chunk {
            return Ok(false);
        }
    }
    Ok(file.read(&mut buffer[..1])? == 0)
}

// Both the chosen backup and the previous state are checked after the temporary
// replacement has been written and verified. Existing-file replacement is still
// not an interprocess CAS: an external writer can race the check and rename.
fn replace_restore_guarded_inner<F>(
    path: &Path,
    contents: &[u8],
    expected_state: Option<&[u8]>,
    backup_path: &Path,
    expected_backup: &[u8],
    mut hook: F,
) -> Result<(), String>
where
    F: FnMut(WriteStage) -> io::Result<()>,
{
    replace_inner_mode(path, contents, expected_state.is_none(), |stage| {
        hook(stage)?;
        if stage == WriteStage::Verified {
            let current_matches = match expected_state {
                Some(expected) => regular_file_matches(path, expected)?,
                None => {
                    matches!(fs::symlink_metadata(path), Err(error) if error.kind() == io::ErrorKind::NotFound)
                }
            };
            let backup_matches = regular_file_matches(backup_path, expected_backup)?;
            if !current_matches || !backup_matches {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "restore source changed before publication",
                ));
            }
        }
        Ok(())
    })
}

pub(super) fn replace_state_for_restore(
    path: &Path,
    contents: &[u8],
    expected_state: Option<&[u8]>,
    backup_path: &Path,
    expected_backup: &[u8],
) -> Result<(), String> {
    replace_restore_guarded_inner(
        path,
        contents,
        expected_state,
        backup_path,
        expected_backup,
        |_| Ok(()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::{Arc, Barrier};
    use std::thread;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "tf-state-files-test-{}-{}",
                std::process::id(),
                id
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn injected() -> io::Error {
        io::Error::other("injected failure")
    }
    fn names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|item| item.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn write_outcome_markers_keep_unknown_separate_from_prewrite_errors() {
        let before = classify_write_error("not written".to_string());
        assert!(before.starts_with("TF_STATE_WRITE_UNCHANGED:"));
        let after = uncertain_write_error();
        assert!(after.starts_with(WRITE_UNCERTAIN_PREFIX));
        assert_eq!(classify_write_error(after.clone()), after);
    }

    #[test]
    fn backup_is_exact_and_does_not_replace_previous_copy() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let data = vec![b'x'; BUFFER_SIZE * 2 + 23];
        fs::write(&state, &data).unwrap();
        let first = create_verified_backup(&state, &dir.0, 123, "pre-restore").unwrap();
        fs::write(&state, b"new data").unwrap();
        let second = create_verified_backup(&state, &dir.0, 123, "pre-restore").unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read(dir.0.join(first)).unwrap(), data);
        assert_eq!(fs::read(dir.0.join(second)).unwrap(), b"new data");
        assert!(names(&dir.0).iter().all(|name| !name.ends_with(".part")));
    }

    #[test]
    fn failure_before_publication_keeps_original_and_previous_backup() {
        for stage in [
            BackupStage::TempCreated,
            BackupStage::Copied,
            BackupStage::Synced,
            BackupStage::Verified,
        ] {
            let dir = TestDir::new();
            let state = dir.0.join("state.json");
            fs::write(&state, b"original").unwrap();
            fs::write(dir.0.join("state.backup-old.json"), b"old").unwrap();
            assert!(
                backup_inner(&state, &dir.0, 123, "test", |point| if point == stage {
                    Err(injected())
                } else {
                    Ok(())
                })
                .is_err()
            );
            assert_eq!(fs::read(&state).unwrap(), b"original");
            assert_eq!(
                fs::read(dir.0.join("state.backup-old.json")).unwrap(),
                b"old"
            );
            assert_eq!(names(&dir.0).len(), 2);
        }
    }

    #[test]
    fn failure_after_publication_keeps_verified_new_copy_and_old_copy() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(&state, b"original").unwrap();
        fs::write(dir.0.join("state.backup-old.json"), b"old").unwrap();
        assert!(backup_inner(&state, &dir.0, 123, "test", |point| {
            if point == BackupStage::Published {
                Err(injected())
            } else {
                Ok(())
            }
        })
        .is_err());
        let backups: Vec<_> = names(&dir.0)
            .into_iter()
            .filter(|name| name.starts_with("state.backup-") && name != "state.backup-old.json")
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(dir.0.join(&backups[0])).unwrap(), b"original");
        assert_eq!(
            fs::read(dir.0.join("state.backup-old.json")).unwrap(),
            b"old"
        );
    }

    #[test]
    fn detects_source_change_before_publication() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(&state, b"before").unwrap();
        let result = backup_inner(&state, &dir.0, 123, "test", |point| {
            if point == BackupStage::Copied {
                fs::write(&state, b"altered")?;
            }
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(names(&dir.0), vec!["state.json"]);
    }

    #[test]
    fn replacement_keeps_previous_bytes_on_failure_before_rename() {
        for stage in [
            WriteStage::TempCreated,
            WriteStage::Written,
            WriteStage::Synced,
            WriteStage::Verified,
        ] {
            let dir = TestDir::new();
            let state = dir.0.join("state.json");
            fs::write(&state, b"before").unwrap();
            let result = replace_inner(&state, b"after", |point| {
                if point == stage {
                    Err(injected())
                } else {
                    Ok(())
                }
            });
            assert!(result.unwrap_err().contains("не заменён"));
            assert_eq!(fs::read(&state).unwrap(), b"before");
            assert_eq!(names(&dir.0), vec!["state.json"]);
        }
    }

    #[test]
    fn error_after_rename_reports_uncertain_outcome_without_blind_rollback() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(&state, b"before").unwrap();
        let result = replace_inner(&state, b"after", |point| {
            if point == WriteStage::Renamed {
                Err(injected())
            } else {
                Ok(())
            }
        });
        assert!(result.unwrap_err().contains("мог быть заменён"));
        assert_eq!(fs::read(&state).unwrap(), b"after");
        replace_state(&state, b"verified").unwrap();
        assert_eq!(fs::read(&state).unwrap(), b"verified");
    }

    #[test]
    fn guarded_replacement_rechecks_source_after_temporary_file_is_prepared() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(&state, b"before").unwrap();
        let result = replace_guarded_inner(&state, b"candidate", b"before", |point| {
            if point == WriteStage::Synced {
                fs::write(&state, b"changed")?;
            }
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&state).unwrap(), b"changed");
        assert_eq!(names(&dir.0), vec!["state.json"]);
        assert!(replace_state_if_unchanged(&state, b"candidate", b"before").is_err());
        assert_eq!(fs::read(&state).unwrap(), b"changed");
        replace_state_if_unchanged(&state, b"candidate", b"changed").unwrap();
        assert_eq!(fs::read(&state).unwrap(), b"candidate");
    }

    #[test]
    fn final_restore_comparison_handles_large_changed_and_missing_files() {
        let dir = TestDir::new();
        let file = dir.0.join("reviewed.json");
        let contents = vec![b'x'; BUFFER_SIZE * 2 + 3];
        assert!(!regular_file_matches(&file, &contents).unwrap());
        fs::write(&file, &contents).unwrap();
        assert!(regular_file_matches(&file, &contents).unwrap());
        let mut changed = contents.clone();
        changed[BUFFER_SIZE + 1] = b'y';
        assert!(!regular_file_matches(&file, &changed).unwrap());
        assert!(!regular_file_matches(&file, &contents[..contents.len() - 1]).unwrap());
        let huge = OpenOptions::new().write(true).open(&file).unwrap();
        huge.set_len(128 * 1024 * 1024 + 1).unwrap();
        assert!(!regular_file_matches(&file, &contents).unwrap());
    }

    #[test]
    fn restore_rechecks_both_files_after_preparing_replacement() {
        for change in ["state", "backup", "backup-symlink"] {
            let dir = TestDir::new();
            let state = dir.0.join("state.json");
            let backup = dir.0.join("state.backup-selected.json");
            fs::write(&state, b"previous").unwrap();
            fs::write(&backup, b"reviewed").unwrap();
            let result = replace_restore_guarded_inner(
                &state,
                b"reviewed",
                Some(b"previous"),
                &backup,
                b"reviewed",
                |point| {
                    if point == WriteStage::Verified {
                        if change == "state" {
                            fs::write(&state, b"external")?;
                        } else if change == "backup" {
                            fs::write(&backup, b"other")?;
                        } else {
                            fs::remove_file(&backup)?;
                            // A directory is rejected on every supported platform.
                            fs::create_dir(&backup)?;
                        }
                    }
                    Ok(())
                },
            );
            assert!(result.is_err());
            assert_eq!(
                fs::read(&state).unwrap(),
                if change == "state" {
                    b"external"
                } else {
                    b"previous"
                }
            );
        }
    }

    #[test]
    fn restore_missing_state_never_clobbers_a_file_created_at_publication() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        let backup = dir.0.join("state.backup-selected.json");
        fs::write(&backup, b"reviewed").unwrap();
        let result = replace_restore_guarded_inner(
            &state,
            b"reviewed",
            None,
            &backup,
            b"reviewed",
            |point| {
                if point == WriteStage::ReadyToPublish {
                    fs::write(&state, b"new external state")?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&state).unwrap(), b"new external state");
        assert_eq!(fs::read(&backup).unwrap(), b"reviewed");
    }

    #[test]
    fn concurrent_backups_do_not_replace_each_other() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        fs::write(&state, b"original").unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let dir = dir.0.clone();
                let state = state.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    create_verified_backup(&state, &dir, 123, "test").unwrap()
                })
            })
            .collect();
        let mut names = HashSet::new();
        for worker in workers {
            let name = worker.join().unwrap();
            assert!(names.insert(name.clone()));
            assert_eq!(fs::read(dir.0.join(name)).unwrap(), b"original");
        }
        assert_eq!(names.len(), 8);
    }

    #[test]
    fn missing_input_and_invalid_label_fail_without_creating_backup() {
        let dir = TestDir::new();
        let state = dir.0.join("state.json");
        assert!(create_verified_backup(&state, &dir.0, 1, "test").is_err());
        fs::write(&state, b"data").unwrap();
        assert!(create_verified_backup(&state, &dir.0, 1, "../unsafe").is_err());
        assert_eq!(names(&dir.0), vec!["state.json"]);
    }
}

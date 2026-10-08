//! Раскладка интерфейса игры (папка Layout): один файл-образец копируется поверх остальных `.ini`
//! в той же папке, после чего на них ставится пометка «только для чтения».
//!
//! Здесь только работа с файлами (без Tauri), поэтому модуль проверяется обычными тестами.
//! Команды для интерфейса — в `commands/layout.rs`.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Файл настроек окна лежит рядом с layout, но это другой файл: его не перезаписываем.
const SKIP_FILES: &[&str] = &["systemsettings.ini"];
/// Образец больше этого размера — скорее всего выбран не тот файл.
const MAX_TEMPLATE_BYTES: u64 = 8 * 1024 * 1024;
/// Сколько последних резервных копий хранить.
const KEEP_BACKUPS: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutFile {
    pub name: String,
    pub size: u64,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// Файлы, которые будут заменены (образец в список не входит)
    pub targets: Vec<LayoutFile>,
    /// Образец лежит внутри этой же папки
    pub template_in_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub name: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// Файлы, содержимое которых заменено
    pub replaced: Vec<String>,
    /// Файлы, которые уже совпадали с образцом (им только подтверждена пометка «только для чтения»)
    pub unchanged: Vec<String>,
    pub failed: Vec<Failure>,
    /// Папка с копиями прежних файлов (если что-то заменялось)
    pub backup_dir: Option<String>,
}

fn is_ini(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("ini"))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Папка должна существовать и не быть корнем диска: перезаписывать все `.ini` на диске никто не хочет.
fn check_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("Папка не найдена: {}", dir.display()));
    }
    if dir.parent().is_none() || dir.parent() == Some(Path::new("")) {
        return Err("Укажите папку Layout, а не корень диска".to_string());
    }
    Ok(())
}

fn check_template(template: &Path) -> Result<u64, String> {
    let meta = fs::metadata(template)
        .map_err(|_| format!("Файл-образец не найден: {}", template.display()))?;
    if !meta.is_file() {
        return Err("Образец должен быть файлом".to_string());
    }
    if !is_ini(template) {
        return Err("Образец должен быть файлом .ini".to_string());
    }
    if meta.len() == 0 {
        return Err("Файл-образец пустой".to_string());
    }
    if meta.len() > MAX_TEMPLATE_BYTES {
        return Err("Файл-образец слишком большой для layout".to_string());
    }
    Ok(meta.len())
}

/// `.ini` в папке (без вложенных папок), кроме образца и служебных файлов. Отсортированы по имени.
fn target_paths(dir: &Path, template: Option<&Path>) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("Не удалось прочитать папку: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_ini(&path) {
            continue;
        }
        let name = file_name(&path);
        if SKIP_FILES.iter().any(|s| name.eq_ignore_ascii_case(s)) {
            continue;
        }
        if template.is_some_and(|t| same_file(t, &path)) {
            continue;
        }
        out.push(path);
    }
    out.sort_by_key(|p| file_name(p).to_lowercase());
    Ok(out)
}

/// Что будет заменено. Ничего не меняет.
pub fn scan(dir: &Path, template: Option<&Path>) -> Result<ScanReport, String> {
    check_dir(dir)?;
    let targets = target_paths(dir, template)?
        .into_iter()
        .filter_map(|p| {
            let meta = fs::metadata(&p).ok()?;
            Some(LayoutFile {
                name: file_name(&p),
                size: meta.len(),
                read_only: meta.permissions().readonly(),
            })
        })
        .collect();
    let template_in_dir = template.is_some_and(|t| t.parent().is_some_and(|p| same_file(p, dir)));
    Ok(ScanReport {
        targets,
        template_in_dir,
    })
}

/// Снять или поставить «только для чтения». Снятие нужно перед записью.
#[allow(clippy::permissions_set_readonly_false)]
fn set_read_only(path: &Path, read_only: bool) -> Result<(), String> {
    let mut perm = fs::metadata(path).map_err(|e| e.to_string())?.permissions();
    if perm.readonly() == read_only {
        return Ok(());
    }
    perm.set_readonly(read_only);
    fs::set_permissions(path, perm).map_err(|e| e.to_string())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Оставляет только последние `KEEP_BACKUPS` папок с копиями (имя папки — время в секундах).
fn prune_backups(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut dirs: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| Some((file_name(&e.path()).parse::<u64>().ok()?, e.path())))
        .collect();
    dirs.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    for (_, path) in dirs.into_iter().skip(KEEP_BACKUPS) {
        let _ = fs::remove_dir_all(path);
    }
}

/// Копирует образец поверх остальных `.ini` папки и ставит «только для чтения».
/// Прежние файлы сначала сохраняются в `backup_root/<время>/` (если папка резервных копий задана).
/// Ошибка по отдельному файлу не останавливает остальные — она попадает в отчёт.
pub fn apply(
    dir: &Path,
    template: &Path,
    backup_root: Option<&Path>,
) -> Result<ApplyReport, String> {
    check_dir(dir)?;
    check_template(template)?;
    let content = fs::read(template).map_err(|e| format!("Не удалось прочитать образец: {e}"))?;
    let targets = target_paths(dir, Some(template))?;
    let mut report = ApplyReport::default();
    if targets.is_empty() {
        return Ok(report);
    }

    let mut backup_dir: Option<PathBuf> = None;
    for path in targets {
        let name = file_name(&path);
        let result = (|| -> Result<bool, String> {
            let current = fs::read(&path).map_err(|e| e.to_string())?;
            if current == content {
                set_read_only(&path, true)?;
                return Ok(false);
            }
            if let Some(root) = backup_root {
                if backup_dir.is_none() {
                    let d = root.join(unix_now().to_string());
                    fs::create_dir_all(&d)
                        .map_err(|e| format!("не удалось создать папку копий: {e}"))?;
                    backup_dir = Some(d);
                }
                if let Some(d) = &backup_dir {
                    fs::write(d.join(&name), &current)
                        .map_err(|e| format!("не удалось сохранить копию: {e}"))?;
                }
            }
            set_read_only(&path, false)?;
            fs::write(&path, &content).map_err(|e| e.to_string())?;
            set_read_only(&path, true)?;
            Ok(true)
        })();
        match result {
            Ok(true) => report.replaced.push(name),
            Ok(false) => report.unchanged.push(name),
            Err(error) => report.failed.push(Failure { name, error }),
        }
    }
    if let (Some(d), Some(root)) = (&backup_dir, backup_root) {
        report.backup_dir = Some(d.display().to_string());
        prune_backups(root);
    }
    Ok(report)
}

/// Снимает «только для чтения» с тех же файлов, которые меняет `apply` (например, чтобы игра снова
/// могла сохранять свою раскладку). Возвращает имена файлов, с которых пометка снята.
pub fn unlock(dir: &Path, template: Option<&Path>) -> Result<Vec<String>, String> {
    check_dir(dir)?;
    let mut done = Vec::new();
    for path in target_paths(dir, template)? {
        let was = fs::metadata(&path)
            .map(|m| m.permissions().readonly())
            .unwrap_or(false);
        if was {
            set_read_only(&path, false)?;
            done.push(file_name(&path));
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "tf-layout-{tag}-{}-{}",
            std::process::id(),
            unix_now()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn setup(tag: &str) -> (PathBuf, PathBuf) {
        let dir = tmp(tag).join("Layout");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("1001.ini"), "[Windows]\nA=1\n").unwrap();
        fs::write(dir.join("1002.INI"), "[Windows]\nA=2\n").unwrap();
        fs::write(dir.join("notes.txt"), "не ini").unwrap();
        fs::write(dir.join("systemsettings.ini"), "[Video]\nLevel=0\n").unwrap();
        let template = dir.join("1001.ini");
        (dir, template)
    }

    #[test]
    fn scan_skips_template_non_ini_and_systemsettings() {
        let (dir, template) = setup("scan");
        let r = scan(&dir, Some(&template)).unwrap();
        let names: Vec<_> = r.targets.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["1002.INI"]);
        assert!(r.template_in_dir);
    }

    #[test]
    fn apply_copies_content_and_sets_read_only() {
        let (dir, template) = setup("apply");
        let backups = dir.parent().unwrap().join("backups");
        let r = apply(&dir, &template, Some(&backups)).unwrap();
        assert_eq!(r.replaced, ["1002.INI"]);
        assert!(r.failed.is_empty());
        assert_eq!(
            fs::read_to_string(dir.join("1002.INI")).unwrap(),
            "[Windows]\nA=1\n"
        );
        assert!(fs::metadata(dir.join("1002.INI"))
            .unwrap()
            .permissions()
            .readonly());
        // образец и systemsettings.ini не тронуты
        assert!(!fs::metadata(&template).unwrap().permissions().readonly());
        assert_eq!(
            fs::read_to_string(dir.join("systemsettings.ini")).unwrap(),
            "[Video]\nLevel=0\n"
        );
        // прежний файл сохранён в копии
        let b = PathBuf::from(r.backup_dir.unwrap());
        assert_eq!(
            fs::read_to_string(b.join("1002.INI")).unwrap(),
            "[Windows]\nA=2\n"
        );
    }

    #[test]
    fn apply_overwrites_files_that_are_already_read_only_and_is_repeatable() {
        let (dir, template) = setup("repeat");
        fs::write(dir.join("1003.ini"), "старое").unwrap();
        set_read_only(&dir.join("1003.ini"), true).unwrap();
        let r = apply(&dir, &template, None).unwrap();
        assert_eq!(r.replaced.len(), 2);
        assert!(r.backup_dir.is_none());
        assert_eq!(
            fs::read_to_string(dir.join("1003.ini")).unwrap(),
            "[Windows]\nA=1\n"
        );
        // второй запуск ничего не пишет: файлы уже совпадают
        let r2 = apply(&dir, &template, None).unwrap();
        assert!(r2.replaced.is_empty());
        assert_eq!(r2.unchanged.len(), 2);
    }

    #[test]
    fn template_outside_the_folder_is_not_modified() {
        let (dir, _) = setup("outside");
        let other = dir.parent().unwrap().join("my.ini");
        fs::write(&other, "[Windows]\nX=9\n").unwrap();
        let r = apply(&dir, &other, None).unwrap();
        assert_eq!(r.replaced.len(), 2); // 1001.ini и 1002.INI
        assert_eq!(
            fs::read_to_string(dir.join("1001.ini")).unwrap(),
            "[Windows]\nX=9\n"
        );
        assert!(!scan(&dir, Some(&other)).unwrap().template_in_dir);
    }

    #[test]
    fn unlock_removes_read_only_flag() {
        let (dir, template) = setup("unlock");
        apply(&dir, &template, None).unwrap();
        let done = unlock(&dir, Some(&template)).unwrap();
        assert_eq!(done, ["1002.INI"]);
        assert!(!fs::metadata(dir.join("1002.INI"))
            .unwrap()
            .permissions()
            .readonly());
    }

    #[test]
    fn rejects_bad_input() {
        let (dir, template) = setup("bad");
        assert!(scan(&dir.join("нет"), None).is_err());
        assert!(apply(&dir, &dir.join("нет.ini"), None).is_err());
        assert!(apply(&dir, &dir.join("notes.txt"), None).is_err());
        let empty = dir.join("empty.ini");
        fs::write(&empty, "").unwrap();
        assert!(apply(&dir, &empty, None).is_err());
        assert!(check_dir(Path::new("/")).is_err());
        assert!(apply(&dir, &template, None).is_ok());
    }

    #[test]
    fn keeps_only_recent_backups() {
        let root = tmp("prune");
        for t in 1..=8u64 {
            fs::create_dir_all(root.join(t.to_string())).unwrap();
        }
        prune_backups(&root);
        let mut left: Vec<u64> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter_map(|e| file_name(&e.path()).parse().ok())
            .collect();
        left.sort();
        assert_eq!(left, [4, 5, 6, 7, 8]);
    }
}

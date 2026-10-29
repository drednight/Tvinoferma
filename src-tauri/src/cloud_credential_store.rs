//! Экспериментальный локальный журнал учётных данных облака.
//!
//! Запись хранится в нескольких небольших записях хранилища ОС; отдельная
//! запись-head содержит случайный slot ID, длину и SHA-256 всей строки. Перед
//! изменением head переводится в `pending`, после чего записываются и перечитываются
//! все части и только затем публикуется новый head. Неизвестный исход или повреждение
//! блокирует использование: старый токен нельзя автоматически восстанавливать.
//!
//! Этот модуль сам не обеспечивает межпроцессную блокировку или безопасность ОС.
//! Вызывающая сторона обязана удерживать единый lock на всех операциях, включая
//! удаление, и использовать локальное защищённое хранилище ОС, а не файлы или
//! Web Storage. Проверка чтением не доказывает устойчивость к потере питания;
//! согласованный откат head и частей обнаружить нельзя. Отсутствие всех записей
//! не доказывает, что подключения прежде не было. Поля и ошибки нельзя логировать.

use sha2::{Digest, Sha256};

const PREFIX: &str = "cloud-sync-v1";
const HEAD_PENDING: &str = "tf-cloud-credential-v1|pending";
const HEAD_READY: &str = "tf-cloud-credential-v1|ready";
// Запись Credential Manager ограничена по размеру в UTF-16. Данные здесь ASCII:
// даже с более строгим распространённым лимитом в 2560 байт часть помещается.
const PART_BYTES: usize = 768;
pub(crate) const MAX_RECORD_BYTES: usize = 16 * 1024;
const MAX_PARTS: usize = MAX_RECORD_BYTES.div_ceil(PART_BYTES);

/// Операции над небольшими строками в ОС. `write` и `remove` могут иметь
/// неизвестный исход при ошибке; никакого отката при ошибке не выполняем.
pub(crate) trait CredentialVault {
    fn read(&mut self, name: &str) -> Result<Option<String>, ()>;
    fn write(&mut self, name: &str, value: &str) -> Result<(), ()>;
    fn remove(&mut self, name: &str) -> Result<(), ()>;
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    Google,
    Yandex,
    // Отдельное пространство локального ключа; OAuth-служба его не разбирает.
    KeyState,
}

impl Provider {
    fn name(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Yandex => "yandex",
            Self::KeyState => "key-state",
        }
    }

    fn head(self) -> String {
        format!("{PREFIX}:{}:head", self.name())
    }

    fn part(self, index: usize) -> String {
        format!("{PREFIX}:{}:part:{index:02}", self.name())
    }
}

// Намеренно без Debug: Ready содержит секретную строку.
pub(crate) enum Inspection {
    Empty,
    Blocked,
    Ready { slot_id: String, record: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Installed,
    Occupied,
    Swapped,
    Mismatch,
    Blocked,
    Forgotten,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StoreError {
    Invalid,
    Unavailable,
}

pub(crate) fn valid_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 || bytes[14] != b'4' || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b') {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
        }
    })
}

fn valid_record(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= MAX_RECORD_BYTES
        // Канонические OAuth-записи — JSON из печатного ASCII. Не разрезаем
        // многобайтовые символы и не передаём NUL в хранилище ОС.
        && raw.bytes().all(|byte| (b' '..=b'~').contains(&byte))
}

fn digest(raw: &str) -> String {
    use std::fmt::Write;
    let hash = Sha256::digest(raw.as_bytes());
    let mut text = String::with_capacity(64);
    for byte in hash {
        // Запись в String не может завершиться ошибкой.
        let _ = write!(&mut text, "{byte:02x}");
    }
    text
}

fn ready_head(slot_id: &str, raw: &str) -> String {
    format!("{HEAD_READY}|{slot_id}|{}|{}", raw.len(), digest(raw))
}

struct Head<'a> {
    slot_id: &'a str,
    length: usize,
    hash: &'a str,
}

fn parse_head(head: &str) -> Option<Head<'_>> {
    let tail = head.strip_prefix(HEAD_READY)?.strip_prefix('|')?;
    let mut parts = tail.split('|');
    let slot_id = parts.next()?;
    let length_text = parts.next()?;
    let hash = parts.next()?;
    if parts.next().is_some()
        || !valid_uuid(slot_id)
        || length_text.is_empty()
        || length_text.len() > 5
        || (length_text.len() > 1 && length_text.starts_with('0'))
        || !length_text.bytes().all(|byte| byte.is_ascii_digit())
        || hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let length = length_text.parse::<usize>().ok()?;
    if length == 0 || length > MAX_RECORD_BYTES {
        return None;
    }
    Some(Head {
        slot_id,
        length,
        hash,
    })
}

fn get(vault: &mut impl CredentialVault, name: &str) -> Result<Option<String>, StoreError> {
    vault.read(name).map_err(|_| StoreError::Unavailable)
}

fn write_checked(
    vault: &mut impl CredentialVault,
    name: &str,
    value: &str,
) -> Result<(), StoreError> {
    vault
        .write(name, value)
        .map_err(|_| StoreError::Unavailable)?;
    if get(vault, name)?.as_deref() != Some(value) {
        return Err(StoreError::Unavailable);
    }
    Ok(())
}

fn remove_checked(vault: &mut impl CredentialVault, name: &str) -> Result<(), StoreError> {
    if get(vault, name)?.is_some() {
        vault.remove(name).map_err(|_| StoreError::Unavailable)?;
        if get(vault, name)?.is_some() {
            return Err(StoreError::Unavailable);
        }
    }
    Ok(())
}

/// Вызывается только под межпроцессным lock. `Empty` — наблюдение, а не
/// подтверждение первого подключения. Заблокированную запись не заменяем.
pub(crate) fn inspect(
    vault: &mut impl CredentialVault,
    provider: Provider,
) -> Result<Inspection, StoreError> {
    let head = get(vault, &provider.head())?;
    let Some(head) = head else {
        for index in 0..MAX_PARTS {
            if get(vault, &provider.part(index))?.is_some() {
                return Ok(Inspection::Blocked);
            }
        }
        return Ok(Inspection::Empty);
    };
    let Some(head) = parse_head(&head) else {
        return Ok(Inspection::Blocked);
    };
    let count = head.length.div_ceil(PART_BYTES);
    let mut raw = String::with_capacity(head.length);
    for index in 0..MAX_PARTS {
        let part = get(vault, &provider.part(index))?;
        if index >= count {
            if part.is_some() {
                return Ok(Inspection::Blocked);
            }
            continue;
        }
        let Some(part) = part else {
            return Ok(Inspection::Blocked);
        };
        let expected = (head.length - index * PART_BYTES).min(PART_BYTES);
        if part.len() != expected || !part.bytes().all(|byte| (b' '..=b'~').contains(&byte)) {
            return Ok(Inspection::Blocked);
        }
        raw.push_str(&part);
    }
    if !valid_record(&raw) || digest(&raw) != head.hash {
        return Ok(Inspection::Blocked);
    }
    Ok(Inspection::Ready {
        slot_id: head.slot_id.to_owned(),
        record: raw,
    })
}

fn commit(
    vault: &mut impl CredentialVault,
    provider: Provider,
    slot_id: &str,
    raw: &str,
) -> Result<(), StoreError> {
    // После этого шага любой обрыв оставляет запрет на использование. Если сам
    // вызов вернул ошибку, его исход тоже неизвестен; части ещё не менялись.
    write_checked(vault, &provider.head(), HEAD_PENDING)?;
    let bytes = raw.as_bytes();
    let count = bytes.len().div_ceil(PART_BYTES);
    for index in 0..count {
        // valid_record гарантирует ASCII, границы части всегда корректны для UTF-8.
        let start = index * PART_BYTES;
        let end = (start + PART_BYTES).min(bytes.len());
        write_checked(vault, &provider.part(index), &raw[start..end])?;
    }
    // Части предыдущей более длинной записи не должны оставаться доступными и
    // не должны выглядеть как часть текущего подключения.
    for index in count..MAX_PARTS {
        remove_checked(vault, &provider.part(index))?;
    }
    write_checked(vault, &provider.head(), &ready_head(slot_id, raw))
}

/// Только явно подтверждённая первая установка. Никогда не перезаписывает
/// готовую, частичную или повреждённую запись. `slot_id` должен совпадать с
/// проверенной выше записью OAuth; этот слой не разбирает её содержимое.
pub(crate) fn install(
    vault: &mut impl CredentialVault,
    provider: Provider,
    slot_id: &str,
    record: &str,
) -> Result<Outcome, StoreError> {
    if !valid_uuid(slot_id) || !valid_record(record) {
        return Err(StoreError::Invalid);
    }
    match inspect(vault, provider)? {
        Inspection::Empty => {}
        Inspection::Ready { .. } => return Ok(Outcome::Occupied),
        Inspection::Blocked => return Ok(Outcome::Blocked),
    }
    commit(vault, provider, slot_id, record)?;
    Ok(Outcome::Installed)
}

/// Сравнение точной прежней строки и закреплённого slot ID. Корректность
/// переходов ready/pending и неизменность аккаунта проверяет вызывающий адаптер.
/// Lock обязателен на протяжении inspect и commit целиком.
pub(crate) fn compare_exchange(
    vault: &mut impl CredentialVault,
    provider: Provider,
    slot_id: &str,
    expected: &str,
    next: &str,
) -> Result<Outcome, StoreError> {
    if !valid_uuid(slot_id) || !valid_record(expected) || !valid_record(next) || expected == next {
        return Err(StoreError::Invalid);
    }
    match inspect(vault, provider)? {
        Inspection::Ready {
            slot_id: actual,
            record,
        } if actual == slot_id && record == expected => {}
        Inspection::Ready { .. } | Inspection::Empty => return Ok(Outcome::Mismatch),
        Inspection::Blocked => return Ok(Outcome::Blocked),
    }
    commit(vault, provider, slot_id, next)?;
    Ok(Outcome::Swapped)
}

/// Явное локальное забывание, в том числе после повреждения. Не отзывает
/// разрешения и ничего не удаляет в облаке. Сначала оставляем запрет на чтение,
/// затем удаляем все известные части, а head удаляем последним. Ошибка может
/// означать частичное удаление и не даёт права считать подключение забытым.
pub(crate) fn forget(
    vault: &mut impl CredentialVault,
    provider: Provider,
) -> Result<Outcome, StoreError> {
    write_checked(vault, &provider.head(), HEAD_PENDING)?;
    for index in 0..MAX_PARTS {
        remove_checked(vault, &provider.part(index))?;
    }
    remove_checked(vault, &provider.head())?;
    Ok(Outcome::Forgotten)
}

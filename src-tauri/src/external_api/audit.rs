//! Кольцевой журнал вызовов внешнего API.
//!
//! Хранится в памяти и не переживает перезапуск. В журнал не попадают тела
//! запросов, токен и значения полей: только время, метод, путь, код и длительность.
//! Путь может содержать id персонажа — это не секрет, но и он не нужен никому,
//! кроме локального пользователя, поэтому журнал целиком виден только в настройках
//! приложения и на странице `GET /` (после проверки токена).

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

/// Сколько последних вызовов храним.
pub const AUDIT_LIMIT: usize = 100;

/// Один вызов. Поля уходят в JS в camelCase.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// Время окончания: миллисекунды с начала эпохи.
    pub at_ms: u64,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub ms: u64,
}

/// Журнал в памяти. Все операции — короткие, поэтому одного мьютекса достаточно.
pub struct Audit {
    entries: VecDeque<AuditEntry>,
}

impl Default for Audit {
    fn default() -> Self {
        Self {
            entries: VecDeque::with_capacity(AUDIT_LIMIT),
        }
    }
}

impl Audit {
    /// Добавляет вызов, вытесняя самый старый.
    pub fn push(&mut self, entry: AuditEntry) {
        if self.entries.len() == AUDIT_LIMIT {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    /// Копия журнала от старых к новым.
    pub fn snapshot(&self) -> Vec<AuditEntry> {
        self.entries.iter().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Сколько вызовов сейчас в журнале.
    pub fn count(&self) -> usize {
        self.entries.len()
    }
}

/// Текущее время в миллисекундах. Если часы системы раньше эпохи — 0.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{now_ms, Audit, AuditEntry, AUDIT_LIMIT};

    fn entry(n: u64) -> AuditEntry {
        AuditEntry {
            at_ms: n,
            method: "GET".into(),
            path: format!("/api/v1/health?n={n}"),
            status: 200,
            ms: n,
        }
    }

    #[test]
    fn journal_keeps_only_the_last_entries() {
        let mut audit = Audit::default();
        for n in 0..(AUDIT_LIMIT as u64 + 5) {
            audit.push(entry(n));
        }
        assert_eq!(audit.count(), AUDIT_LIMIT);
        let snapshot = audit.snapshot();
        // Сначала самые старые из оставшихся, в конце — последний вызов.
        assert_eq!(snapshot.first().unwrap().at_ms, 5);
        assert_eq!(snapshot.last().unwrap().at_ms, AUDIT_LIMIT as u64 + 4);
        audit.clear();
        assert_eq!(audit.count(), 0);
    }

    #[test]
    fn time_is_a_sane_millisecond_value() {
        // В 2024 году миллисекунд больше 1.7e12: проверяем, что часы не в секундах.
        assert!(now_ms() > 1_700_000_000_000);
    }
}

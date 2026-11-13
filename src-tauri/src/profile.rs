//! Compile-time application namespaces. Never select them from user-controlled
//! environment variables: a test binary must not silently fall back to stable.

#[cfg(not(feature = "acceptance"))]
pub const APP_ID: &str = "com.tvinoferma.desktop";
#[cfg(feature = "acceptance")]
pub const APP_ID: &str = "com.tvinoferma.desktop.acceptance";

#[cfg(not(feature = "acceptance"))]
pub const TRAY_LABEL: &str = "Твиноферма";
#[cfg(feature = "acceptance")]
pub const TRAY_LABEL: &str = "Твиноферма — ТЕСТОВАЯ СБОРКА";

pub const VAULT_SERVICE: &str = APP_ID;
#[cfg(not(feature = "acceptance"))]
pub const SIMPLE_KEY_SERVICE: &str = "com.tvinoferma.desktop.cloud.simple-key";
#[cfg(feature = "acceptance")]
pub const SIMPLE_KEY_SERVICE: &str = "com.tvinoferma.desktop.acceptance.cloud.simple-key";

#[cfg(not(feature = "acceptance"))]
pub const AUTOSTART_VALUE: &str = "Tvinoferma";
#[cfg(feature = "acceptance")]
pub const AUTOSTART_VALUE: &str = "Tvinoferma Acceptance";
#[cfg(not(feature = "acceptance"))]
pub const AUTOSTART_TASK: &str = "Tvinoferma autostart";
#[cfg(feature = "acceptance")]
pub const AUTOSTART_TASK: &str = "Tvinoferma acceptance autostart";
#[cfg(not(feature = "acceptance"))]
pub const AUTOSTART_XML: &str = "tvinoferma-autostart-task.xml";
#[cfg(feature = "acceptance")]
pub const AUTOSTART_XML: &str = "tvinoferma-acceptance-autostart-task.xml";

#[tauri::command]
pub fn app_build_profile() -> &'static str {
    if cfg!(feature = "acceptance") {
        "acceptance"
    } else {
        "stable"
    }
}

/// Validate before constructing Tauri or running its privileged helper. A CLI
/// config override without the corresponding Cargo feature must never run.
pub fn validate_config_identifier(identifier: &str) -> Result<(), &'static str> {
    if identifier == APP_ID {
        Ok(())
    } else {
        Err("Несовместимы профиль сборки и identifier; запуск остановлен")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_mismatched_identifier_and_keeps_services_in_the_same_profile() {
        assert!(validate_config_identifier(APP_ID).is_ok());
        assert!(validate_config_identifier(if cfg!(feature = "acceptance") {
            "com.tvinoferma.desktop"
        } else {
            "com.tvinoferma.desktop.acceptance"
        })
        .is_err());
        assert_eq!(VAULT_SERVICE, APP_ID);
        assert!(SIMPLE_KEY_SERVICE.starts_with(format!("{APP_ID}.").as_str()));
    }
}

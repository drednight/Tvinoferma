//! Compile-time application namespaces; never select them at runtime from the
//! environment. Shared acceptance is an explicit build with production data.

#[cfg(any(not(feature = "acceptance"), feature = "acceptance-shared"))]
pub const APP_ID: &str = "com.tvinoferma.desktop";
#[cfg(all(feature = "acceptance", not(feature = "acceptance-shared")))]
pub const APP_ID: &str = "com.tvinoferma.desktop.acceptance";

#[cfg(not(feature = "acceptance"))]
pub const PRODUCT_NAME: &str = "Tvinoferma";
#[cfg(all(feature = "acceptance", not(feature = "acceptance-shared")))]
pub const PRODUCT_NAME: &str = "Tvinoferma Acceptance";
#[cfg(feature = "acceptance-shared")]
pub const PRODUCT_NAME: &str = "Tvinoferma Shared Acceptance";

#[cfg(not(feature = "acceptance"))]
pub const TRAY_LABEL: &str = "Твиноферма";
#[cfg(all(feature = "acceptance", not(feature = "acceptance-shared")))]
pub const TRAY_LABEL: &str = "Твиноферма — ТЕСТОВАЯ СБОРКА";
#[cfg(feature = "acceptance-shared")]
pub const TRAY_LABEL: &str = "Твиноферма — ТЕСТ, ОБЩИЕ ДАННЫЕ";

pub const VAULT_SERVICE: &str = APP_ID;
#[cfg(any(not(feature = "acceptance"), feature = "acceptance-shared"))]
pub const SIMPLE_KEY_SERVICE: &str = "com.tvinoferma.desktop.cloud.simple-key";
#[cfg(all(feature = "acceptance", not(feature = "acceptance-shared")))]
pub const SIMPLE_KEY_SERVICE: &str = "com.tvinoferma.desktop.acceptance.cloud.simple-key";

#[cfg(not(feature = "acceptance"))]
pub const AUTOSTART_VALUE: &str = "Tvinoferma";
#[cfg(all(feature = "acceptance", not(feature = "acceptance-shared")))]
pub const AUTOSTART_VALUE: &str = "Tvinoferma Acceptance";
#[cfg(feature = "acceptance-shared")]
pub const AUTOSTART_VALUE: &str = "Tvinoferma Shared Test";
#[cfg(not(feature = "acceptance"))]
pub const AUTOSTART_TASK: &str = "Tvinoferma autostart";
#[cfg(all(feature = "acceptance", not(feature = "acceptance-shared")))]
pub const AUTOSTART_TASK: &str = "Tvinoferma acceptance autostart";
#[cfg(feature = "acceptance-shared")]
pub const AUTOSTART_TASK: &str = "Tvinoferma shared test autostart";
#[cfg(not(feature = "acceptance"))]
pub const AUTOSTART_XML: &str = "tvinoferma-autostart-task.xml";
#[cfg(all(feature = "acceptance", not(feature = "acceptance-shared")))]
pub const AUTOSTART_XML: &str = "tvinoferma-acceptance-autostart-task.xml";
#[cfg(feature = "acceptance-shared")]
pub const AUTOSTART_XML: &str = "tvinoferma-shared-test-autostart-task.xml";

#[tauri::command]
pub fn app_build_profile() -> &'static str {
    if cfg!(feature = "acceptance-shared") {
        "acceptance-shared"
    } else if cfg!(feature = "acceptance") {
        "acceptance"
    } else {
        "stable"
    }
}

/// Validate identity AND product marker before Tauri or a privileged helper.
/// Shared acceptance intentionally uses the stable ID, so ID alone is not enough.
pub fn validate_config_identifier(
    identifier: &str,
    product_name: Option<&str>,
) -> Result<(), &'static str> {
    if identifier == APP_ID && product_name == Some(PRODUCT_NAME) {
        Ok(())
    } else {
        Err("Несовместимы профиль сборки, identifier и productName; запуск остановлен")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_mismatched_configuration_and_keeps_services_in_the_same_profile() {
        assert!(validate_config_identifier(APP_ID, Some(PRODUCT_NAME)).is_ok());
        let other_id = if APP_ID == "com.tvinoferma.desktop.acceptance" {
            "com.tvinoferma.desktop"
        } else {
            "com.tvinoferma.desktop.acceptance"
        };
        assert!(validate_config_identifier(other_id, Some(PRODUCT_NAME)).is_err());
        assert!(validate_config_identifier(APP_ID, Some("Invalid profile")).is_err());
        assert_eq!(VAULT_SERVICE, APP_ID);
        assert!(SIMPLE_KEY_SERVICE.starts_with(format!("{APP_ID}.").as_str()));
    }
}

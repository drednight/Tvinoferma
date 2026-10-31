//! Native-only Desktop client configuration; no secret in IPC responses or state.json.
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientReply {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
}

#[tauri::command]
pub async fn cloud_google_client_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<ClientReply, String> {
    if window.label() != "main" {
        return Err("oauth_client_config_unavailable".into());
    }
    tauri::async_runtime::spawn_blocking(move || execute(&app, None))
        .await
        .map_err(|_| "oauth_client_config_unavailable".to_owned())?
}
#[tauri::command]
pub async fn cloud_google_client_import(
    window: tauri::WebviewWindow,
    app: AppHandle,
    json: String,
) -> Result<ClientReply, String> {
    if window.label() != "main" {
        return Err("oauth_client_config_unavailable".into());
    }
    tauri::async_runtime::spawn_blocking(move || execute(&app, Some(json)))
        .await
        .map_err(|_| "oauth_client_config_unavailable".to_owned())?
}

#[cfg(windows)]
mod storage {
    use super::*;
    use crate::cloud_credential_store::CredentialVault;
    use tauri::Manager;
    const SERVICE: &str = "com.tvinoferma.desktop";
    struct Vault;
    impl CredentialVault for Vault {
        fn read(&mut self, name: &str) -> Result<Option<String>, ()> {
            match keyring::Entry::new(SERVICE, name)
                .map_err(|_| ())?
                .get_password()
            {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(()),
            }
        }
        fn write(&mut self, name: &str, value: &str) -> Result<(), ()> {
            crate::vault::set_local_password(SERVICE, name, value).map_err(|_| ())
        }
        fn remove(&mut self, name: &str) -> Result<(), ()> {
            match keyring::Entry::new(SERVICE, name)
                .map_err(|_| ())?
                .delete_credential()
            {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(()),
            }
        }
    }
    fn access<T>(
        app: &AppHandle,
        operation: impl FnOnce(&mut Vault) -> Result<T, String>,
    ) -> Result<T, String> {
        let _state_guard = super::super::state::lock_state_io()
            .map_err(|_| "oauth_client_config_unavailable".to_owned())?;
        // Same directory as cloud_credentials/reset, NOT state.json's nested data_dir.
        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| "oauth_client_config_unavailable".to_owned())?;
        let lock = crate::cloud_credential_lock::CredentialLock::try_acquire(&path)
            .map_err(|_| "oauth_client_config_unavailable".to_owned())?;
        let result = operation(&mut Vault)?;
        lock.verify()
            .map_err(|_| "oauth_client_config_unavailable".to_owned())?;
        Ok(result)
    }
    pub(super) fn execute(app: &AppHandle, json: Option<String>) -> Result<ClientReply, String> {
        access(app, |vault| {
            let id = match json {
                Some(json) => Some(crate::cloud_google_client::install(vault, &json)?),
                None => crate::cloud_google_client::read(vault)?.map(|c| c.id),
            };
            Ok(ClientReply {
                status: if id.is_some() { "ready" } else { "empty" },
                client_id: id,
            })
        })
    }
    pub(super) fn inject(app: &AppHandle, form: String) -> Result<String, String> {
        access(app, |vault| {
            match crate::cloud_google_client::read(vault)? {
                Some(client) => client.with_form(&form),
                None => Ok(form), // backward compatibility for public clients without a secret
            }
        })
    }
}
#[cfg(windows)]
fn execute(app: &AppHandle, json: Option<String>) -> Result<ClientReply, String> {
    storage::execute(app, json)
}
#[cfg(not(windows))]
fn execute(_app: &AppHandle, _json: Option<String>) -> Result<ClientReply, String> {
    Err("oauth_client_config_unavailable".into())
}

pub(super) async fn inject_google_secret(app: AppHandle, form: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || storage::inject(&app, form))
            .await
            .map_err(|_| "oauth_client_config_unavailable".to_owned())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(form)
    }
}

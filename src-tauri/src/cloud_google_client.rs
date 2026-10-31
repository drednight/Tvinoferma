//! Desktop OAuth configuration, not an encryption key or a user refresh token.
//! Keep client_secret native-only in local Credential Manager. Never log or Debug.
use crate::cloud_credential_binding::{self, Pair};
use crate::cloud_credential_store::{CredentialVault, Provider};
use serde::{Deserialize, Serialize};

pub(crate) const KEY: &str = "cloud-google-desktop-client-v1";
const ERROR: &str = "oauth_client_config_invalid";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    installed: DesktopClient,
}
#[derive(Deserialize, Serialize)]
struct DesktopClient {
    client_id: String,
    client_secret: String,
}

pub(crate) struct Client {
    pub(crate) id: String,
    secret: String,
}
impl Client {
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() > 64 * 1024 {
            return Err(ERROR.into());
        }
        let parsed: Configuration = serde_json::from_str(raw).map_err(|_| ERROR.to_owned())?;
        let client = parsed.installed;
        if !crate::cloud_oauth_transport::valid_client_id(ProviderOAuth::Google, &client.client_id)
            || client.client_secret.is_empty()
            || client.client_secret.len() > 512
            || !client
                .client_secret
                .bytes()
                .all(|b| (0x21..=0x7e).contains(&b))
        {
            return Err(ERROR.into());
        }
        let client = Self {
            id: client.client_id,
            secret: client.client_secret,
        };
        if client.canonical()?.len() > 1200 {
            return Err(ERROR.into());
        }
        Ok(client)
    }
    fn canonical(&self) -> Result<String, String> {
        serde_json::to_string(&Configuration {
            installed: DesktopClient {
                client_id: self.id.clone(),
                client_secret: self.secret.clone(),
            },
        })
        .map_err(|_| ERROR.to_owned())
    }
    pub(crate) fn with_form(&self, form: &str) -> Result<String, String> {
        // The webview may not send client_secret or extra fields.
        if !crate::cloud_oauth_transport::valid_code_form(ProviderOAuth::Google, form)
            && !crate::cloud_oauth_transport::valid_google_refresh_form(form)
        {
            return Err(ERROR.into());
        }
        // Only inject after the pre-existing code/refresh validators accepted the form.
        let mut url = reqwest::Url::parse("https://oauth2.googleapis.com/token")
            .map_err(|_| ERROR.to_owned())?;
        url.set_query(Some(form));
        if url.query_pairs().filter(|(k, _)| k == "client_id").count() != 1
            || !url
                .query_pairs()
                .any(|(k, v)| k == "client_id" && v == self.id)
            || url.query_pairs().any(|(k, _)| k == "client_secret")
        {
            return Err(ERROR.into());
        }
        url.query_pairs_mut()
            .append_pair("client_secret", &self.secret);
        Ok(url.query().ok_or_else(|| ERROR.to_owned())?.to_owned())
    }
}
use crate::cloud_oauth_transport::Provider as ProviderOAuth;

pub(crate) fn bundled() -> Result<Option<Client>, String> {
    match (
        option_env!("TVINOFERMA_GOOGLE_CLIENT_ID"),
        option_env!("TVINOFERMA_GOOGLE_CLIENT_SECRET"),
    ) {
        (None, None) | (Some(""), Some("")) | (None, Some("")) | (Some(""), None) => Ok(None),
        (Some(id), Some(secret)) => {
            let raw = serde_json::json!({"installed":{"client_id":id,"client_secret":secret}})
                .to_string();
            Client::parse(&raw).map(Some)
        }
        _ => Err(ERROR.into()),
    }
}
pub(crate) fn read(vault: &mut impl CredentialVault) -> Result<Option<Client>, String> {
    match vault
        .read(KEY)
        .map_err(|_| "oauth_client_config_unavailable".to_owned())?
    {
        None => bundled(),
        Some(raw) => {
            let parsed = Client::parse(&raw)?;
            if parsed.canonical()? != raw {
                return Err(ERROR.into());
            }
            Ok(Some(parsed))
        }
    }
}
pub(crate) fn install(vault: &mut impl CredentialVault, json: &str) -> Result<String, String> {
    let client = Client::parse(json)?;
    // Importing settings is never permission to change an existing account binding.
    match cloud_credential_binding::read(vault, Provider::Google)
        .map_err(|_| "oauth_client_config_unavailable".to_owned())?
    {
        Pair::Blocked => return Err("oauth_client_config_blocked".into()),
        Pair::Ready { binding, .. } if binding.pending || binding.client_id != client.id => {
            return Err("oauth_client_config_blocked".into())
        }
        _ => {}
    }
    let raw = client.canonical()?;
    vault
        .write(KEY, &raw)
        .map_err(|_| "oauth_client_config_unavailable".to_owned())?;
    if vault
        .read(KEY)
        .map_err(|_| "oauth_client_config_unavailable".to_owned())?
        .as_deref()
        != Some(raw.as_str())
    {
        return Err("oauth_client_config_unavailable".into());
    }
    Ok(client.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "123-example.apps.googleusercontent.com";
    #[test]
    fn accepts_installed_not_web_and_never_uses_imported_urls() {
        let raw = format!(
            r#"{{"installed":{{"client_id":"{ID}","client_secret":"FAKE_SECRET&+","token_uri":"https://evil.invalid","redirect_uris":["https://evil.invalid"]}}}}"#
        );
        let client = Client::parse(&raw).unwrap();
        assert_eq!(client.id, ID);
        assert!(Client::parse(&raw.replace("installed", "web")).is_err());
        assert!(Client::parse(&raw.replace("FAKE_SECRET&+", "")).is_err());
        assert!(Client::parse(&raw.replace("FAKE_SECRET&+", "bad\\nsecret")).is_err());
        assert!(Client::parse(&raw.replace("FAKE_SECRET&+", &"x".repeat(513))).is_err());
        let form = format!("grant_type=authorization_code&client_id={ID}&code=test&code_verifier={}&redirect_uri=http%3A%2F%2F127.0.0.1%3A37181%2Foauth%2Fcloud%2Fcallback", "a".repeat(43));
        assert!(crate::cloud_oauth_transport::valid_code_form(
            ProviderOAuth::Google,
            &form
        ));
        let added = client.with_form(&form).unwrap();
        assert!(added.contains("client_secret=FAKE_SECRET%26%2B"));
        assert!(client
            .with_form(&(form.clone() + "&client_secret=other"))
            .is_err());
        assert!(client
            .with_form(&form.replace(ID, "different.apps.googleusercontent.com"))
            .is_err());
        let refresh = format!("grant_type=refresh_token&client_id={ID}&refresh_token=FAKE_REFRESH");
        assert!(crate::cloud_oauth_transport::valid_google_refresh_form(
            &refresh
        ));
        assert!(client
            .with_form(&refresh)
            .unwrap()
            .contains("client_secret="));
        let duplicate = raw.replace(
            "\"client_secret\":",
            "\"client_secret\":\"first\",\"client_secret\":",
        );
        assert!(Client::parse(&duplicate).is_err());
    }
    #[derive(Default)]
    struct Memory {
        data: std::collections::HashMap<String, String>,
        fail_write: bool,
        corrupt_read: bool,
    }
    impl CredentialVault for Memory {
        fn read(&mut self, k: &str) -> Result<Option<String>, ()> {
            if self.corrupt_read && k == KEY {
                return Ok(Some("corrupt".into()));
            }
            Ok(self.data.get(k).cloned())
        }
        fn write(&mut self, k: &str, v: &str) -> Result<(), ()> {
            if self.fail_write {
                return Err(());
            }
            self.data.insert(k.into(), v.into());
            Ok(())
        }
        fn remove(&mut self, k: &str) -> Result<(), ()> {
            self.data.remove(k);
            Ok(())
        }
    }
    fn config(id: &str, secret: &str) -> String {
        serde_json::json!({"installed":{"client_id":id,"client_secret":secret}}).to_string()
    }
    #[test]
    fn import_readback_replace_and_fail_closed() {
        let mut vault = Memory::default();
        assert_eq!(install(&mut vault, &config(ID, "first")).unwrap(), ID);
        assert_eq!(read(&mut vault).unwrap().unwrap().id, ID);
        // A wrong first selection must not permanently trap an unbound profile.
        let other = "other-client.apps.googleusercontent.com";
        assert_eq!(install(&mut vault, &config(other, "next")).unwrap(), other);
        assert!(read(&mut vault)
            .unwrap()
            .unwrap()
            .with_form(&format!("client_id={ID}"))
            .is_err());
        vault.fail_write = true;
        assert!(install(&mut vault, &config(ID, "third")).is_err());
        vault.fail_write = false;
        vault.corrupt_read = true;
        assert!(read(&mut vault).is_err());
        assert!(install(&mut vault, &config(ID, "third")).is_err());
        assert!(Client::parse(&"x".repeat(65537)).is_err());
    }
    #[test]
    fn cannot_switch_bound_client_or_edit_pending_refresh() {
        let mut vault = Memory::default();
        const SLOT: &str = "11111111-1111-4111-8111-111111111111";
        let record = format!(
            r#"{{"format":"tvinoferma-google-oauth-credential","version":1,"slotId":"{SLOT}","clientId":"{ID}","accountKey":"FAKE_ACCOUNT","revision":"22222222-2222-4222-8222-222222222222","phase":"ready","attemptId":null,"refreshToken":"FAKE_REFRESH","refreshExpiresAt":null}}"#
        );
        assert!(crate::cloud_credential_records::valid_initial(
            Provider::Google,
            SLOT,
            &record
        ));
        assert!(
            cloud_credential_binding::install(&mut vault, Provider::Google, SLOT, &record).is_ok()
        );
        assert!(install(&mut vault, &config(ID, "first")).is_ok());
        assert!(install(
            &mut vault,
            &config("other.apps.googleusercontent.com", "bad")
        )
        .is_err());
        // Explicit same-client repair is allowed without rewriting the account or dataset.
        assert!(install(&mut vault, &config(ID, "rotated")).is_ok());
        let pending = record
            .replace("\"phase\":\"ready\"", "\"phase\":\"pending\"")
            .replace(
                "22222222-2222-4222-8222-222222222222",
                "33333333-3333-4333-8333-333333333333",
            )
            .replace(
                "\"attemptId\":null",
                "\"attemptId\":\"44444444-4444-4444-8444-444444444444\"",
            )
            .replace("\"refreshToken\":\"FAKE_REFRESH\"", "\"refreshToken\":null");
        assert_eq!(
            cloud_credential_binding::compare_exchange(
                &mut vault,
                Provider::Google,
                SLOT,
                &record,
                &pending
            )
            .unwrap(),
            crate::cloud_credential_store::Outcome::Swapped
        );
        assert!(install(&mut vault, &config(ID, "blocked")).is_err());
        assert_eq!(read(&mut vault).unwrap().unwrap().secret, "rotated");
    }
}

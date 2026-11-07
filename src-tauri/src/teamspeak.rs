//! Opt-in local TS3 ClientQuery bridge. No server query, audio capture, or remote hosts.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

static QUERY: Mutex<Option<Query>> = Mutex::new(None);
struct Query {
    io: BufReader<TcpStream>,
    events: Vec<String>,
}
fn overlay_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "teamspeak-overlay" {
        return Err("Untrusted window".into());
    }
    Ok(())
}
#[tauri::command]
pub fn teamspeak_overlay(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !["main", "game-overlay"].contains(&window.label()) {
        return Err("Untrusted window".into());
    }
    if let Some(overlay) = app.get_webview_window("teamspeak-overlay") {
        return overlay
            .show()
            .map_err(|_| "Cannot show TeamSpeak overlay".into());
    }
    let overlay = tauri::WebviewWindowBuilder::new(
        &app,
        "teamspeak-overlay",
        tauri::WebviewUrl::App("teamspeak-overlay.html".into()),
    )
    .title("Твиноферма — TeamSpeak")
    .inner_size(360.0, 520.0)
    .min_inner_size(280.0, 160.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map_err(|_| "Cannot create TeamSpeak overlay")?;
    overlay.on_window_event(|event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut query) = QUERY.lock() {
                *query = None;
            }
        }
    });
    Ok(())
}
#[tauri::command]
pub fn teamspeak_topmost(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    overlay_only(&window)?;
    window
        .set_always_on_top(enabled)
        .map_err(|_| "Cannot update overlay mode".into())
}
fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(' ', "\\s")
        .replace('|', "\\p")
        .replace('/', "\\/")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}
fn unescape(value: &str) -> String {
    let mut result = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            result.push(c);
            continue;
        }
        if let Some(next) = chars.next() {
            result.push(match next {
                's' => ' ',
                'p' => '|',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '/' => '/',
                '\\' => '\\',
                _ => next,
            });
        }
    }
    result
}
fn fields(line: &str) -> Value {
    let mut out = serde_json::Map::new();
    for field in line.split_whitespace() {
        if let Some((key, value)) = field.split_once('=') {
            out.insert(key.to_string(), Value::String(unescape(value)));
        }
    }
    Value::Object(out)
}
impl Query {
    fn command(&mut self, command: &str) -> Result<Vec<Value>, String> {
        self.io
            .get_mut()
            .write_all(format!("{command}\n").as_bytes())
            .map_err(|_| "ClientQuery connection lost")?;
        let mut rows = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut bytes = 0;
        loop {
            if Instant::now() > deadline {
                return Err("ClientQuery response timed out".into());
            }
            // Limit input before allocating an arbitrarily long line from a local service.
            let mut line = String::new();
            let n = self
                .io
                .by_ref()
                .take(262145)
                .read_line(&mut line)
                .map_err(|_| "ClientQuery did not respond")?;
            bytes += n;
            if n == 0 || n > 262144 || bytes > 1048576 {
                return Err("Invalid ClientQuery response".into());
            }
            let line = line.trim();
            if line.starts_with("notify") {
                if self.events.len() < 200 {
                    self.events.push(line.to_string());
                }
            } else if line.starts_with("error ") {
                let error = fields(line);
                if error["id"] == "0" {
                    return Ok(rows);
                }
                return Err(format!(
                    "ClientQuery error {}",
                    error["id"].as_str().unwrap_or("unknown")
                ));
            } else if line.contains('=') {
                rows.extend(line.split('|').map(fields));
                if rows.len() > 10000 {
                    return Err("ClientQuery response too large".into());
                }
            }
        }
    }
}
#[tauri::command]
pub async fn teamspeak3_connect(
    window: tauri::WebviewWindow,
    port: u16,
    api_key: String,
) -> Result<(), String> {
    overlay_only(&window)?;
    if port == 0
        || api_key.is_empty()
        || api_key.len() > 256
        || api_key.chars().any(char::is_control)
    {
        return Err("Invalid ClientQuery settings".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = QUERY.lock().map_err(|_| "ClientQuery busy")?;
        *session = None;
        let stream = TcpStream::connect_timeout(
            &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            Duration::from_secs(2),
        )
        .map_err(|_| {
            "Не удалось подключиться к TS3. Включите плагин ClientQuery и проверьте порт."
        })?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| "ClientQuery timeout setup failed")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| "ClientQuery timeout setup failed")?;
        let mut query = Query {
            io: BufReader::new(stream),
            events: Vec::new(),
        };
        query.command(&format!("auth apikey={}", escape(&api_key)))?;
        query.command("clientnotifyregister schandlerid=0 event=any")?;
        *session = Some(query);
        Ok(())
    })
    .await
    .map_err(|_| "ClientQuery worker failed")?
}
#[tauri::command]
pub async fn teamspeak3_poll(window: tauri::WebviewWindow) -> Result<Value, String> {
    overlay_only(&window)?;
    tauri::async_runtime::spawn_blocking(|| {
        let mut session = QUERY.lock().map_err(|_| "ClientQuery busy")?;
        let query = session.as_mut().ok_or("ClientQuery not connected")?;
        let result = (|| {
            let handler = query.command("currentschandlerid")?.first().cloned().unwrap_or(json!({}));
            let id = handler["schandlerid"].as_str().unwrap_or("0");
            if !id.bytes().all(|c| c.is_ascii_digit()) { return Err("Invalid TS3 handler".into()); }
            if id == "0" { query.events.clear(); return Ok(json!({ "connected": false, "members": [], "messages": [] })); }
            query.command(&format!("use schandlerid={id}"))?;
            let me = match query.command("whoami") {
                Ok(rows) => rows.first().cloned().unwrap_or(json!({})),
                Err(error) if error.starts_with("ClientQuery error ") => { query.events.clear(); return Ok(json!({ "connected": false, "members": [], "messages": [] })); },
                Err(error) => return Err(error),
            };
            let cid = me["cid"].as_str().unwrap_or("0");
            if !cid.bytes().all(|c| c.is_ascii_digit()) { return Err("Invalid TS3 channel".into()); }
            let clients = query.command("clientlist -voice")?;
            let channel = query.command(&format!("channelvariable cid={cid} channel_name"))?.first().cloned().unwrap_or(json!({}));
            let messages: Vec<Value> = std::mem::take(&mut query.events).into_iter().filter_map(|line| {
                if !line.starts_with("notifytextmessage ") { return None; }
                let row = fields(&line);
                // Only channel chat from this connection. Never surface private/server messages.
                if row["targetmode"] != "2" || row["target"].as_str().is_some_and(|target| target != cid) || row["schandlerid"].as_str().is_some_and(|h| h != id) { return None; }
                Some(json!({ "author": row["invokername"], "text": row["msg"] }))
            }).collect();
            let members: Vec<Value> = clients.into_iter().filter(|c| c["cid"] == cid && c["client_type"] != "1").map(|c| json!({
                "id": c["clid"], "name": c["client_nickname"], "talking": c["client_flag_talking"] == "1",
                "self": c["clid"] == me["clid"], "muted": c["client_input_muted"] == "1" || c["client_output_muted"] == "1"
            })).collect();
            Ok(json!({ "connected": true, "connectionId": id, "channelId": cid, "channel": channel["channel_name"], "members": members, "messages": messages }))
        })();
        if result.is_err() { *session = None; }
        result
    }).await.map_err(|_| "ClientQuery worker failed")?
}
#[tauri::command]
pub async fn teamspeak3_disconnect(window: tauri::WebviewWindow) -> Result<(), String> {
    overlay_only(&window)?;
    tauri::async_runtime::spawn_blocking(|| {
        *QUERY.lock().map_err(|_| "ClientQuery busy")? = None;
        Ok(())
    })
    .await
    .map_err(|_| "ClientQuery worker failed")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_values_are_escaped_once() {
        let input = "name | \\test/\nnext";
        assert_eq!(unescape(&escape(input)), input);
        assert_eq!(
            fields("clid=3 client_nickname=A\\sB client_flag_talking=1")["client_nickname"],
            "A B"
        );
        assert!(!escape("x\nauth apikey=x").contains('\n'));
    }
    #[test]
    fn query_frames_notifications_and_errors_without_exposing_key() {
        use std::net::TcpListener;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut command = String::new();
            reader.read_line(&mut command).unwrap();
            assert_eq!(command, "whoami\n");
            reader.get_mut().write_all(b"TS3 Client\nnotifytalkstatuschange clid=7 status=1\nclid=7 cid=2\nerror id=0 msg=ok\n").unwrap();
            command.clear();
            reader.read_line(&mut command).unwrap();
            reader
                .get_mut()
                .write_all(b"error id=256 msg=secret\\svalue\n")
                .unwrap();
        });
        let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut query = Query {
            io: BufReader::new(stream),
            events: Vec::new(),
        };
        assert_eq!(query.command("whoami").unwrap()[0]["cid"], "2");
        assert_eq!(query.events.len(), 1);
        assert_eq!(
            query.command("whoami").unwrap_err(),
            "ClientQuery error 256"
        );
        server.join().unwrap();
    }
}

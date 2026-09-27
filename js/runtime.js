export function getRuntime() {
  return window.__TAURI_INTERNALS__ || window.__TAURI__ ? 'tauri' : 'browser';
}
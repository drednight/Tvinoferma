// js/modules/automation/collectionSync.js
// Забирает отчёты панели «Коллекция» из видимых окон персонажей и кладёт их в журнал (Issue #72).
// Канал: панель в окне пишет отчёт в hash адреса (`#TFCOL1_…`), Rust-команда `take_collection_reports` читает адреса окон
// приложения, возвращает отчёты и убирает hash — для окна это подтверждение. Сайт при этом не трогается.

import { state } from '../../core/state.js';
import { recordCollectionReports } from './collectionStore.js';
import './collectionLogView.js';

const EVERY_MS = 3000;
let timer = null;
let busy = false;

const nickOf = (charId) => (state.characters || []).find(c => c.id === charId)?.nick || '';

/** Один опрос окон. Возвращает число новых записей журнала. */
export async function pollCollectionReports() {
  if (busy || !window.__TAURI_INTERNALS__) return 0;
  busy = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const reports = await invoke('take_collection_reports');
    return Array.isArray(reports) && reports.length ? recordCollectionReports(reports, nickOf) : 0;
  } catch (e) {
    console.warn('[COLLECTION]', e);
    return 0;
  } finally {
    busy = false;
  }
}

/** Включает или выключает периодический опрос (вместе с настройкой «Мини-игра «Коллекция»»). */
export function startCollectionSync(enabled) {
  if (timer) { clearInterval(timer); timer = null; }
  if (enabled && window.__TAURI_INTERNALS__) timer = setInterval(pollCollectionReports, EVERY_MS);
}

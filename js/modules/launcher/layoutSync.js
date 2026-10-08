// Настройки → Запуск игры → «Layout»: образец раскладки интерфейса копируется поверх остальных .ini
// в папке Layout игры, и на них ставится «только для чтения». Файлы меняет Rust (src-tauri/src/layout_sync.rs).
//
// Позже сюда же можно добавить настройки окна из systemsettings.ini (разрешение, FullScreen и т. п.):
// файл лежит рядом, но Layout его намеренно не трогает.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { toast, confirmModal } from '../../core/ui.js';
import { runningClients } from './launch.js';

async function tauriInvoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

/** Пути из настроек (Настройки → Запуск игры → Layout). */
export function layoutPaths(settings = state.settings) {
  const l = settings?.launcher || {};
  return { dir: String(l.layoutDir || '').trim(), template: String(l.layoutTemplate || '').trim() };
}

/** Имя файла из полного пути (Windows и обычные слеши). */
export function baseName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** @param {{ targets: Array<{ name: string, readOnly: boolean }>, templateInDir: boolean }} report */
export function layoutSummaryText(report, template = '') {
  const n = report?.targets?.length || 0;
  if (!n) return 'В папке нет других файлов .ini: менять нечего.';
  const ro = report.targets.filter(f => f.readOnly).length;
  const files = `${n} ${plural(n, 'файл', 'файла', 'файлов')}`;
  const tail = ro ? ` Из них «только для чтения» уже: ${ro}.` : '';
  const tpl = template ? ` Образец: ${baseName(template)}.` : ' Выберите файл-образец.';
  return `Будет заменено: ${files}.${tail}${tpl}`;
}

/** @param {{ replaced: string[], unchanged: string[], failed: Array<{ name: string, error: string }>, backupDir?: string|null }} report */
export function layoutApplyText(report) {
  const parts = [];
  const r = report?.replaced?.length || 0;
  const u = report?.unchanged?.length || 0;
  const f = report?.failed?.length || 0;
  if (r) parts.push(`заменено: ${r}`);
  if (u) parts.push(`уже совпадали: ${u}`);
  if (f) parts.push(`с ошибкой: ${f} (${report.failed.slice(0, 3).map(x => `${x.name} — ${x.error}`).join('; ')})`);
  if (!parts.length) return 'Менять было нечего.';
  const backup = report?.backupDir ? ` Прежние файлы сохранены в копии: ${report.backupDir}` : '';
  return `Готово: ${parts.join(', ')}.${backup}`;
}

const errText = (e) => String(e?.message || e);

/**
 * Привязывает панель «Layout» в настройках. Поля путей сохраняет общий обработчик настроек (data-setting),
 * здесь — кнопки выбора, просмотр списка и применение.
 * @param {{ invoke?: Function, running?: () => Promise<any[]>, confirm?: Function }} [deps]
 */
export function bindLayoutPanel(deps = {}) {
  const invoke = deps.invoke || tauriInvoke;
  const running = deps.running || (() => runningClients({ invoke }));
  const ask = deps.confirm || confirmModal;
  const $ = (id) => document.getElementById(id);
  const dirInput = $('layout-dir');
  const tplInput = $('layout-template');
  const summary = $('layout-summary');
  const result = $('layout-result');
  if (!dirInput || !tplInput) return null;

  const setPath = async (key, input, value) => {
    state.settings.launcher[key] = value;
    input.value = value;
    await persist();
    await refresh();
  };

  async function refresh() {
    if (!summary) return;
    const { dir, template } = layoutPaths();
    if (!dir) { summary.textContent = 'Укажите папку Layout.'; return; }
    try {
      const report = await invoke('layout_scan', { dir, template: template || null });
      summary.textContent = layoutSummaryText(report, template);
    } catch (e) {
      summary.textContent = `⚠️ ${errText(e)}`;
    }
  }

  async function pick(cmd, key, input, initial) {
    try {
      const path = await invoke(cmd, { initial: initial || null });
      if (path) await setPath(key, input, path);
    } catch (e) { toast(errText(e), 'error'); }
  }

  $('layout-dir-btn')?.addEventListener('click', () => pick('layout_pick_folder', 'layoutDir', dirInput, layoutPaths().dir));
  $('layout-template-btn')?.addEventListener('click', () => pick('layout_pick_file', 'layoutTemplate', tplInput, layoutPaths().dir));
  dirInput.addEventListener('change', refresh);
  tplInput.addEventListener('change', refresh);

  $('layout-apply-btn')?.addEventListener('click', async () => {
    const { dir, template } = layoutPaths();
    if (!dir || !template) { toast('Укажите папку Layout и файл-образец.', 'warning'); return; }
    try {
      // Игра пишет раскладку при выходе: если клиент ещё открыт, он перезапишет наши файлы
      const clients = await running();
      if (clients?.length) {
        toast('Сначала закройте окна игры: при выходе игра перезапишет файлы layout.', 'warning', 5000);
        return;
      }
      const scan = await invoke('layout_scan', { dir, template });
      const n = scan.targets.length;
      if (!n) { toast('В папке нет других файлов .ini: менять нечего.', 'info'); return; }
      const ok = await ask({
        title: 'Заменить layout?',
        text: `Файл «${baseName(template)}» будет скопирован поверх ${n} ${plural(n, 'файла', 'файлов', 'файлов')} в папке «${dir}», и на них встанет «только для чтения». Прежние файлы сохранятся в резервной копии в данных приложения. Файл systemsettings.ini не меняется.`,
        okText: 'Заменить',
        danger: true
      });
      if (!ok) return;
      const report = await invoke('layout_apply', { dir, template });
      const text = layoutApplyText(report);
      if (result) result.textContent = text;
      toast(text, report.failed?.length ? 'warning' : 'success', 5000);
      await refresh();
    } catch (e) { toast(errText(e), 'error'); }
  });

  $('layout-unlock-btn')?.addEventListener('click', async () => {
    const { dir, template } = layoutPaths();
    if (!dir) { toast('Укажите папку Layout.', 'warning'); return; }
    try {
      const done = await invoke('layout_unlock', { dir, template: template || null });
      const text = done.length ? `«Только для чтения» снято с файлов: ${done.length}.` : 'Все файлы и так доступны для записи.';
      if (result) result.textContent = text;
      toast(text, 'info');
      await refresh();
    } catch (e) { toast(errText(e), 'error'); }
  });

  refresh();
  return { refresh };
}

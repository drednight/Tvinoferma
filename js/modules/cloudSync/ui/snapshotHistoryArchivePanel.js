// @ts-check
// Read-only safety step before retention. No deletion or cloud/local state writes here.
import {
  prepareSnapshotHistoryArchive,
  downloadSnapshotHistoryArchive,
  verifySnapshotHistoryArchive
} from '../snapshotFileExchange.js';
import { bindSnapshotHistoryMaintenancePanel } from './snapshotHistoryMaintenancePanel.js';
import { MAX_HISTORY_ARCHIVE_BYTES } from '../snapshotHistoryArchive.js';
import { confirmModal } from '../../../core/ui.js';
import { recordCloudActivity } from '../cloudEventLog.js';
const STATUS = {
  legacy_queue_pending:
    'Сначала завершите прежнюю очередь в старом режиме. Неотправленные партии не входят в облачный архив.',
  pending_upload: 'Сначала завершите или явно снимите незавершённую отправку. Она не входит в облачный архив.',
  unsettled_uploads:
    'Есть неизвестные попытки. Сначала найдите их файлы и подтвердите итоговую версию; архив не должен выдавать неполную историю за полную.',
  archive_changed: 'Подготовка или файл изменились. Подготовьте архив заново.',
  remote_changed:
    'Облачная история изменилась после подготовки. Этот файл может остаться старой копией; для актуальной проверки подготовьте новый архив.',
  archive_invalid: 'Архив не прошёл проверку. Не удаляйте облачные файлы; повторите подготовку и сохранение.',
  state_changed_or_unsaved: 'Местные данные изменились или не сохранены. Сохраните их и повторите подготовку.',
  binding_blocked: 'Привязка набора недоступна или изменилась. Ничего не удалялось.'
};
/** @param {{desktop:boolean,doc?:Document,loadNative?:()=>Promise<any>,prepare?:(options:any)=>Promise<any>,download?:typeof downloadSnapshotHistoryArchive,verify?:(options:any)=>Promise<any>,confirm?:(text:string)=>boolean|Promise<boolean>,saveFile?:(file:any)=>void}} options */
export function bindSnapshotHistoryArchivePanel(options) {
  const doc = options.doc || document,
    root = doc.getElementById('cloud-history-archive');
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
  const provider = /** @type {HTMLSelectElement} */ (doc.getElementById('cloud-registration-provider'));
  const prepare = /** @type {HTMLButtonElement} */ (doc.getElementById('cloud-history-prepare')),
    download = /** @type {HTMLButtonElement} */ (doc.getElementById('cloud-history-download')),
    verify = /** @type {HTMLButtonElement} */ (doc.getElementById('cloud-history-verify')),
    file = /** @type {HTMLInputElement} */ (doc.getElementById('cloud-history-file')),
    status = doc.getElementById('cloud-history-status');
  if (!provider || !prepare || !download || !verify || !file || !status) return;
  let busy = false,
    view = null,
    generation = 0;
  const note = text => {
    status.textContent = options.desktop
      ? text
      : 'Архив облачной истории доступен только в настольном приложении. Веб-предпросмотр ничего не скачивает и не отправляет.';
  };
  const controls = () => {
    prepare.disabled = busy || !options.desktop;
    download.disabled = busy || !view || !options.desktop;
    file.disabled = busy || !view || !options.desktop;
    verify.disabled = busy || !view || !file.files?.length || !options.desktop;
  };
  function clear() {
    view?.cancel?.();
    view = null;
    file.value = '';
    controls();
  }
  const native = options.loadNative || (() => import('@tauri-apps/api/core'));
  const ask =
    options.confirm ||
    (text => confirmModal({ title: 'Зашифрованный архив истории', text, okText: 'Сохранить архив' }));
  const save =
    options.saveFile ||
    (value => {
      const blob = new Blob([value.text], { type: 'application/json' }),
        url = URL.createObjectURL(blob),
        link = doc.createElement('a');
      link.href = url;
      link.download = value.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  function report(provider, value) {
    note(
      STATUS[value.status] ||
        'Операция не подтверждена. Проверьте подключение и сохранение; облачные файлы не изменялись.'
    );
    try {
      recordCloudActivity(provider, 'history_archive', 'blocked');
    } catch {
      /* no raw errors */
    }
  }
  async function run(action) {
    if (busy || root.dataset.busy === 'true' || !options.desktop) return;
    const token = generation,
      disk = provider.value === 'google' ? 'google' : 'yandex',
      selected = file.files?.[0];
    busy = true;
    root.dataset.busy = 'true';
    controls();
    try {
      if (action === 'download') {
        const current = view;
        if (!current) return;
        if (
          !(await ask(
            'Сохранить все проверенные облачные версии в отдельный файл? Он содержит зашифрованные снимки, включая ранее переданные пароли и контакты, и код сверки, но не ключ или OAuth-токены. Нужен сохранённый отдельно пароль либо запасной ключ. Это не копия местного state.json или Windows vault и не разрешение удалять файлы на диске.'
          )) ||
          token !== generation ||
          view !== current
        )
          return;
        const value = (options.download || downloadSnapshotHistoryArchive)({ review: current, confirmed: true });
        if (value.status !== 'archive_download') {
          report(disk, value);
          return;
        }
        save(value);
        note(
          'Файл передан браузеру для сохранения. Это ещё не подтверждение записи. Выберите сохранённый .tf-history.json ниже и сверьте его чтением.'
        );
        return;
      }
      if (action === 'verify' && (!view || !selected)) return;
      if (selected && action === 'verify' && selected.size > MAX_HISTORY_ARCHIVE_BYTES) {
        note('Файл слишком большой. Ничего не прочитано и не изменено.');
        return;
      }
      const bridge = await native();
      if (token !== generation) return;
      const opts = { provider: disk, invoke: bridge.invoke };
      if (action === 'prepare') {
        clear();
        note('Чтение и проверка облачной истории. Архив ещё не сохранён.');
        const value = await (options.prepare || prepareSnapshotHistoryArchive)(opts);
        if (token !== generation) {
          if ('cancel' in value && typeof value.cancel === 'function') value.cancel();
          return;
        }
        if (value.status !== 'archive_ready') {
          report(disk, value);
          return;
        }
        view = value;
        file.value = '';
        note(
          `Подготовлено версий: ${value.capacity.storedVersions ?? value.capacity.versions} из ${value.capacity.maxVersions}; голов: ${value.heads}. Размер архива: ${(value.bytes / 1024 / 1024).toFixed(2)} MiB. Защищено версий: ${value.capacity.protectedVersions}; безопасно удаляемых: ${value.capacity.deletableVersions}. Для очистки нужна отдельная проверка архива и подтверждение ниже.${value.capacity.nearLimit ? ' История близка к пределу. Архив сохранит копию, но не освободит лимит.' : ''}`
        );
      } else {
        const text = await selected.text();
        if (token !== generation) return;
        const value = await (options.verify || verifySnapshotHistoryArchive)({ ...opts, review: view, text });
        if (token !== generation) return;
        if (value.status !== 'archive_verified') {
          report(disk, value);
          return;
        }
        root.dispatchEvent(
          new CustomEvent('tf-history-archive-verified', { detail: { review: view, provider: disk } })
        );
        note(
          `Сохранённый архив сверен чтением: ${value.versions} версий; состав облака совпал с подготовкой. Пароль или запасной ключ храните отдельно. Облачные файлы не удалялись: без новой контрольной версии их удалять нельзя. Это не проверка аварийного питания или сохранности носителя.`
        );
        try {
          recordCloudActivity(disk, 'history_archive', 'success');
        } catch {
          /* no raw errors */
        }
      }
    } catch {
      note('Операция не подтверждена. Значения и исходные ошибки не выводились; облачные файлы не изменялись.');
    } finally {
      busy = false;
      root.dataset.busy = 'false';
      controls();
    }
  }
  prepare.addEventListener('click', () => void run('prepare'));
  download.addEventListener('click', () => void run('download'));
  verify.addEventListener('click', () => void run('verify'));
  file.addEventListener('change', () => {
    generation++;
    note('Выбранный файл ещё не сверен. Нажмите «Сверить сохранённый файл».');
    controls();
  });
  provider.addEventListener('change', () => {
    generation++;
    clear();
    note('Диск изменён. Подготовьте отдельный архив этого набора.');
  });
  for (const event of ['tf-persisted', 'tf-cloud-applied'])
    doc.defaultView?.addEventListener(event, () => {
      if (busy || !options.desktop) return;
      generation++;
      clear();
      note('Местное состояние изменилось. Подготовка архива сброшена.');
    });
  bindSnapshotHistoryMaintenancePanel(options);
  if (!options.desktop) note('');
  controls();
}

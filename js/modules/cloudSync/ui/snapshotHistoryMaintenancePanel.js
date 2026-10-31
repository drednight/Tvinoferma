// @ts-check
// Opaque reviews + metadata only. Never put encrypted archive contents or secret
// values in DOM, logs, confirm text, or persisted UI preferences.
import * as exchange from '../snapshotFileExchange.js';
import { MAX_HISTORY_ARCHIVE_BYTES } from '../snapshotHistoryArchive.js';
import { confirmModal } from '../../../core/ui.js';
import { recordCloudActivity } from '../cloudEventLog.js';
const MESSAGES = {
  sent_verified:
    'Контрольный файл прочитан и подтверждён. Старые файлы ещё не удалены. Выберите сохранённый до сокращения архив ниже и отдельно проверьте очистку.',
  verification_pending:
    'Результат отправки неизвестен. Завершите проверку ожидания в основном блоке файла; повторной отправки не будет.',
  retirement_unknown:
    'Результат очистки неизвестен. Автоматического повтора нет. Снова проверьте архив: исчезнувший файл будет подтверждён чтением. Если файл остаётся, проверьте корзину и явно снимите ожидание только после проверки.',
  retirement_not_sent:
    'Удаление не отправлено. Подготовленная операция сохранена; проверьте привязку и настольный транспорт.',
  retirement_released_uncertain:
    'Ожидание снято, но запрос не отменён: прежний файл ещё может попасть в корзину. Не восстанавливайте облачные файлы вручную до выяснения результата. Снова проверьте архив перед новой очисткой.',
  retirement_pending: 'Есть отдельное ожидание очистки. Проверяйте его в этом блоке, не в отправке полного файла.',
  archive_invalid: 'Архив не прошёл проверку по доверенному корню и ключу. Ничего не восстановлено.',
  archive_changed: 'Архив или просмотр изменился. Выберите правильный сохранённый файл и проверьте заново.',
  full_file_required:
    'Сначала отправьте полный файл в основном блоке. Для исходной корневой версии сокращение не требуется.',
  checkpoint_required:
    'Нужна единственная текущая контрольная версия. Сначала создайте и подтвердите контрольный файл.',
  accepted_file_required: 'Сначала явно примите нужную облачную версию в основном блоке файла.',
  private_confirmation_required:
    'Для контрольного файла отдельно подтвердите сохранение уже отправленных контактов. Местные секреты не отправляются.',
  verified_archive_required: 'Сначала подготовьте, сохраните и сверьте архив чтением выше.',
  remote_changed:
    'Состав или дата облачных файлов изменились. Очистка остановлена. Оставьте архив и проверьте версии заново; неизвестные новые файлы не удаляются.',
  state_changed_or_unsaved: 'Местное состояние изменилось или не сохранено. Сохраните данные и повторите проверку.',
  pending_upload: 'Сначала завершите или явно согласуйте прежнюю отправку/очистку и неизвестные попытки.',
  multiple_files: 'На диске несколько версий. Сначала выберите и подтвердите нужную в основном блоке.',
  private_source_unavailable: 'Местные контакты или Windows vault недоступны. Восстановление заблокировано.',
  private_consent_required: 'Подтвердите выбранные категории контактов и отдельный риск паролей.',
  private_backup_required: 'Для восстановления контактов подтвердите отдельную копию контактов и Windows vault.',
  applied:
    'Выбранная архивная версия восстановлена местно после резервного копирования. Принятая облачная база и файлы диска не изменялись. Для отправки местного состояния используйте основную кнопку полного файла.'
};
/** @param {{desktop:boolean,doc?:Document,loadNative?:()=>Promise<any>,confirm?:(text:string)=>boolean|Promise<boolean>,maintenanceApi?:any}} options */
export function bindSnapshotHistoryMaintenancePanel(options) {
  const doc = options.doc || document,
    root = doc.getElementById('cloud-history-archive'),
    panel = doc.getElementById('cloud-history-maintenance');
  if (!root || !panel || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  const el = id => doc.getElementById('cloud-history-' + id),
    provider = /** @type {HTMLSelectElement} */ (doc.getElementById('cloud-registration-provider')),
    file = /** @type {HTMLInputElement} */ (el('maintenance-file')),
    versions = /** @type {HTMLSelectElement} */ (el('version')),
    note = el('maintenance-status'),
    list = el('restore-differences'),
    contacts = el('restore-contacts');
  const api = options.maintenanceApi || exchange,
    load = options.loadNative || (() => import('@tauri-apps/api/core')),
    ask = options.confirm || (text => confirmModal({ title: 'История полного файла', text, okText: 'Подтвердить' }));
  let busy = false,
    generation = 0,
    verified = null,
    cleanup = null,
    archive = null,
    restore = null;
  const checked = id => /** @type {HTMLInputElement} */ (el(id)).checked;
  function status(text) {
    note.textContent = options.desktop
      ? text
      : 'Обслуживание истории доступно только в настольном приложении. Предпросмотр ничего не отправляет и не удаляет.';
  }
  const fields = () =>
    Array.from(doc.querySelectorAll('#cloud-history-private-fields input:checked')).map(
      e => /** @type {HTMLInputElement} */ (e).value
    );
  function controls() {
    const disabled = busy || !options.desktop,
      consent = checked('paused') && checked('key-backup');
    for (const e of panel.querySelectorAll('input,select,button'))
      /** @type {HTMLInputElement} */ (e).disabled = disabled;
    const button = (id, enabled) => {
      /** @type {HTMLButtonElement} */ (el(id)).disabled = disabled || !enabled;
    };
    button('checkpoint', !!verified && consent);
    button('cleanup-review', !!file.files?.length);
    button('cleanup', !!cleanup && consent);
    button('inspect', !!file.files?.length);
    versions.disabled = disabled || !archive;
    button('restore-review', !!archive && versions.value !== '');
    button('restore-apply', !!restore);
    button('restore-all', !!restore);
    button('restore-none', !!restore);
    for (const e of contacts.querySelectorAll('input'))
      /** @type {HTMLInputElement} */ (e).disabled = disabled || e.getAttribute('data-selectable') === 'false';
  }
  function clearRestore() {
    archive?.cancel?.();
    restore?.cancel?.();
    archive = restore = null;
    versions.replaceChildren();
    list.replaceChildren();
    contacts.replaceChildren();
  }
  function reset() {
    generation++;
    verified = null;
    cleanup?.cancel?.();
    cleanup = null;
    clearRestore();
    controls();
  }
  function report(value) {
    status(
      MESSAGES[value.status] ||
        'Операция не подтверждена. Проверьте ожидания, привязку и сохранённый архив. Исходные ошибки и значения не выводятся.'
    );
  }
  async function run(action) {
    if (busy || root.dataset.busy === 'true' || !options.desktop) return;
    const token = generation,
      disk = provider.value === 'google' ? 'google' : 'yandex',
      selected = file.files?.[0],
      valid = () => token === generation;
    busy = true;
    root.dataset.busy = 'true';
    controls();
    try {
      if (['cleanup-review', 'inspect'].includes(action) && (!selected || selected.size > MAX_HISTORY_ARCHIVE_BYTES)) {
        status('Выберите архив допустимого размера. Файл не прочитан.');
        return;
      }
      const bridge = await load();
      if (!valid()) return;
      const opts = { provider: disk, invoke: bridge.invoke };
      let result;
      if (action === 'checkpoint') {
        if (!verified || !checked('paused') || !checked('key-backup')) return;
        if (
          !(await ask(
            'Создать контрольный файл точной принятой облачной версии после сверки сохранённого архива? Местные правки не входят в него. Все остальные ПК должны быть остановлены и обновлены. Старые файлы пока останутся на диске.'
          )) ||
          !valid()
        )
          return;
        result = await api.publishSnapshotHistoryCheckpoint({
          ...opts,
          archiveReview: verified,
          confirmed: true,
          allDevicesPausedConfirmed: true,
          independentKeyBackupConfirmed: true,
          privateCarryConfirmed: checked('carry')
        });
        verified = null;
      } else if (action === 'cleanup-review') {
        cleanup?.cancel?.();
        cleanup = null;
        const text = await selected.text();
        if (!valid()) return;
        result = await api.prepareSnapshotHistoryRetirement({ ...opts, text });
        if (valid() && result.status === 'retirement_ready') {
          cleanup = result;
          status(
            `Проверено старых файлов для корзины: ${result.count}. Корневой и контрольный файлы защищены.${result.pending ? ' Есть прежнее ожидание: сначала будет проверен его исход.' : ''} Очистка ещё не запускалась.`
          );
          return;
        }
      } else if (action === 'cleanup') {
        if (!cleanup || !checked('paused') || !checked('key-backup')) return;
        if (
          !(await ask(
            'Переместить проверенные старые файлы в корзину выбранного диска? Архив и отдельный ключ сохранены; все остальные ПК остановлены. Корень и контрольный файл не удаляются. У Яндекса нет атомарной блокировки: не запускайте другие ПК и не меняйте папку вручную до завершения. Неизвестный результат остановит очистку без автоматического повтора.'
          )) ||
          !valid()
        )
          return;
        for (let n = 0; n < 129 && valid(); n++) {
          result = await api.retireNextSnapshotHistoryFile({
            ...opts,
            review: cleanup,
            confirmed: true,
            allDevicesPausedConfirmed: true,
            independentKeyBackupConfirmed: true
          });
          if (!valid()) break;
          if (
            result.status === 'retirement_complete' ||
            (result.status === 'retired_verified' && result.remaining === 0)
          ) {
            cleanup?.cancel?.();
            cleanup = null;
            status(
              'Очистка подтверждена чтением: старые файлы отсутствуют в активной папке; корневой и контрольный файлы сверены. Архив и ключ сохраните. Корзина не очищалась.'
            );
            try {
              recordCloudActivity(disk, 'history_retirement', 'success');
            } catch {
              /* logging must not change the verified result */
            }
            return;
          }
          if (result.status !== 'retired_verified') break;
          status(`Старый файл отсутствует, корень и контрольный файл сверены. Осталось: ${result.remaining}.`);
        }
      } else if (action === 'cleanup-release') {
        if (
          !(await ask(
            'Снять только журнал неизвестной очистки? Это НЕ отменяет запрос: старый файл ещё может попасть в корзину. Проверьте облачную папку и корзину, оставьте архив и не восстанавливайте файлы вручную, пока исход не выяснен. Повторной отправки этой кнопкой нет.'
          )) ||
          !valid()
        )
          return;
        result = await api.releaseSnapshotHistoryRetirement({
          ...opts,
          confirmed: true,
          unknownOutcomeAcknowledged: true
        });
        cleanup?.cancel?.();
        cleanup = null;
      } else if (action === 'inspect') {
        clearRestore();
        const text = await selected.text();
        if (!valid()) return;
        result = await api.inspectSnapshotHistoryArchive({ ...opts, text });
        if (valid() && result.status === 'archive_restore_choices') {
          archive = result;
          const placeholder = doc.createElement('option');
          placeholder.value = '';
          placeholder.textContent = '— Явно выберите версию архива —';
          placeholder.disabled = true;
          placeholder.selected = true;
          versions.append(placeholder);
          for (const [index, choice] of result.choices.entries()) {
            const item = doc.createElement('option');
            item.value = String(index);
            item.textContent = `${choice.head ? 'Вершина архива' : 'Историческая версия'} · ${choice.versionId}${choice.privateAvailable ? ' · есть зашифрованные контакты' : ''}`;
            versions.append(item);
          }
          status(
            `Проверено версий для восстановления: ${result.choices.length}. Выберите одну и покажите изменения. Облако и местные данные не изменялись.`
          );
          return;
        }
      } else if (action === 'restore-review') {
        if (!archive || versions.value === '') return;
        restore?.cancel?.();
        restore = null;
        list.replaceChildren();
        contacts.replaceChildren();
        result = await api.prepareSnapshotHistoryRestore({
          ...opts,
          choice: archive.choices[Number(versions.value)],
          fields: fields(),
          contactsSourceConfirmed: checked('contact-consent'),
          acknowledgePasswordRisk: checked('password-risk')
        });
        if (valid() && result.status === 'archive_restore_review') {
          restore = result;
          for (const entry of result.differences.entries.slice(0, 1000)) {
            const li = doc.createElement('li');
            li.textContent = `${entry.section}${entry.label ? ' · ' + entry.label : ''}: ${entry.kind === 'only_local' ? 'будет удалено' : entry.kind === 'only_cloud' ? 'будет добавлено' : 'будет заменено'}`;
            list.append(li);
          }
          if (result.differences.entries.length > 1000) {
            const li = doc.createElement('li');
            li.textContent = 'Показаны первые 1000 отличий; заменён будет весь выбранный снимок.';
            list.append(li);
          }
          for (const [index, row] of result.rows.entries()) {
            const label = doc.createElement('label'),
              input = doc.createElement('input');
            input.type = 'checkbox';
            input.dataset.index = String(index);
            input.setAttribute('data-selectable', String(row.selectable !== false));
            input.disabled = row.selectable === false;
            label.append(
              input,
              doc.createTextNode(
                `${row.label} · ${row.field}: ${row.clears ? 'очистить местное значение' : 'взять значение архива'}`
              )
            );
            contacts.append(label);
          }
          status(
            'Показаны изменения полной замены, включая удаления. Ни один контакт не выбран автоматически. Значения контактов не показываются. Принятая облачная база останется прежней.'
          );
          return;
        }
      } else if (action === 'restore-apply') {
        if (!restore) return;
        if (
          !(await ask(
            'Полностью заменить переносимые местные данные выбранной исторической версией, включая удаления, и применить только отмеченные контакты? Перед заменой создаётся местная резервная копия. Принятая облачная база и диск не меняются. Для контактов нужна отдельная копия Windows vault.'
          )) ||
          !valid()
        )
          return;
        const selections = Array.from(contacts.querySelectorAll('input:checked'))
          .map(e => restore.rows[Number(/** @type {HTMLElement} */ (e).dataset.index)])
          .map(({ characterId, field }) => ({ characterId, field }));
        result = await api.applySnapshotHistoryRestore({
          ...opts,
          review: restore,
          confirmed: true,
          selections,
          contactsSourceConfirmed: checked('contact-consent'),
          acknowledgePasswordRisk: checked('password-risk'),
          independentBackupConfirmed: checked('contact-backup')
        });
        if (result.status === 'applied') clearRestore();
      }
      if (valid() && result) {
        report(result);
        try {
          recordCloudActivity(
            disk,
            action === 'checkpoint'
              ? 'history_checkpoint'
              : action.startsWith('restore')
                ? 'history_restore'
                : 'history_retirement',
            ['sent_verified', 'applied'].includes(result.status)
              ? 'success'
              : ['retirement_unknown', 'retirement_released_uncertain', 'verification_pending'].includes(result.status)
                ? 'uncertain'
                : 'blocked'
          );
        } catch {
          /* no raw diagnostics */
        }
      }
    } catch {
      if (valid())
        status('Операция не подтверждена. Не повторяйте отправку или очистку без проверки сохранённого ожидания.');
    } finally {
      busy = false;
      root.dataset.busy = 'false';
      controls();
    }
  }
  for (const action of [
    'checkpoint',
    'cleanup-review',
    'cleanup',
    'cleanup-release',
    'inspect',
    'restore-review',
    'restore-apply'
  ])
    el(action).addEventListener('click', () => void run(action));
  for (const [id, value] of [
    ['restore-all', true],
    ['restore-none', false]
  ])
    el(id).addEventListener('click', () => {
      for (const e of contacts.querySelectorAll('input'))
        if (!(/** @type {HTMLInputElement} */ (e).disabled))
          /** @type {HTMLInputElement} */ (e).checked = value === true;
    });
  for (const input of panel.querySelectorAll('input'))
    input.addEventListener('change', () => {
      if (input === file) {
        reset();
        status('Архив ещё не проверен. Выберите очистку или просмотр версий.');
      } else if (
        input.closest('#cloud-history-private-fields') ||
        ['contact-consent', 'password-risk'].some(id => input === el(id))
      ) {
        restore?.cancel?.();
        restore = null;
        contacts.replaceChildren();
        list.replaceChildren();
      }
      controls();
    });
  versions.addEventListener('change', () => {
    restore?.cancel?.();
    restore = null;
    contacts.replaceChildren();
    list.replaceChildren();
    controls();
  });
  provider.addEventListener('change', () => {
    reset();
    file.value = '';
    status('Диск изменён. Сначала выберите и проверьте архив этого набора.');
  });
  el('file')?.addEventListener('change', () => {
    verified = null;
    controls();
  });
  root.addEventListener('tf-history-archive-verified', event => {
    const detail = /** @type {CustomEvent} */ (event).detail;
    if (detail?.provider === provider.value) verified = detail.review;
    controls();
  });
  for (const event of ['tf-persisted', 'tf-cloud-applied'])
    doc.defaultView?.addEventListener(event, () => {
      if (!busy) {
        reset();
        status('Местное состояние изменилось. Проверки обслуживания сброшены.');
      }
    });
  if (!options.desktop) status('');
  controls();
}

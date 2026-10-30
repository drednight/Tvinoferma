// @ts-check
// Два отдельных действия: локальная опция автоматической отправки и ручная
// отправка. Показываются только коды состояния, никогда значения или ошибки IPC.
import { confirmModal } from '../../../core/ui.js';
import { recordCloudActivity } from '../cloudEventLog.js';
import { createPublicationController } from '../publicationController.js';

const MESSAGES = Object.freeze({
  queued: 'Сохранённые изменения подготовлены в зашифрованной локальной очереди.',
  coalesced: 'Последние сохранённые изменения обновили ещё не отправленный снимок в очереди.',
  unchanged: 'Новых изменений относительно локальной очереди не найдено.',
  discarded_unpublished: 'Неотправленное изменение отменено; облако не изменялось.',
  sent_verified: 'Зашифрованный снимок отправлен и сверен чтением с диска.',
  verified_previous_attempt: 'Ранее начатая отправка подтверждена чтением; повторной записи не было.',
  idle: 'Ожидающих отправки изменений нет.',
  offline: 'Нет сети: подготовленные изменения остаются в локальной зашифрованной очереди.',
  root_unconfirmed: 'Сначала отправьте и подтвердите первый снимок на выбранном диске.',
  no_local_lineage:
    'Для этого ПК нет принятой основы. При полном совпадении с единственной версией её можно подтвердить в сравнении.',
  provenance_review_required:
    'После выборочного применения нужно согласовать происхождение изменений. Отправка пока остановлена.',
  accepted_base_mismatch:
    'Принятая облачная основа не совпадает с локальной отметкой. Отправка остановлена; проверьте очередь и данные.',
  deletions_need_review:
    'Обнаружено исчезновение ранее опубликованной записи. Подтверждение удалений ещё не реализовано; отправка остановлена.',
  identity_conflict: 'Идентификатор записи изменил тип. Отправка остановлена; требуется проверка данных.',
  selection_changed: 'Состав переносимых настроек изменился. Нужна отдельная проверка перед отправкой.',
  remote_changes_require_review:
    'На диске есть другая проверенная версия. Отправка остановлена: откройте проверку обновлений и сравните данные.',
  remote_branches_require_review:
    'На диске обнаружены расходящиеся ветви. Отправка остановлена; автоматический выбор победителя не выполняется.',
  history_unverified: 'История диска не прошла проверку известных версий. Ничего не отправлено.',
  latest_not_queued: 'Сохранённые данные изменились после подготовки очереди. Сначала потребуется новый снимок.',
  state_changed_or_unsaved: 'Данные изменились или ещё не сохранены. Новая отправка остановлена.',
  data_unprepared: 'Не удалось подготовить переносимый снимок. Проверьте локальные данные и идентификаторы.',
  identities_unavailable: 'Не удалось безопасно подготовить идентификаторы новых записей.',
  identities_disk_changed_or_unsaved: 'Идентификаторы не сохранены: память и файл различаются.',
  identities_backup_unconfirmed_restart:
    'Резервная копия перед подготовкой ID не подтверждена. Проверьте данные и копии перед перезапуском.',
  identities_write_unconfirmed_restart:
    'Запись идентификаторов не подтверждена. Проверьте данные и копии перед перезапуском.',
  queue_full: 'Локальная очередь достигла безопасного размера. Отправка остановлена.',
  history_limit: 'Достигнут предел проверяемой истории. Автоматическая отправка остановлена.',
  journal_uncertain:
    'Результат записи локальной очереди не подтверждён. Не повторяйте действие до проверки и перезапуска.',
  journal_blocked: 'Локальный журнал не прошёл проверку. Отправка остановлена.',
  binding_or_queue_blocked: 'Привязка, ключ или локальная очередь отсутствуют либо требуют проверки.',
  queue_changed: 'Очередь изменилась во время проверки. Отправка остановлена.',
  changed: 'Локальная очередь или облако изменились во время проверки. Отправка остановлена.',
  needs_verification: 'Результат отправки ещё нужно подтвердить чтением; запрос создания не повторяется.',
  verification_pending:
    'Отправка могла выполниться, но точная сверка пока не подтверждена. Повторный запрос создания не выполняется.',
  cloud_content_mismatch: 'Файл на диске не совпадает с подготовленным. Отправка остановлена; требуется проверка.',
  account_mismatch: 'Аккаунт диска изменился. Отправка остановлена.',
  account_unavailable: 'Аккаунт диска недоступен. Ничего не считайте отправленным.',
  deferred: 'Отправка не начиналась. Подготовленный снимок остаётся в очереди.',
  busy: 'Другая операция синхронизации ещё выполняется.',
  unavailable_or_busy: 'Операция занята или недоступна. Ничего не считайте отправленным.',
  unavailable: 'Диск или локальное хранилище недоступны. Ничего не считайте отправленным.',
  cancelled: 'Действие отменено; уже начатый запрос мог завершиться.',
  more_pending: 'Есть ещё ожидающие проверки изменения; обработка продолжится отдельно.'
});
function providerName(provider) {
  return provider === 'google' ? 'Google Диск' : 'Яндекс Диск';
}
function outcome(status) {
  if (['queued', 'coalesced', 'discarded_unpublished', 'sent_verified', 'verified_previous_attempt'].includes(status))
    return 'success';
  if (['verification_pending', 'journal_uncertain', 'cloud_content_mismatch'].includes(status)) return 'uncertain';
  if (['offline', 'unavailable', 'unavailable_or_busy'].includes(status)) return 'unavailable';
  return 'blocked';
}

/**
 * @param {{doc?:Document,desktop:boolean,loadNative?:()=>Promise<{invoke:(command:string,args:any)=>Promise<any>}>,
 * confirm?:(message:string)=>boolean|Promise<boolean>,controllerFactory?:typeof createPublicationController}} options
 */
export function bindCloudPublicationPanel(options) {
  const doc = options.doc || document;
  const panel = doc.getElementById('cloud-publication-title')?.closest('.cloud-publication');
  const provider = /** @type {HTMLSelectElement|null} */ (doc.getElementById('cloud-registration-provider'));
  const enabled = /** @type {HTMLInputElement|null} */ (doc.getElementById('cloud-publication-auto'));
  const manual = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-publication-send'));
  const status = doc.getElementById('cloud-publication-status');
  const mode = doc.getElementById('cloud-publication-mode');
  const win = doc.defaultView;
  if (!panel || !provider || !enabled || !manual || !status || !mode || !win) return;
  if (panel.getAttribute('data-cloud-publication-bound') === 'true') return;
  panel.setAttribute('data-cloud-publication-bound', 'true');
  const askConfirmation =
    options.confirm ||
    (message =>
      confirmModal({ title: 'Подтверждение синхронизации', text: message, okText: 'Продолжить', danger: true }));
  let lastEvent = '';
  let busy = false;
  let generation = 0;
  const selected = () => /** @type {'google'|'yandex'} */ (provider.value === 'google' ? 'google' : 'yandex');
  const note = text => {
    status.textContent = text;
  };
  function report(disk, stage, result) {
    note(
      `${providerName(disk)}: ${MESSAGES[result] || 'Операция не подтверждена. Проверьте данные и состояние диска.'}`
    );
    if (['unchanged', 'idle', 'busy', 'cancelled', 'more_pending'].includes(result)) return;
    const event = `${disk}:${stage}:${result}`;
    if (event === lastEvent && result !== 'sent_verified' && result !== 'verified_previous_attempt') return;
    lastEvent = event;
    try {
      recordCloudActivity(disk, stage === 'queue' ? 'queue' : 'publish', outcome(result));
    } catch {
      /* журнал не влияет на действие */
    }
  }
  const makeController = options.controllerFactory || createPublicationController;
  const controller = makeController({
    win,
    desktop: options.desktop,
    ...(options.loadNative ? { loadNative: options.loadNative } : {}),
    report
  });
  function render() {
    const active = controller.configuredProvider();
    enabled.checked = active === selected();
    enabled.disabled = !options.desktop || busy;
    manual.disabled = !options.desktop || busy;
    mode.textContent = !options.desktop
      ? 'Отправка и автоматизация доступны только в настольной сборке.'
      : active
        ? `Автоотправка включена на этом ПК для ${providerName(active)}${active !== selected() ? '; сейчас выбран другой диск' : ''}.`
        : 'Автоотправка на этом ПК выключена.';
  }
  enabled.addEventListener('change', async () => {
    if (!options.desktop || busy) return;
    const wantsEnabled = enabled.checked;
    const disk = selected();
    const version = generation;
    busy = true;
    render();
    try {
      if (wantsEnabled) {
        const approved = await askConfirmation(
          `Включить на этом ПК экспериментальную автоотправку сохранений на ${providerName(disk)}? Новые ID будут подготовлены с резервной копией. Перед отправкой данные шифруются; при чужой ветви, удалении или выборочном применении отправка остановится. Настоящий диск и настольная сборка ещё не проверены.`
        );
        if (!approved || version !== generation || selected() !== disk) {
          note('Включение автоматической отправки отменено.');
          return;
        }
        if (!controller.enable(disk)) {
          note('Не удалось подтвердить сохранение разрешения на автоотправку. Проверьте локальное хранилище.');
          return;
        }
        note(`Автоотправка на ${providerName(disk)} включена; первый снимок должен быть подтверждён отдельно.`);
      } else {
        const saved = controller.disable();
        note(
          saved
            ? 'Новые автоматические отправки выключены. Уже начатая операция может завершиться.'
            : 'Автоматизация остановлена в этом окне, но сохранение отключения не подтверждено; проверьте настройки после перезапуска.'
        );
      }
    } catch {
      note('Не удалось подтвердить изменение настройки.');
    } finally {
      busy = false;
      render();
    }
  });
  manual.addEventListener('click', async () => {
    if (!options.desktop || busy) return;
    const disk = selected();
    const version = generation;
    busy = true;
    render();
    try {
      const approved = await askConfirmation(
        `Подготовить и отправить сохранённые изменения на ${providerName(disk)}? Для новых записей будут созданы ID с резервной копией. Данные шифруются до отправки, пароли и контакты исключены. При конфликте, удалении или выборочном применении отправка остановится.`
      );
      if (!approved || version !== generation || selected() !== disk) {
        note('Ручная отправка отменена.');
        return;
      }
      note('Подготавливаем сохранённые изменения и проверяем диск…');
      const result = await controller.runManual(disk);
      if (['busy', 'unavailable', 'cancelled', 'more_pending'].includes(result.status)) note(MESSAGES[result.status]);
    } catch {
      note('Результат отправки не подтверждён. Проверьте состояние и журнал.');
    } finally {
      busy = false;
      render();
    }
  });
  provider.addEventListener('change', () => {
    generation++;
    render();
  });
  win.addEventListener('tf-factory-reset-started', render);
  render();
  return controller;
}

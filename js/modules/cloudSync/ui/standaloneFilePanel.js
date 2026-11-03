// @ts-check
import { cloudChangePath, cloudChangeValue, cloudChangeCounts, folderNextStep } from './cloudFilePresentation.js';
import {
  providerCopyRows,
  readCloudAutoCheck,
  writeCloudAutoCheck,
  clearCloudAutoCheck
} from './cloudCopyPresentation.js';
import { cloudStep, captureCloudFailure, recordCloudDiagnostic } from '../cloudDiagnostics.js';
import {
  cloudAccessDiagnostic,
  CLOUD_ACCESS_MESSAGES,
  withCloudAccessDiagnostic
} from '../providers/cloudAccessDiagnostics.js';
import { createStandaloneFileRuntime } from '../standaloneFileRuntime.js';
import { inspectStateFile } from '../inspectStateFile.js';
import { normalizeState } from '../../../core/state.js';
import { planSyncIdentities } from '../identityMigration.js';
import { MAX_SNAPSHOT_BYTES } from '../envelope.js';
import { validateEncryptionPassword } from '../keyBundle.js';
import { confirmModal } from '../../../core/ui.js';
import { STANDALONE_STATUS_MESSAGES as STATUS, GOOGLE_RECONNECT_STATUSES } from '../standaloneStatus.js';
import { prepareStandaloneSave } from '../standaloneSaveFlow.js';
import { standaloneActivityOutcome, recordCloudActivity } from '../cloudEventLog.js';

import {
  readStandaloneFileOptions,
  writeStandaloneFileOptions,
  clearStandaloneFileOptions
} from './standaloneFileOptions.js';

const COMPARE_STAGES = Object.freeze({
  access: '1 из 5 · Проверяем подключение к диску…',
  download: '2 из 5 · Скачиваем полный файл…',
  verify: '3 из 5 · Проверяем целостность файла…',
  unlock: '4 из 5 · Расшифровываем и проверяем содержимое…',
  compare: '5 из 5 · Сравниваем с данными этого ПК…',
  password: 'Ожидаем пароль шифрования в открытом окне…'
});
// Indeterminate progress: the transport does not expose a trustworthy byte total.
function compareFeedback(doc, card, provider) {
  const box = doc.createElement('div');
  box.className = 'cloud-compare-feedback';
  box.hidden = true;
  const message = doc.createElement('p');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.setAttribute('aria-atomic', 'true');
  const bar = doc.createElement('progress');
  bar.setAttribute('aria-label', 'Скачивание и сравнение выполняется');
  const elapsed = doc.createElement('small');
  elapsed.setAttribute('aria-hidden', 'true');
  box.append(message, bar, elapsed);
  card.append(box);
  let timer = null;
  return {
    start() {
      box.hidden = false;
      box.dataset.state = 'running';
      message.setAttribute('role', 'status');
      bar.setAttribute('aria-busy', 'true');
      bar.hidden = false;
      elapsed.hidden = false;
      const started = Date.now();
      const tick = () => {
        elapsed.textContent = `Прошло ${Math.floor((Date.now() - started) / 1000)} с. Процент загрузки сервером не сообщается.`;
      };
      tick();
      timer = setInterval(tick, 1000);
    },
    stage(stage) {
      if (Object.hasOwn(COMPARE_STAGES, stage)) message.textContent = `${NAMES[provider]} · ${COMPARE_STAGES[stage]}`;
    },
    finish(text, state) {
      this.stop();
      box.dataset.state = state;
      message.textContent = text;
      message.setAttribute('role', state === 'failed' ? 'alert' : 'status');
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      bar.hidden = true;
      elapsed.hidden = true;
      bar.removeAttribute('aria-busy');
    }
  };
}
const NAMES = { google: 'Google Диск', yandex: 'Яндекс Диск' };
const SECTIONS = {
  characters: 'Персонажи',
  parties: 'Пати',
  marathons: 'Марафоны',
  planner: 'Календарь',
  finance: 'Финансы',
  preferences: 'Настройки'
};

const dateLabel = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU') : 'дата не сообщена';
};
/** Password exists only in this dialog and the immediate crypto call. */
export function askStandalonePassword({ doc = document, repeat = false } = {}) {
  return new Promise(resolve => {
    const dialog = doc.createElement('dialog');
    dialog.className = 'modal cloud-key-dialog';
    dialog.setAttribute('aria-labelledby', 'standalone-password-title');
    dialog.innerHTML = `<form novalidate autocomplete="off">
      <h3 id="standalone-password-title">${repeat ? 'Защитите файл паролем' : 'Пароль шифрования'}</h3>
      <p>${repeat ? 'Не менее 8 символов, из них 6 различных. Не используйте простую последовательность. Этот пароль понадобится на другом ПК.' : 'Введите пароль, которым зашифрованы ваши файлы. Сам ввод пароля не заменяет местные данные.'}</p>
      <label>Пароль<input class="input" name="password" type="password" maxlength="1024" aria-describedby="standalone-password-error" autocomplete="${repeat ? 'new-password' : 'current-password'}" /></label>
      ${repeat ? '<label>Повторите пароль<input class="input" name="repeat" type="password" maxlength="1024" aria-describedby="standalone-password-error" autocomplete="new-password" /></label>' : ''}
      <p class="modal-error" role="alert" id="standalone-password-error" hidden></p>
      <div class="cloud-registration-actions"><button class="btn" type="submit">${repeat ? 'Продолжить' : 'Открыть'}</button><button class="btn ghost" type="button" data-cancel>Отмена</button></div>
    </form>`;
    const form = dialog.querySelector('form');
    const password = /** @type {HTMLInputElement} */ (form.elements.namedItem('password'));
    const confirmation = /** @type {HTMLInputElement|null} */ (form.elements.namedItem('repeat'));
    const message = /** @type {HTMLElement} */ (dialog.querySelector('[role="alert"]'));
    const close = value => {
      password.value = '';
      if (confirmation) confirmation.value = '';
      dialog.remove();
      resolve(value);
    };
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      close(null);
    });
    dialog.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    form.addEventListener('input', () => {
      message.textContent = '';
      message.hidden = true;
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        if (repeat) {
          validateEncryptionPassword(password.value);
          if (password.value.normalize('NFC') !== confirmation.value.normalize('NFC'))
            throw new Error('Пароли не совпадают');
        } else if (!password.value) throw new Error('Введите пароль шифрования');
        close(password.value);
      } catch (error) {
        message.textContent = error.message;
        message.hidden = false;
        (confirmation && error.message === 'Пароли не совпадают' ? confirmation : password).focus();
      }
    });
    doc.body.append(dialog);
    dialog.showModal();
    password.focus();
  });
}
/** @param {any} options */
export function bindStandaloneFilePanel(options) {
  const doc = options.doc || document;
  const el = id => doc.getElementById(`cloud-standalone-${id}`);
  const panel = el('panel');
  if (!panel || panel.dataset.standaloneBound === 'true') return;
  panel.dataset.standaloneBound = 'true';
  const status = el('status'),
    files = el('files'),
    reviewPanel = el('review');
  const checkboxes = selector => [...panel.querySelectorAll(selector)];
  const choices = selector =>
    checkboxes(selector)
      .filter(item => item.checked)
      .map(item => item.value);
  const targets = () => choices('[data-standalone-destination]');
  const fields = () => choices('[data-standalone-private]');
  const optionLists = {
    destinations: '[data-standalone-destination]',
    privateFields: '[data-standalone-private]',
    settings: '[data-standalone-setting]'
  };
  const savedOptions = readStandaloneFileOptions(doc);
  if (savedOptions) {
    for (const [key, selector] of Object.entries(optionLists))
      for (const input of checkboxes(selector)) input.checked = savedOptions[key].includes(input.value);
    el('source').value = savedOptions.source;
    el('remember').checked = savedOptions.remember;
  }
  // Consent and backup acknowledgements are intentionally never restored.
  for (const id of ['contacts-confirm', 'password-risk', 'backup-ack']) el(id).checked = false;
  el('source-file-label').hidden = el('source').value !== 'file';
  function updateConsentVisibility() {
    const selected = fields();
    const summary = el('selection-summary');
    if (summary)
      summary.textContent = selected.length
        ? `Личные поля: ${selected.length} · Настройки: ${choices('[data-standalone-setting]').length}`
        : `Без контактов и паролей · Настройки: ${choices('[data-standalone-setting]').length}`;
    if (el('target-summary'))
      el('target-summary').textContent = targets().length
        ? `Выбрано дисков: ${targets().length}`
        : 'Выберите диск ниже';
    const consents = el('consents');
    if (consents) consents.hidden = selected.length === 0;
    const password = el('password-risk-label');
    if (password) password.hidden = !selected.includes('password');
  }
  updateConsentVisibility();
  function saveOptions() {
    const value = {
      version: 1,
      source: el('source').value,
      remember: el('remember').checked,
      backups: true
    };
    for (const [key, selector] of Object.entries(optionLists)) value[key] = choices(selector);
    if (!writeStandaloneFileOptions(doc, value))
      el('options-status').textContent = 'Не удалось запомнить параметры на этом ПК. Выбор действует до закрытия окна.';
  }
  const optionsChanged = event => {
    const input = event.target;
    updateConsentVisibility();
    if (input.matches('[data-standalone-private]')) {
      resetAcknowledgements();
      updateConsentVisibility();
    }
    if (
      input.matches(
        '[data-standalone-destination],[data-standalone-private],[data-standalone-setting],#cloud-standalone-source,#cloud-standalone-remember'
      )
    )
      saveOptions();
  };
  panel.addEventListener('change', optionsChanged);
  const autoCheck = readCloudAutoCheck(doc);
  if (el('startup')) el('startup').checked = autoCheck.startup;
  if (el('interval'))
    el('interval').value = [0, 15, 30, 60].includes(autoCheck.minutes) ? String(autoCheck.minutes) : 'custom';
  if (el('custom-interval')) el('custom-interval').value = String(autoCheck.minutes || 15);
  if (el('custom-interval-label')) el('custom-interval-label').hidden = el('interval')?.value !== 'custom';
  const confirmAction = options.confirm || confirmModal;
  const passwordDialog = options.password || (opts => askStandalonePassword({ doc, ...opts }));
  let runtime = options.runtime || null;
  let stopComparison = null;
  let operationTimer = null;
  let cancelPrivate = null;
  let listedFiles = [];
  const notices = new Map();
  const badge = doc.getElementById('cloud-copy-badge');
  const showDialog = dialog => {
    dialog.hidden = false;
    if (!dialog.open) dialog.showModal();
  };
  function hideReview() {
    reviewPanel.close();
    reviewPanel.hidden = true;
  }
  function clearReview() {
    review = null;
    hideReview();
    if (el('reopen')) el('reopen').hidden = true;
  }
  function startOperation(stage) {
    const box = el('operation');
    if (!box) return;
    box.hidden = false;
    box.dataset.state = 'running';
    box.setAttribute('aria-busy', 'true');
    box.querySelector('progress').hidden = false;
    const started = Date.now();
    const tick = () => {
      el('operation-message').textContent =
        status.textContent || (stage === 'ui_save' ? 'Подготавливаем облачную копию…' : 'Проверяем облачные копии…');
      el('operation-elapsed').textContent =
        `Прошло ${Math.floor((Date.now() - started) / 1000)} с. Процент сервером не сообщается.`;
    };
    tick();
    operationTimer = setInterval(tick, 1000);
  }
  function operationProgress({ provider, stage }) {
    if (stopped || !Object.hasOwn(NAMES, provider)) return;
    const labels = {
      access: 'Проверяем доступ…',
      read: 'Читаем список и проверяем целостность копий…',
      prepare: 'Проверяем папку и готовим отправку…',
      upload: 'Отправляем зашифрованный файл…',
      verify: 'Скачиваем отправленный файл для проверки…'
    };
    if (!Object.hasOwn(labels, stage)) return;
    status.textContent = `${NAMES[provider]} · ${labels[stage]}`;
    if (el('operation-message')) el('operation-message').textContent = status.textContent;
  }
  function finishOperation() {
    if (operationTimer !== null) clearInterval(operationTimer);
    operationTimer = null;
    const box = el('operation');
    if (!box || box.hidden) return;
    box.removeAttribute('aria-busy');
    if (box.dataset.state === 'running') box.dataset.state = 'idle';
    box.querySelector('progress').hidden = true;
    el('operation-message').textContent = status.textContent;
    el('operation-elapsed').textContent = '';
  }
  function updateBadge() {
    if (!badge) return;
    const providers = [...notices].filter(([, value]) => value.length).map(([provider]) => NAMES[provider]);
    badge.hidden = !providers.length;
    badge.textContent = 'Облачная копия ждёт сравнения';
    badge.title = `Непринятая копия: ${providers.join(', ')}. Это копия данных, не обновление приложения. Ничего не заменяется автоматически.`;
  }
  function acknowledgeNotice(token) {
    const pin = `${token.versionId}:${token.sha256}`;
    for (const [provider, pins] of notices)
      notices.set(
        provider,
        pins.filter(item => item !== pin)
      );
    updateBadge();
  }
  const openCloudCopies = () => {
    doc.querySelector('[data-tab="settings"]')?.click();
    const parent = doc.getElementById('cloud-registration-panel');
    if (parent) parent.open = true;
    el('files').scrollIntoView?.({ block: 'center' });
    el('check').focus({ preventScroll: true });
  };
  badge?.addEventListener('click', openCloudCopies);
  el('reopen')?.addEventListener('click', () => {
    if (review) showDialog(reviewPanel);
  });
  el('review-close')?.addEventListener('click', hideReview);
  reviewPanel.addEventListener('cancel', event => {
    event.preventDefault();
    hideReview();
  });
  const keyDialog = el('key-dialog');
  el('key-settings')?.addEventListener('click', () => showDialog(keyDialog));
  keyDialog?.querySelector('[data-cloud-close]')?.addEventListener('click', () => keyDialog.close());

  let busy = false,
    stopped = false,
    review = null,
    reviewFields = [];
  const getRuntime = async () => {
    if (!runtime) {
      const native = options.loadNative ? await options.loadNative() : await import('@tauri-apps/api/core');
      runtime = createStandaloneFileRuntime(native);
    }
    return runtime;
  };
  async function connectForSave(provider) {
    if (stopped) return false;
    return new Promise(resolve => {
      const detail = { provider, handled: false, complete: resolve };
      doc
        .getElementById('cloud-registration-panel')
        ?.dispatchEvent(new CustomEvent('tf-cloud-connect-for-save', { detail }));
      if (!detail.handled) resolve(false);
    });
  }
  function setBusy(value) {
    busy = value;
    for (const input of panel.querySelectorAll('button,input,select')) {
      if (input.closest('#cloud-standalone-private-dialog') || input.hasAttribute('data-cloud-close')) continue;
      input.disabled =
        busy || !options.desktop || stopped || (input.id === 'cloud-standalone-accept' && !!review?.replacementBlocked);
    }
    panel.setAttribute('aria-busy', String(busy));
  }
  function log(provider, action, outcome) {
    try {
      (options.record || recordCloudActivity)(provider, action, outcome);
    } catch {
      /* Logging must not interrupt the operation. */
    }
  }
  async function action(fn, stage = 'ui_action', hooks = {}) {
    if (busy || !options.desktop || stopped) return;
    setBusy(true);
    try {
      saveOptions();
      if (['ui_save', 'ui_check', 'ui_folder_check', 'ui_folder_create'].includes(stage)) {
        status.textContent =
          stage === 'ui_save'
            ? 'Подготавливаем облачную копию…'
            : stage === 'ui_check'
              ? 'Проверяем облачные копии…'
              : stage === 'ui_folder_create'
                ? 'Яндекс Диск · Создаём и проверяем пустую папку…'
                : 'Яндекс Диск · Проверяем обычную папку…';
        startOperation(stage);
      }
      hooks.start?.();
      return await cloudStep(stage, hooks.provider || null, async () => {
        const engine = await getRuntime();
        if (stopped) throw new Error('closed');
        try {
          return await fn(engine);
        } finally {
          try {
            if (!stopped && engine.encryptionStatus) {
              const messages = {
                unlocked:
                  'Ключ шифрования уже открыт в этом запуске или получен из защищённого хранилища ОС — повторный ввод пароля не нужен. Это не означает, что пароль можно посмотреть.',
                locked:
                  'Файлы уже защищены прежним паролем. Ключ закрыт: при сохранении или открытии понадобится тот же пароль.',
                not_created:
                  'При первом сохранении после проверки диска задайте пароль шифрования (не менее 8 символов) и повторите его. Это не пароль Google/Яндекса.'
              };
              el('encryption-status').textContent =
                messages[engine.encryptionStatus()] || 'Для файла другого ключа может понадобиться его пароль.';
            }
          } catch {
            /* An optional key hint must not change the action's result. */
          }
        }
      });
    } catch (error) {
      if (stopped) return;
      const failure = captureCloudFailure(stage, error, hooks.provider || null);
      if (el('operation')) el('operation').dataset.state = 'failed';
      if (el('copy-report')) el('copy-report').hidden = false;
      if (Array.isArray(error.results)) {
        showResults(error.results);
        for (const row of error.results) log(row.provider, 'standalone_save', standaloneActivityOutcome(row));
      }
      status.textContent =
        STATUS[error.message] ||
        `Действие остановлено на этапе ${failure.stage}; код ${failure.code}. Скопируйте отчёт в разделе «Диагностика сейчас» под журналом. Ничего не считайте подтверждённым; ключи и аккаунт удалять не нужно.`;
      hooks.error?.(error, failure);
      return { diagnosticFailed: true };
    } finally {
      hooks.finally?.();
      finishOperation();
      setBusy(false);
    }
  }
  function showResults(results) {
    const failed = results.some(
      row => !['checked', 'empty', 'sent_verified', 'credential_missing'].includes(row.status)
    );
    if (el('copy-report')) el('copy-report').hidden = !failed;
    if (el('operation')) el('operation').dataset.state = failed ? 'failed' : 'success';
    el('provider-results').replaceChildren();
    for (const result of results) {
      const li = doc.createElement('li');
      li.className = 'cloud-provider-result';
      li.dataset.state = ['checked', 'empty', 'sent_verified'].includes(result.status)
        ? 'success'
        : result.status === 'credential_missing'
          ? 'idle'
          : 'failed';
      const diagnostic = cloudAccessDiagnostic(result);
      recordCloudDiagnostic({
        stage: 'provider_result',
        provider: result.provider,
        outcome: ['checked', 'empty', 'sent_verified'].includes(result.status) ? 'ok' : 'blocked',
        code: diagnostic || result.status
      });
      const reconnectHint =
        result.provider === 'google' && GOOGLE_RECONNECT_STATUSES.includes(result.status)
          ? '. Повторный вход — только в прежний аккаунт'
          : '';
      li.textContent = `${NAMES[result.provider]}: ${STATUS[result.status] || 'действие не подтверждено'}${diagnostic ? '. ' + CLOUD_ACCESS_MESSAGES[diagnostic] : ''}${reconnectHint}`;
      if (result.provider === 'yandex' && result.status === 'sent_verified') {
        if (result.storageLocation === 'visible') {
          li.append(' Папка: Яндекс Диск → Твиноферма.');
          folderResult({ status: 'folder_file_verified' }, false);
        } else if (result.storageLocation === 'legacy')
          li.append(' Подтверждён прежний файл в папке приложения, не новая запись в обычную папку.');
      }
      if (result.storageNotice === 'visible_permissions_required')
        li.append(
          ' Старые копии доступны в папке приложения. Для обычной папки «Твиноферма» проверьте права чтения и записи: выйдите и войдите в Яндекс заново.'
        );
      if (reconnectHint) {
        const reconnect = doc.createElement('button');
        reconnect.type = 'button';
        reconnect.className = 'btn ghost small';
        reconnect.textContent = 'Повторить вход Google';
        reconnect.addEventListener('click', () => {
          doc.getElementById('cloud-registration-panel')?.dispatchEvent(new Event('tf-cloud-reconnect-google'));
        });
        li.append(' ', reconnect);
      }
      if (result.status === 'folder_ambiguous' && result.folders?.length) {
        const select = doc.createElement('select');
        select.className = 'input';
        for (const folder of result.folders) {
          const option = doc.createElement('option');
          option.value = folder.folderId;
          option.textContent = `${folder.name} (${folder.folderId})`;
          select.append(option);
        }
        const choose = doc.createElement('button');
        choose.type = 'button';
        choose.className = 'btn ghost';
        choose.textContent = 'Использовать выбранную папку';
        choose.addEventListener('click', () =>
          action(async engine => {
            await engine.chooseGoogleFolder(select.value);
            status.textContent = 'Папка выбрана. Повторите проверку или сохранение полного файла.';
          })
        );
        li.append(select, choose);
      }
      if (result.status === 'verification_pending') {
        const retry = doc.createElement('button');
        retry.type = 'button';
        retry.className = 'btn ghost small';
        retry.textContent = 'Проверить и продолжить прежний файл';
        retry.addEventListener('click', () =>
          action(async engine => {
            const agreed = await confirmAction({
              title: 'Продолжить прежнюю отправку?',
              text: 'Сначала проверим результат. Если файл не найден, повторим только тот же зашифрованный файл с тем же ID, а не текущие данные приложения.',
              okText: 'Проверить и продолжить'
            });
            if (!agreed) return;
            const continued = await engine.continuePending(result.provider);
            showResults([continued]);
            log(
              result.provider,
              'standalone_continue',
              continued.status === 'sent_verified' ? 'success' : cloudAccessDiagnostic(continued) || 'uncertain'
            );
          })
        );
        li.append(' ', retry);
      }
      el('provider-results').append(li);
    }
  }
  async function privacy() {
    if (
      !fields().length ||
      (el('contacts-confirm').checked && (!fields().includes('password') || el('password-risk').checked))
    )
      return true;
    if (options.confirmPrivate) {
      const agreed = await options.confirmPrivate({ fields: fields() });
      if (!agreed) return false;
      el('contacts-confirm').checked = true;
      el('password-risk').checked = fields().includes('password');
      return true;
    }
    updateConsentVisibility();
    const dialog = el('private-dialog');
    return new Promise(resolve => {
      const finish = value => {
        dialog.close();
        el('private-confirm').removeEventListener('click', accept);
        el('private-cancel').removeEventListener('click', cancel);
        dialog.removeEventListener('cancel', cancel);
        cancelPrivate = null;
        if (!value) resetAcknowledgements();
        resolve(value);
      };
      const accept = () => {
        if (el('contacts-confirm').checked && (!fields().includes('password') || el('password-risk').checked))
          finish(true);
      };
      const cancel = event => {
        event?.preventDefault();
        finish(false);
      };
      cancelPrivate = () => finish(false);
      el('private-confirm').addEventListener('click', accept);
      el('private-cancel').addEventListener('click', cancel);
      dialog.addEventListener('cancel', cancel);
      status.textContent = 'Ожидаем подтверждение выбранных приватных полей в открытом окне…';
      showDialog(dialog);
    });
  }
  function resetAcknowledgements() {
    el('contacts-confirm').checked = false;
    el('password-risk').checked = false;
  }
  function showReview(token) {
    review = token;
    reviewFields = fields();
    showDialog(reviewPanel);
    if (el('reopen')) el('reopen').hidden = false;
    el('backup-ack-label').hidden = !token.localPrivateAtRisk;
    el('backup-ack').checked = false;
    el('accept').disabled = !!token.replacementBlocked;
    el('review-status').textContent =
      (token.replacementBlocked
        ? `Сравнение только для чтения. Полная замена заблокирована проверкой связей/перезапуска: ${token.replacementBlocked}. Местные данные, ключи и привязки не изменены. `
        : '') +
      `Дата внутри файла: ${dateLabel(token.createdAt)}. ` +
      (token.bothChanged ? 'ВНИМАНИЕ: и местные, и облачные данные изменились относительно принятой базы. ' : '') +
      (token.noCommonBase ? 'Общая принятая база пока неизвестна. ' : '') +
      (token.duplicatePartyIds
        ? `В местных пати повторяются идентификаторы: ${token.duplicatePartyIds}. Все записи показаны раздельно только для просмотра; принадлежность к повторным пати неоднозначна. Местные ID и связи не исправлялись. Это сравнение для полной замены, не для объединения. `
        : '') +
      (token.orderingNormalized?.length
        ? 'Порядок пати и финансовых записей при замене будет приведён к обычному порядку приложения: пати по номеру, финансы по дате. Все записи и их поля сохраняются. '
        : '') +
      (token.localPrivateAtRisk ? 'Удаление затронет местные контакты: сначала сохраните их отдельную копию. ' : '') +
      'При принятии добавится содержимое только из облака, местные отсутствующие в облаке записи будут удалены. Это полная замена, не объединение.' +
      (token.hasPrivate ? ' В файле есть приватная часть; без отдельного выбора она не применяется.' : '');
    const counts = el('review-counts');
    if (counts) {
      counts.replaceChildren();
      for (const [label, count] of cloudChangeCounts(token.comparison.entries)) {
        const chip = doc.createElement('span');
        chip.textContent = `${label}: ${count}`;
        counts.append(chip);
      }
    }
    const list = el('differences');
    list.replaceChildren();
    const categories = new Map();
    const category = (key, title) => {
      if (!categories.has(key)) {
        const li = doc.createElement('li');
        const details = doc.createElement('details'); // Collapsed on every fresh comparison.
        const summary = doc.createElement('summary');
        summary.textContent = title;
        const rows = doc.createElement('ul');
        details.append(summary, rows);
        li.append(details);
        list.append(li);
        categories.set(key, { summary, rows, title, count: 0 });
      }
      const group = categories.get(key);
      group.summary.textContent = `${group.title} (${++group.count})`;
      return group.rows;
    };
    for (const entry of token.comparison.entries) {
      const li = doc.createElement('li');
      const kind =
        entry.kind === 'only_local'
          ? 'Будет удалено с этого ПК'
          : entry.kind === 'only_cloud'
            ? 'Будет добавлено на этот ПК'
            : 'Будет изменено';
      li.className = `cloud-diff-card cloud-diff-${entry.kind}`;
      li.textContent = `${SECTIONS[entry.section] || 'Данные'} — ${kind}${entry.label ? `: ${entry.label}` : ''}`;
      const nested = doc.createElement('ul');
      for (const change of entry.changes.slice(0, 30)) {
        const item = doc.createElement('li');
        const path = doc.createElement('strong');
        path.className = 'cloud-diff-field';
        path.textContent = cloudChangePath(change.path);
        const values = doc.createElement('span');
        values.className = 'cloud-diff-values';
        values.textContent = `${cloudChangeValue(change.local, change.path)} → ${cloudChangeValue(change.cloud, change.path)}`;
        item.append(path, values);
        nested.append(item);
      }
      if (nested.childNodes.length) li.append(nested);
      category(entry.section, SECTIONS[entry.section] || 'Данные').append(li);
    }
    for (const field of token.privateChanges) {
      const li = doc.createElement('li');
      li.className = 'cloud-diff-card';
      li.textContent = `Приватное поле ${field.field}: ${field.clears ? 'будет очищено' : 'будет заменено'}; значения скрыты.`;
      category('private', 'Контакты и пароли — значения скрыты').append(li);
    }
    if (!list.childNodes.length) {
      const li = doc.createElement('li');
      li.textContent = 'В выбранных данных различий нет.';
      list.append(li);
    }
  }
  const selectedVersions = new Map();
  function showFiles(rows) {
    listedFiles = rows;
    files.replaceChildren();
    for (const provider of ['google', 'yandex']) {
      const versions = providerCopyRows(rows, true).filter(row => row.locations[0].provider === provider);
      if (!versions.length) continue;
      let file = versions.find(row => row.versionId === selectedVersions.get(provider)) || versions[0];
      const selector = doc.createElement('select');
      selector.className = 'input';
      selector.setAttribute('aria-label', `Версия копии: ${NAMES[provider]}`);
      for (const row of versions) {
        const option = doc.createElement('option');
        option.value = row.versionId;
        option.textContent = `${dateLabel(row.locations[0].modifiedAt)} · версия ${row.versionId.slice(0, 8)}`;
        option.selected = row.versionId === file.versionId;
        selector.append(option);
      }
      const card = doc.createElement('div');
      card.className = 'cloud-copy-card';
      const heading = doc.createElement('h5');
      heading.textContent = NAMES[file.locations[0].provider];
      card.append(heading);
      const title = doc.createElement('p');
      const updateVersion = () => {
        file = versions.find(row => row.versionId === selector.value) || versions[0];
        selectedVersions.set(provider, file.versionId);
        title.textContent = `${dateLabel(file.locations[0].modifiedAt)} · версия ${file.versionId.slice(0, 8)}. Будет скачана выбранная версия; часовой пояс этого ПК.`;
      };
      updateVersion();
      selector.addEventListener('change', updateVersion);
      const open = doc.createElement('button');
      open.className = 'btn ghost';
      open.type = 'button';
      open.textContent = 'Скачать и сравнить';
      card.append(selector, title, open);
      const feedback = compareFeedback(doc, card, provider);
      open.addEventListener('click', () => {
        let settled = false;
        const finish = (text, state, outcome) => {
          if (settled) return;
          settled = true;
          feedback.finish(text, state);
          log(provider, 'standalone_compare', outcome);
        };
        const ensureActive = () => {
          if (stopped) throw new Error('closed');
        };
        void action(
          async engine => {
            // Comparison is read-only: replacement/export acknowledgements are not needed here.
            let token;
            const input = {
              provider,
              versionId: file.versionId,
              sha256: file.sha256,
              fields: fields(),
              onProgress: stage => {
                if (!stopped) feedback.stage(stage);
              }
            };
            try {
              token = await engine.review(input);
            } catch (error) {
              ensureActive();
              // Access/network/integrity failures are NOT password requests.
              if (error.message !== 'encryption_password_required') throw error;
              feedback.stage('password');
              const password = await passwordDialog({ repeat: false });
              ensureActive();
              if (password === null) throw new Error('compare_cancelled', { cause: error });
              token = await engine.review({ ...input, password });
            }
            ensureActive();
            showReview(token);
            const hasDifferences = token.comparison.entries.length || token.privateChanges.length;
            const result = `${NAMES[provider]} · Сравнение завершено. ${hasDifferences ? 'Различия открыты в отдельном окне.' : 'В выбранных данных различий нет.'} Местные данные не заменены; на диски ничего не отправлялось.`;
            finish(result, 'success', 'success');
            status.textContent = result;
            el('review-status').textContent = `${result} ${el('review-status').textContent}`;
            reviewPanel.setAttribute('tabindex', '-1');
            reviewPanel.focus({ preventScroll: true });
            reviewPanel.scrollIntoView?.({ block: 'nearest' });
          },
          'ui_compare',
          {
            provider,
            start() {
              // Never leave an older comparison looking like this attempt's result.
              clearReview();
              feedback.start();
              feedback.stage('access');
              log(provider, 'standalone_compare', 'running');
              stopComparison = () =>
                finish('Сравнение прервано при закрытии. Местные данные не заменены.', 'cancelled', 'cancelled');
            },
            error(error, failure) {
              const cancelled = error.message === 'compare_cancelled';
              const diagnostic = cloudAccessDiagnostic(error);
              const explanation =
                STATUS[error.message] || 'Не удалось завершить действие. Скопируйте безопасный отчёт под журналом.';
              const result = `${cancelled ? '' : 'Сравнение остановлено. '}${explanation}${diagnostic ? ' ' + CLOUD_ACCESS_MESSAGES[diagnostic] : ''} Этап: ${failure.stage}; код: ${failure.code}. Местные данные не заменены; ключи и аккаунты сохранены.`;
              finish(
                result,
                cancelled ? 'cancelled' : 'failed',
                cancelled
                  ? 'cancelled'
                  : cloudAccessDiagnostic(error) || standaloneActivityOutcome({ status: error.message })
              );
              // Preserve WeakMap access diagnostics rather than reducing everything to a generic error.
              status.textContent = result;
            },
            finally() {
              feedback.stop();
              stopComparison = null;
            }
          }
        );
      });
      files.append(card);
    }
  }
  async function check(manual) {
    return action(async engine => {
      status.textContent = 'Проверяем Google Диск и Яндекс Диск: доступ, список файлов и целостность копий…';
      const result = await engine.check({
        manual,
        includeBackups: true,
        onProgress: operationProgress
      });
      const unaccepted = result.unacceptedFiles || (!manual ? result.files : null);
      for (const row of result.results) {
        if (row.status === 'credential_missing') notices.delete(row.provider);
        else if (unaccepted && ['checked', 'empty'].includes(row.status))
          notices.set(
            row.provider,
            unaccepted
              .filter(file => file.locations.some(location => location.provider === row.provider))
              .map(file => `${file.versionId}:${file.sha256}`)
          );
      }
      updateBadge();
      if (el('last-check'))
        el('last-check').textContent =
          `Последняя проверка: ${dateLabel(Date.now())}. ${result.results.some(row => !['checked', 'empty', 'credential_missing'].includes(row.status)) ? 'Есть ошибки — подробности ниже.' : 'Проверка завершена.'}`;
      const available = result.results.find(row => ['checked', 'empty'].includes(row.status));
      showFiles(result.files);
      showResults([...result.results.filter(row => manual || row.status !== 'credential_missing'), ...result.pending]);
      status.textContent =
        result.results.length && result.results.every(row => row.status === 'credential_missing')
          ? 'Подключите диск выше. Направление сохранения выбирается отдельно.'
          : !available
            ? 'Не удалось проверить диски. Причины указаны ниже; файлы не отправлялись.'
            : result.files.length
              ? `Доступно копий по дискам: ${providerCopyRows(result.files, true).length}. Предыдущие версии доступны в отдельном списке каждого диска. Ничего не применяется и не отправляется автоматически.`
              : 'Новых непринятых копий не обнаружено на успешно проверенных дисках. Отклонённые версии доступны при ручной проверке.';
      if (available && result.results.some(row => !['checked', 'empty', 'credential_missing'].includes(row.status)))
        status.textContent = 'Проверка частичная: один из подключённых дисков недоступен. ' + status.textContent;
      for (const resultRow of result.results) {
        if (resultRow.status === 'credential_missing') continue;
        log(
          resultRow.provider,
          'check',
          resultRow.status === 'checked'
            ? 'success'
            : resultRow.status === 'empty'
              ? 'empty'
              : standaloneActivityOutcome(resultRow)
        );
      }
      return result;
    }, 'ui_check');
  }
  el('copy-report')?.addEventListener('click', () => {
    const diagnostics = doc.getElementById('cloud-diagnostics-panel');
    if (diagnostics) diagnostics.open = true;
    doc.getElementById('cloud-diagnostics-copy')?.click();
    diagnostics?.scrollIntoView?.({ block: 'nearest' });
  });
  function folderResult(result, operation = true) {
    const diagnostic = cloudAccessDiagnostic(result);
    recordCloudDiagnostic({
      stage: 'provider_result',
      provider: 'yandex',
      outcome: ['folder_ready', 'folder_created', 'folder_missing', 'folder_file_verified'].includes(result.status)
        ? 'ok'
        : 'blocked',
      code: diagnostic || result.status
    });
    el('yandex-folder-status').textContent = STATUS[result.status] || 'Состояние папки не подтверждено.';
    if (diagnostic) el('yandex-folder-status').textContent += ' ' + CLOUD_ACCESS_MESSAGES[diagnostic];
    el('yandex-folder-help').textContent = folderNextStep(result.status, diagnostic);
    el('yandex-folder-create').hidden = result.status !== 'folder_missing';
    el('yandex-folder-status').parentElement.dataset.state = [
      'folder_ready',
      'folder_created',
      'folder_file_verified'
    ].includes(result.status)
      ? 'success'
      : result.status === 'folder_missing'
        ? 'idle'
        : 'failed';
    if (!['folder_ready', 'folder_created', 'folder_missing', 'folder_file_verified'].includes(result.status))
      el('copy-report').hidden = false;
    if (operation) status.textContent = el('yandex-folder-status').textContent;
    if (operation && el('operation'))
      el('operation').dataset.state = el('yandex-folder-status').parentElement.dataset.state;
  }
  function folderAction(create) {
    return action(
      async engine => {
        if (create) status.textContent = 'Ожидаем подтверждение создания пустой папки…';
        if (
          create &&
          !(await confirmAction({
            title: 'Создать папку на Яндекс Диске?',
            text: 'Создадим только пустую папку «Твиноферма» в корне Диска и проверим её. Данные не отправляются, старые файлы и ключи не меняются.',
            okText: 'Создать пустую папку'
          }))
        ) {
          status.textContent = 'Создание папки отменено. Данные не отправлялись.';
          return;
        }
        const result = await engine.checkYandexFolder({ create, ...(create ? { confirmed: true } : {}) });
        if (stopped) return;
        folderResult(result);
        return result;
      },
      create ? 'ui_folder_create' : 'ui_folder_check',
      {
        provider: 'yandex',
        error(error) {
          folderResult(withCloudAccessDiagnostic({ status: error.message }, cloudAccessDiagnostic(error)));
        }
      }
    );
  }
  el('yandex-folder-check')?.addEventListener('click', () => void folderAction(false));
  el('yandex-folder-create')?.addEventListener('click', () => void folderAction(true));
  el('source').addEventListener('change', () => {
    el('source-file-label').hidden = el('source').value !== 'file';
  });
  el('check').addEventListener('click', () => check(true));
  el('select-all').addEventListener('click', () => {
    for (const input of checkboxes('[data-standalone-private],[data-standalone-setting]')) input.checked = true;
    // Deliberately do NOT tick consent/risk or destination boxes.
    resetAcknowledgements();
    updateConsentVisibility();
    saveOptions();
  });
  el('select-none').addEventListener('click', () => {
    for (const input of checkboxes('[data-standalone-private],[data-standalone-setting]')) input.checked = false;
    resetAcknowledgements();
    updateConsentVisibility();
    saveOptions();
  });
  el('save').addEventListener('click', () =>
    action(async engine => {
      if (!(await privacy())) return;
      if (!targets().length) {
        status.textContent = 'Выберите Google Диск, Яндекс Диск или оба.';
        return;
      }
      let source;
      if (el('source').value === 'file') {
        const file = el('source-file').files?.[0];
        if (!file || file.size > MAX_SNAPSHOT_BYTES) {
          status.textContent = 'Выберите полный файл state.json размером до 32 МиБ.';
          return;
        }
        const rawText = await file.text();
        const report = inspectStateFile(rawText);
        if (report.codes[0] !== 'file/structure_ok') {
          status.textContent = `Файл несовместим: ${report.codes.join(', ')}. Отправка не начиналась.`;
          return;
        }
        const raw = JSON.parse(rawText.replace(/^\uFEFF/, ''));
        if (raw.secretsInVault && fields().length) {
          status.textContent =
            'Контакты этого файла находятся в хранилище исходного ПК. Файл сам по себе их не содержит; снимите приватные поля.';
          return;
        }
        const { ui: _ui, ...normalized } = normalizeState(raw);
        source = planSyncIdentities({ snapshot: normalized }).snapshot;
      }
      status.textContent = 'Подготовка файла…';
      el('provider-results').replaceChildren();
      const prepared = await prepareStandaloneSave({
        engine,
        connect: connectForSave,
        progress: provider => {
          status.textContent = `Для ${NAMES[provider]} нужен вход. Завершите его в браузере; затем продолжим сохранение.`;
        },
        options: {
          targets: targets(),
          onProgress: operationProgress,
          source,
          async requestPassword(input) {
            if (stopped) throw new Error('closed');
            status.textContent = 'Ожидаем пароль шифрования в открытом окне…';
            const password = await passwordDialog(input);
            if (stopped) throw new Error('closed');
            return password;
          },
          fields: fields(),
          acknowledgePasswordRisk: el('password-risk').checked,
          contactsSourceConfirmed: el('contacts-confirm').checked,
          settingsSelections: choices('[data-standalone-setting]')
        }
      });
      if (stopped) return;
      const needsConfirmation = prepared.hasUnacceptedCopies || prepared.hasPrivate || !!source;
      const agreed =
        !needsConfirmation ||
        (await confirmAction({
          title: 'Сохранить полный файл?',
          text: `Сохранить выбранные данные на ${targets()
            .map(provider => NAMES[provider])
            .join(
              ' и '
            )}? Обнаружено прежних полных копий: ${prepared.remoteCopies}. Они останутся резервными, но новая копия станет предлагаемым полным содержимым вместо всех обнаруженных копий. Непринятые облачные изменения не объединяются с местными. ${prepared.hasPrivate ? 'ВКЛЮЧЕНЫ выбранные контакты/пароли. ' : 'Контакты и пароли исключены. '}Результат каждого диска проверяется отдельно.`,
          okText: 'Сохранить'
        }));
      if (!agreed) {
        status.textContent = 'Отправка отменена. Облачные файлы не менялись.';
        return;
      }
      status.textContent = 'Отправка и проверка файла на диске…';
      const result = await cloudStep('save_dispatch', null, () =>
        engine.save(prepared, { confirmed: true, remember: el('remember').checked, onProgress: operationProgress })
      );
      showResults(result.results);
      status.textContent =
        result.remembering === 'unavailable'
          ? 'Результаты сохранения указаны выше. Запомнить ключ в ОС не удалось; сохраните пароль самостоятельно.'
          : 'Результаты сохранения и сверки каждого диска указаны выше.';
      for (const row of result.results)
        log(
          row.provider,
          'standalone_save',
          row.status === 'sent_verified' ? 'success' : standaloneActivityOutcome(row)
        );
      resetAcknowledgements();
    }, 'ui_save')
  );
  el('accept').addEventListener('click', () =>
    action(async engine => {
      if (!review || review.replacementBlocked) return;
      // Changing private scope invalidates the displayed preview.
      if (JSON.stringify(fields()) !== JSON.stringify(reviewFields)) {
        status.textContent = 'Изменён выбор приватных полей. Скачайте и сравните файл заново.';
        return;
      }
      if (!(await privacy())) return;
      hideReview();
      const agreed = await confirmAction({
        title: 'Заменить местные данные полной копией?',
        text: 'Будут добавлены, изменены и удалены записи по показанному сравнению. Сначала создаётся резервная копия местных данных. Невыбранные контакты, сессии и настройки этого ПК не переносятся из облака. Второй диск не перезаписывается. Продолжить?',
        okText: 'Принять полную копию',
        danger: true
      });
      if (!agreed) {
        showDialog(reviewPanel);
        return;
      }
      const result = await engine.accept(review, {
        confirmed: true,
        fields: fields(),
        acknowledgePasswordRisk: el('password-risk').checked,
        contactsBackupConfirmed:
          (!fields().length || el('contacts-confirm').checked) &&
          (!review.localPrivateAtRisk || el('backup-ack').checked),
        remember: el('remember').checked
      });
      status.textContent = STATUS[result.status] || 'Замена не подтверждена; повторите проверку местных данных.';
      if (result.status === 'applied') {
        acknowledgeNotice(review);
      }
      log(review.provider, 'file_replace', result.status === 'applied' ? 'success' : 'unavailable');
      if (result.status === 'applied') {
        clearReview();
        resetAcknowledgements();
        doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-applied'));
        if (result.remembering === 'unavailable') status.textContent += ' Запомнить ключ в ОС не удалось.';
      }
    })
  );
  el('decline').addEventListener('click', () =>
    action(async engine => {
      if (!review) return;
      const provider = review.provider;
      const result = await engine.decline(review);
      acknowledgeNotice(review);
      clearReview();
      status.textContent = STATUS[result.status];
      resetAcknowledgements();
      log(provider, 'standalone_keep', 'success');
    })
  );
  el('forget').addEventListener('click', () =>
    action(async engine => {
      keyDialog.close();
      if (
        !(await confirmAction({
          title: 'Забыть запомненный ключ?',
          text: 'Облачные файлы, старые ключи и аккаунты сохранятся. Для следующего открытия понадобится пароль шифрования.',
          okText: 'Забыть ключ'
        }))
      )
        return;
      await engine.forgetRememberedKey();
      status.textContent = 'Запомненный ключ удалён. Для открытия потребуется пароль.';
    })
  );
  setBusy(false);
  const startup = options.startup !== false && options.desktop;
  let timer = null;
  const connected = () => {
    if (!busy && !stopped) void check(false);
  };
  function intervalMinutes() {
    const value = el('interval')?.value;
    const minutes = Number(value === 'custom' ? el('custom-interval')?.value : (value ?? 15));
    return Number.isSafeInteger(minutes) &&
      ((value !== 'custom' && minutes === 0) || (minutes >= 15 && minutes <= 10080))
      ? minutes
      : null;
  }
  function schedule() {
    if (timer) clearInterval(timer);
    timer = null;
    const minutes = intervalMinutes();
    if (startup && minutes) timer = setInterval(connected, minutes * 60 * 1000);
  }
  const autoChanged = () => {
    if (el('custom-interval-label')) el('custom-interval-label').hidden = el('interval')?.value !== 'custom';
    const minutes = intervalMinutes();
    if (minutes === null) {
      status.textContent = 'Введите целое число минут от 15 до 10080. Прежнее расписание сохранено.';
      return;
    }
    const value = { version: 1, startup: !!el('startup')?.checked, minutes };
    if (!writeCloudAutoCheck(doc, value))
      status.textContent = 'Не удалось запомнить расписание. Оно действует до закрытия приложения.';
    schedule();
  };
  el('startup')?.addEventListener('change', autoChanged);
  el('interval')?.addEventListener('change', autoChanged);
  el('custom-interval')?.addEventListener('change', autoChanged);
  const reset = () => {
    stopped = true;
    panel.removeEventListener('change', optionsChanged);
    stopComparison?.();
    stopComparison = null;
    cancelPrivate?.();
    finishOperation();
    badge?.removeEventListener('click', openCloudCopies);
    if (badge) badge.hidden = true;
    notices.clear();
    runtime?.dispose?.();
    if (timer) clearInterval(timer);
    setBusy(false);
    review = null;
    files.replaceChildren();
    listedFiles = [];
    clearReview();
    keyDialog?.close();
  };
  const invalidateFolder = event => {
    if (event.detail?.provider !== 'yandex') return;
    el('yandex-folder-status').textContent = 'Проверьте папку после входа в прежний аккаунт Яндекса.';
    el('yandex-folder-help').textContent =
      'Предыдущий результат относится к прежнему сеансу. Проверка ничего не записывает.';
    el('yandex-folder-create').hidden = true;
    el('yandex-folder-status').parentElement.dataset.state = 'idle';
  };
  doc.defaultView?.addEventListener('tf-cloud-credential-ready', invalidateFolder);
  const credentialRemoved = event => {
    invalidateFolder(event);
    const provider = event.detail?.provider;
    notices.delete(provider);
    updateBadge();
    if (review?.provider === provider) clearReview();
    if (!busy && !stopped)
      showFiles(
        listedFiles
          .map(file => ({ ...file, locations: file.locations.filter(location => location.provider !== provider) }))
          .filter(file => file.locations.length)
      );
  };
  doc.defaultView?.addEventListener('tf-cloud-credential-removed', credentialRemoved);
  const factoryReset = () => {
    clearStandaloneFileOptions(doc);
    clearCloudAutoCheck(doc);
    reset();
  };
  doc.defaultView?.addEventListener('tf-factory-reset-started', factoryReset);
  if (startup) {
    doc.defaultView?.addEventListener('tf-cloud-credential-ready', connected);
    schedule();
    if (autoCheck.startup) void check(false);
  }
  if (!options.desktop)
    status.textContent =
      'Обмен с Google и Яндексом доступен в настольном приложении Windows. В браузере реальные диски не подключаются.';
  return {
    check,
    dispose() {
      reset();
      el('startup')?.removeEventListener('change', autoChanged);
      el('interval')?.removeEventListener('change', autoChanged);
      el('custom-interval')?.removeEventListener('change', autoChanged);
      doc.defaultView?.removeEventListener('tf-cloud-credential-ready', connected);
      doc.defaultView?.removeEventListener('tf-cloud-credential-removed', credentialRemoved);
      doc.defaultView?.removeEventListener('tf-cloud-credential-ready', invalidateFolder);
      doc.defaultView?.removeEventListener('tf-factory-reset-started', factoryReset);
    }
  };
}

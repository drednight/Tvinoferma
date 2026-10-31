// @ts-check
import { createStandaloneFileRuntime } from '../standaloneFileRuntime.js';
import { inspectStateFile } from '../inspectStateFile.js';
import { normalizeState } from '../../../core/state.js';
import { planSyncIdentities } from '../identityMigration.js';
import { MAX_SNAPSHOT_BYTES } from '../envelope.js';
import { validateEncryptionPassword } from '../keyBundle.js';
import { confirmModal } from '../../../core/ui.js';
import { recordCloudActivity } from '../cloudEventLog.js';

const NAMES = { google: 'Google Диск', yandex: 'Яндекс Диск' };
const SECTIONS = {
  characters: 'Персонажи',
  parties: 'Пати',
  marathons: 'Марафоны',
  planner: 'Календарь',
  finance: 'Финансы',
  preferences: 'Настройки'
};
const STATUS = {
  encryption_password_incorrect:
    'Не удалось разблокировать прежний ключ. Проверьте пароль шифрования. Новый ключ не создавался, облачные файлы не менялись.',
  folder_ambiguous: 'найдено несколько папок приложения — выберите нужную, дата не определяет папку',
  checked: 'проверен',
  empty: 'полных файлов пока нет',
  unavailable: 'не удалось проверить — проверьте вход и сеть; не удаляйте ключи и аккаунт',
  sent_verified: 'полный файл сохранён и сверен чтением с диска',
  verification_pending: 'отправка пока не подтверждена: сначала проверяем прежний файл',
  content_mismatch: 'прочитанные байты не совпали с отправленными; новая отправка остановлена',
  local_changed: 'местные данные изменились — повторите подготовку или сравнение',
  remote_changed: 'облачный файл изменился — повторите проверку',
  account_changed: 'аккаунт изменился; прежнее подключение не заменено',
  applied:
    'Полная облачная копия принята. Местные данные перед заменой сохранены в резервной копии. Отправка на второй диск НЕ выполнялась.',
  kept_local:
    'Свои данные оставлены без замены. Эта версия не будет напоминаться до следующей версии; ручная проверка доступна.',
  idle: 'незавершённой отправки нет',
  busy: 'дождитесь завершения текущей операции',
  state_changed: 'данные изменились — скачайте и сравните заново',
  disk_changed_or_unsaved: 'местный файл изменился — дождитесь сохранения и повторите сравнение',
  write_unconfirmed_restart: 'местная запись не подтверждена. Перезапустите приложение и проверьте резервную копию.',
  contacts_unavailable:
    'Хранилище контактов недоступно или не проверено. Снимите приватные поля; не считайте пустые контакты подтверждёнными.',
  contacts_required: 'Подтвердите полноту выбранных контактов и наличие отдельной копии перед их заменой.',
  password_risk_confirmation_required: 'Отдельно подтвердите риск передачи или замены паролей.'
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
      <h3 id="standalone-password-title">${repeat ? 'Пароль шифрования полного файла' : 'Пароль шифрования'}</h3>
      <p>${repeat ? 'Не менее 8 символов. Используйте не менее 6 различных символов и не очевидную последовательность. Без пароля или запомненного ключа файл не восстановить.' : 'Введите пароль, которым зашифрованы ваши файлы. Сам ввод пароля не заменяет местные данные.'}</p>
      <label>Пароль<input class="input" name="password" type="password" maxlength="1024" autocomplete="${repeat ? 'new-password' : 'current-password'}" /></label>
      ${repeat ? '<label>Повторите пароль<input class="input" name="repeat" type="password" maxlength="1024" autocomplete="new-password" /></label>' : ''}
      <p class="modal-error" role="alert" id="standalone-password-error"></p>
      <div class="cloud-registration-actions"><button class="btn" type="submit">${repeat ? 'Продолжить' : 'Открыть'}</button><button class="btn ghost" type="button" data-cancel>Отмена</button></div>
    </form>`;
    const form = dialog.querySelector('form');
    const password = /** @type {HTMLInputElement} */ (form.elements.namedItem('password'));
    const confirmation = /** @type {HTMLInputElement|null} */ (form.elements.namedItem('repeat'));
    const message = dialog.querySelector('[role="alert"]');
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
        password.focus();
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
  const confirmAction = options.confirm || confirmModal;
  const passwordDialog = options.password || (opts => askStandalonePassword({ doc, ...opts }));
  let runtime = options.runtime || null;
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
  function setBusy(value) {
    busy = value;
    for (const input of panel.querySelectorAll('button,input,select'))
      input.disabled = busy || !options.desktop || stopped;
  }
  function log(provider, action, outcome) {
    (options.record || recordCloudActivity)(provider, action, outcome);
  }
  async function action(fn) {
    if (busy || !options.desktop || stopped) return;
    setBusy(true);
    try {
      await fn(await getRuntime());
    } catch (error) {
      status.textContent =
        STATUS[error.message] ||
        'Не удалось безопасно завершить действие. Проверьте подключение и повторите проверку. Ничего не считайте подтверждённым; ключи и аккаунт удалять не нужно.';
    } finally {
      setBusy(false);
    }
  }
  function showResults(results) {
    el('provider-results').replaceChildren();
    for (const result of results) {
      const li = doc.createElement('li');
      li.textContent = `${NAMES[result.provider]}: ${STATUS[result.status] || 'действие не подтверждено'}`;
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
            log(result.provider, 'standalone_continue', continued.status === 'sent_verified' ? 'success' : 'uncertain');
          })
        );
        li.append(' ', retry);
      }
      el('provider-results').append(li);
    }
  }
  function privacy() {
    if (fields().length && !el('contacts-confirm').checked) throw new Error('contacts_required');
    if (fields().includes('password') && !el('password-risk').checked)
      throw new Error('password_risk_confirmation_required');
  }
  function resetPrivate() {
    for (const input of checkboxes('[data-standalone-private]')) input.checked = false;
    el('contacts-confirm').checked = false;
    el('password-risk').checked = false;
  }
  function showReview(token) {
    review = token;
    reviewFields = fields();
    reviewPanel.hidden = false;
    el('backup-ack-label').hidden = !token.localPrivateAtRisk;
    el('backup-ack').checked = false;
    el('review-status').textContent =
      `Дата внутри файла: ${dateLabel(token.createdAt)}. ` +
      (token.bothChanged ? 'ВНИМАНИЕ: и местные, и облачные данные изменились относительно принятой базы. ' : '') +
      (token.noCommonBase ? 'Общая принятая база пока неизвестна. ' : '') +
      (token.localPrivateAtRisk ? 'Удаление затронет местные контакты: сначала сохраните их отдельную копию. ' : '') +
      'При принятии добавится содержимое только из облака, местные отсутствующие в облаке записи будут удалены. Это полная замена, не объединение.' +
      (token.hasPrivate ? ' В файле есть приватная часть; без отдельного выбора она не применяется.' : '');
    const list = el('differences');
    list.replaceChildren();
    for (const entry of token.comparison.entries) {
      const li = doc.createElement('li');
      const kind =
        entry.kind === 'only_local'
          ? 'Будет удалено с этого ПК'
          : entry.kind === 'only_cloud'
            ? 'Будет добавлено на этот ПК'
            : 'Будет изменено';
      li.textContent = `${SECTIONS[entry.section] || 'Данные'} — ${kind}${entry.label ? `: ${entry.label}` : ''}`;
      const nested = doc.createElement('ul');
      for (const change of entry.changes.slice(0, 30)) {
        const item = doc.createElement('li');
        const value = part =>
          !part?.present
            ? 'отсутствует'
            : (typeof part.value === 'string' ? part.value : JSON.stringify(part.value)).slice(0, 300);
        item.textContent = `${change.path.join(' › ')}: ${value(change.local)} → ${value(change.cloud)}`;
        nested.append(item);
      }
      if (nested.childNodes.length) li.append(nested);
      list.append(li);
    }
    for (const field of token.privateChanges) {
      const li = doc.createElement('li');
      li.textContent = `Приватное поле ${field.field}: ${field.clears ? 'будет очищено' : 'будет заменено'}; значения скрыты.`;
      list.append(li);
    }
    if (!list.childNodes.length) {
      const li = doc.createElement('li');
      li.textContent = 'В выбранных данных различий нет.';
      list.append(li);
    }
  }
  function showFiles(rows) {
    files.replaceChildren();
    for (const file of rows) {
      const card = doc.createElement('div');
      card.className = 'cloud-review-pending';
      const title = doc.createElement('p');
      title.textContent = `${file.locations.map(location => NAMES[location.provider]).join(' + ')} — ${file.locations.map(location => dateLabel(location.modifiedAt)).join(' / ')}. Даты диска справочные, часовой пояс этого ПК. Версия ${file.versionId.slice(0, 8)}.`;
      const open = doc.createElement('button');
      open.className = 'btn ghost';
      open.type = 'button';
      open.textContent = 'Скачать и сравнить';
      open.addEventListener('click', () =>
        action(async engine => {
          privacy();
          let token;
          const input = {
            provider: file.locations[0].provider,
            versionId: file.versionId,
            sha256: file.sha256,
            fields: fields()
          };
          try {
            token = await engine.review(input);
          } catch (error) {
            if (['remote_changed', 'local_changed', 'account_changed'].includes(error.message)) throw error;
            const password = await passwordDialog({ repeat: false });
            if (password === null) return;
            try {
              token = await engine.review({ ...input, password });
            } catch {
              status.textContent =
                'Не удалось открыть или проверить файл. Проверьте пароль; местные данные не заменены.';
              return;
            }
          }
          showReview(token);
          log(input.provider, 'standalone_compare', 'success');
          status.textContent = 'Файл скачан и проверен. Посмотрите различия; местные данные ещё не заменялись.';
        })
      );
      card.append(title, open);
      files.append(card);
    }
  }
  async function check(manual) {
    await action(async engine => {
      const result = await engine.check({ manual, includeBackups: manual && el('show-backups').checked });
      showFiles(result.files);
      showResults([...result.results, ...result.pending]);
      status.textContent = result.files.length
        ? `Доступно полных копий для сравнения: ${result.files.length}. Совпадающие файлы объединены по содержимому; разные выберите явно. Ничего не применяется и не отправляется автоматически.`
        : 'Проверка завершена: новых непринятых копий не обнаружено на успешно проверенных дисках. Отклонённые версии доступны при ручной проверке.';
      for (const resultRow of result.results)
        log(
          resultRow.provider,
          'check',
          resultRow.status === 'checked' ? 'success' : resultRow.status === 'empty' ? 'empty' : 'unavailable'
        );
    });
  }
  el('source').addEventListener('change', () => {
    el('source-file-label').hidden = el('source').value !== 'file';
  });
  el('check').addEventListener('click', () => check(true));
  el('select-all').addEventListener('click', () => {
    for (const input of checkboxes('[data-standalone-private],[data-standalone-setting]')) input.checked = true;
    // Deliberately do NOT tick consent/risk or destination boxes.
  });
  el('select-none').addEventListener('click', () => {
    for (const input of checkboxes('[data-standalone-private],[data-standalone-setting]')) input.checked = false;
    resetPrivate();
  });
  el('save').addEventListener('click', () =>
    action(async engine => {
      privacy();
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
      const canSeal = await engine.canSeal();
      const password = canSeal ? undefined : await passwordDialog({ repeat: !engine.hasEncryptionKey?.() });
      if (password === null) return;
      const prepared = await engine.prepareSave({
        targets: targets(),
        source,
        password,
        fields: fields(),
        acknowledgePasswordRisk: el('password-risk').checked,
        contactsSourceConfirmed: el('contacts-confirm').checked,
        settingsSelections: choices('[data-standalone-setting]')
      });
      const agreed = await confirmAction({
        title: 'Сохранить полный файл?',
        text: `Сохранить выбранные данные на ${targets()
          .map(provider => NAMES[provider])
          .join(
            ' и '
          )}? Обнаружено прежних полных копий: ${prepared.remoteCopies}. Они останутся резервными, но новая копия станет предлагаемым полным содержимым вместо всех обнаруженных копий. Непринятые облачные изменения не объединяются с местными. ${prepared.hasPrivate ? 'ВКЛЮЧЕНЫ выбранные контакты/пароли. ' : 'Контакты и пароли исключены. '}Результат каждого диска проверяется отдельно.`,
        okText: 'Сохранить'
      });
      if (!agreed) return;
      const result = await engine.save(prepared, { confirmed: true, remember: el('remember').checked });
      showResults(result.results);
      status.textContent =
        result.remembering === 'unavailable'
          ? 'Результаты сохранения указаны выше. Запомнить ключ в ОС не удалось; сохраните пароль самостоятельно.'
          : 'Результаты сохранения и сверки каждого диска указаны выше.';
      for (const row of result.results)
        log(
          row.provider,
          'standalone_save',
          row.status === 'sent_verified'
            ? 'success'
            : row.status === 'verification_pending'
              ? 'uncertain'
              : 'unavailable'
        );
      resetPrivate();
    })
  );
  el('accept').addEventListener('click', () =>
    action(async engine => {
      if (!review) return;
      privacy();
      // Changing private scope invalidates the displayed preview.
      if (JSON.stringify(fields()) !== JSON.stringify(reviewFields)) {
        status.textContent = 'Изменён выбор приватных полей. Скачайте и сравните файл заново.';
        return;
      }
      const agreed = await confirmAction({
        title: 'Заменить местные данные полной копией?',
        text: 'Будут добавлены, изменены и удалены записи по показанному сравнению. Сначала создаётся резервная копия местных данных. Невыбранные контакты, сессии и настройки этого ПК не переносятся из облака. Второй диск не перезаписывается. Продолжить?',
        okText: 'Принять полную копию',
        danger: true
      });
      if (!agreed) return;
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
      log(review.provider, 'file_replace', result.status === 'applied' ? 'success' : 'unavailable');
      if (result.status === 'applied') {
        review = null;
        reviewPanel.hidden = true;
        resetPrivate();
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
      review = null;
      reviewPanel.hidden = true;
      status.textContent = STATUS[result.status];
      resetPrivate();
      log(provider, 'standalone_keep', 'success');
    })
  );
  el('forget').addEventListener('click', () =>
    action(async engine => {
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
  const reset = () => {
    stopped = true;
    runtime?.dispose?.();
    if (timer) clearInterval(timer);
    setBusy(false);
    review = null;
    files.replaceChildren();
    reviewPanel.hidden = true;
  };
  if (startup) {
    doc.defaultView?.addEventListener('tf-cloud-credential-ready', connected);
    doc.defaultView?.addEventListener('tf-factory-reset-started', reset);
    timer = setInterval(connected, 5 * 60 * 1000);
    void check(false);
  }
  if (!options.desktop)
    status.textContent =
      'Обмен с Google и Яндексом доступен в настольном приложении Windows. В браузере реальные диски не подключаются.';
  return {
    check,
    dispose() {
      reset();
      doc.defaultView?.removeEventListener('tf-cloud-credential-ready', connected);
      doc.defaultView?.removeEventListener('tf-factory-reset-started', reset);
    }
  };
}

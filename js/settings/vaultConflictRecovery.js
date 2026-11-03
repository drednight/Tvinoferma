// Explicit Windows-source recovery only. Never writes/deletes vault entries and
// never unblocks this JS context. A verified original-file backup precedes CAS.
// Other processes are not locked: the UI asks to close them; rechecks fail closed.
import { createFileContactRecovery } from './fileContactRecovery.js';
import { CONTACT_FIELDS } from '../core/secrets.js';
import { openOverlay } from '../modules/marathons/overlay.js';

const STOP =
  'Проверка не подтверждена. Сохранение остаётся остановленным. Исходные контакты не удалялись из Windows; проверьте файл и резервные копии перед новой попыткой.';

export function createWindowsContactRecovery({ raw, aliases = {}, review }) {
  if (!raw || !review?.conflicts?.length || !Array.isArray(review.keys) || !review.records) return null;
  const original = JSON.stringify(raw);
  const pinned = JSON.parse(JSON.stringify(review));
  const payload = JSON.parse(original);
  const characters = [...(payload.characters || []), ...(payload.archivedCharacters || [])];
  const used = new Set();
  for (const conflict of pinned.conflicts) {
    const id = Object.hasOwn(aliases, conflict.id) ? aliases[conflict.id] : conflict.id;
    const matches = characters.filter(character => character.id === id);
    if (matches.length !== 1 || used.has(id)) return null;
    used.add(id);
    matches[0].contacts = null;
  }
  payload.secretsInVault = true;
  payload.settings ??= {};
  payload.settings.security ??= {};
  payload.settings.security.useVault = true;
  let attempted = false;
  const verify = async invoke => {
    const records = await invoke('secrets_get_many', { keys: pinned.keys });
    if (
      !records ||
      typeof records !== 'object' ||
      Array.isArray(records) ||
      Object.keys(records).length !== Object.keys(pinned.records).length ||
      Object.keys(records).some(key => !Object.hasOwn(pinned.records, key) || records[key] !== pinned.records[key])
    )
      throw new Error(STOP);
  };
  return async invoke => {
    if (attempted) throw new Error(STOP);
    attempted = true; // An uncertain native reply must never cause automatic retry.
    try {
      const expectedRaw = await invoke('load_state_raw');
      if (typeof expectedRaw !== 'string' || JSON.stringify(JSON.parse(expectedRaw)) !== original)
        throw new Error(STOP);
      await verify(invoke);
      const backup = await invoke('create_migration_backup', { expectedRaw, label: 'pre-contacts-windows-choice' });
      if (typeof backup !== 'string' || backup.length > 200 || !/^state\.backup-[a-z0-9-]+\.json$/i.test(backup))
        throw new Error(STOP);
      await verify(invoke);
      const result = await invoke('save_state_if_unchanged', { expectedRaw, payload });
      if (result != null) throw new Error(STOP);
      await verify(invoke);
      return backup;
    } catch {
      throw new Error(STOP); // No paths, contacts or native error fragments.
    }
  };
}

export function attachVaultConflictRecovery({ raw, aliases, review }) {
  const banner = document.getElementById('storage-readonly-banner');
  if (!banner || !review || banner.querySelector('[data-vault-review]')) return;
  const recover = createWindowsContactRecovery({ raw, aliases, review });
  const recoverFile = createFileContactRecovery({ raw, aliases, review });
  if (!recover) return;
  const button = document.createElement('button');
  button.className = 'btn secondary';
  button.dataset.vaultReview = '';
  button.textContent = 'Сравнить контакты и выбрать источник';
  const fieldLabels = { email: 'почта', password: 'пароль', recoveryEmail: 'резервная почта', phone: 'телефон' };
  const differences = review.conflicts.map(conflict => {
    const local = JSON.parse(conflict.file || '{}'),
      windows = JSON.parse(conflict.windows || '{}');
    const fields = CONTACT_FIELDS.filter(field => (local[field] || '') !== (windows[field] || ''));
    return `${conflict.id}: ${fields.map(field => fieldLabels[field]).join(', ')}`;
  });
  const summary = document.createElement('details');
  summary.dataset.vaultConflictSummary = '';
  const heading = document.createElement('summary');
  heading.textContent = `Отличаются контакты у ${review.conflicts.length} персонажей — какие поля?`;
  const explanation = document.createElement('p');
  explanation.textContent = `Локальная проверка при запуске. Отличаются контакты (${review.conflicts.length}): ${differences.join('; ')}. По этим данным нельзя определить, какая версия новее. Файл можно перенести с другого ПК, но защищённые записи Windows этим переносом не заменяются.`;
  summary.append(heading, explanation);
  banner.append(summary, button);
  button.onclick = () => {
    let consent;
    const result = document.createElement('p');
    result.setAttribute('role', 'status');
    const content = document.createElement('div');
    const explanation = document.createElement('p');
    explanation.textContent =
      'Ни одна версия пока не заменена. Сравните значения на этом ПК. Можно использовать защищённую запись Windows: перед этим сохраняется проверенная копия исходного файла, затем только конфликтующие открытые контакты заменяются ссылкой на Windows. Сами записи Windows, ключи и привязки дисков не меняются. Старые контакты останутся в резервной копии: она может содержать пароли — храните её безопасно. Можно выбрать и версию файла: прежние контакты Windows сначала копируются в отдельные защищённые записи и проверяются чтением, затем выбранные контакты переносятся в Windows. Защищённое хранение остаётся включённым. Автоматического выбора нет.';
    content.append(explanation);
    const showLabel = document.createElement('label');
    const show = document.createElement('input');
    show.type = 'checkbox';
    showLabel.append(show, ' Показать значения контактов, включая пароли (только на этом экране)');
    content.append(showLabel);
    const tableWrap = document.createElement('div');
    tableWrap.className = 'vault-conflict-compare promo-scroll';
    const render = () => {
      const table = document.createElement('table');
      table.className = 'cookie-bank-table';
      const head = table.createTHead().insertRow();
      ['Персонаж / поле', 'Из файла', 'Из Windows'].forEach(label => {
        const th = document.createElement('th');
        th.textContent = label;
        head.append(th);
      });
      const body = table.createTBody();
      const labels = { email: 'Почта', password: 'Пароль', recoveryEmail: 'Резервная почта', phone: 'Телефон' };
      for (const conflict of review.conflicts) {
        const file = JSON.parse(conflict.file || '{}');
        const windows = JSON.parse(conflict.windows || '{}');
        for (const field of CONTACT_FIELDS) {
          const row = body.insertRow();
          [
            `${conflict.id} · ${labels[field]}`,
            ...[file, windows].map(source =>
              show.checked ? source[field] || 'пусто' : source[field] ? 'заполнено' : 'пусто'
            )
          ].forEach(value => {
            const cell = row.insertCell();
            cell.textContent = value;
          });
          if ((file[field] || '') !== (windows[field] || '')) row.className = 'vault-contact-different';
        }
      }
      tableWrap.replaceChildren(table);
    };
    render();
    show.onchange = render;
    content.append(tableWrap);
    const consentLabel = document.createElement('label');
    consent = document.createElement('input');
    consent.type = 'checkbox';
    consentLabel.append(
      consent,
      ' Я проверил(а) обе версии, закрыл(а) другие копии приложения и выбираю контакты Windows с защищённым хранением. Контакты из файла сохранятся в копии.'
    );
    const sourceLabel = document.createElement('label');
    sourceLabel.textContent = 'Какие контакты актуальны? ';
    const source = document.createElement('select');
    source.className = 'input';
    source.setAttribute('aria-label', 'Источник контактов');
    source.innerHTML =
      '<option value="windows">Из Windows</option>' +
      (recoverFile ? '<option value="file">Из файла → защищённое хранилище Windows</option>' : '');
    sourceLabel.append(source);
    content.append(sourceLabel, consentLabel, result);
    let completed = false;
    let busy = false;
    const dlg = openOverlay({
      title: 'Различающиеся контакты: явный выбор',
      wide: true,
      onClose: () => {
        show.checked = false;
        tableWrap.replaceChildren();
      }
    });
    dlg.body.append(content);
    const close = dlg.close;
    dlg.close = () => {
      if (!busy) close();
    };
    const cancel = document.createElement('button');
    cancel.className = 'btn secondary';
    cancel.textContent = 'Оставить обе версии без изменений';
    cancel.onclick = () => dlg.close();
    const use = document.createElement('button');
    use.className = 'btn primary';
    use.textContent = 'Использовать контакты Windows';
    use.disabled = true;
    use.onclick = async () => {
      if (busy) return;
      if (completed) {
        window.location.reload();
        return;
      }
      if (!consent.checked) {
        result.textContent = 'Сначала проверьте обе версии и подтвердите выбор.';
        return;
      }
      busy = true;
      source.disabled = true;
      use.disabled = true;
      cancel.disabled = true;
      button.disabled = true;
      result.textContent = 'Проверяю источники и создаю копию… Не закрывайте приложение.';
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const fileChoice = source.value === 'file';
        const recovery = fileChoice
          ? await recoverFile(invoke)
          : { backup: await recover(invoke), vaultBackupId: null };
        const backup = recovery.backup;
        show.checked = false;
        render();
        completed = true;
        result.textContent = `Выбор записан. Исходный файл сохранён: ${backup}. ${recovery.vaultBackupId ? `Прежние контакты Windows сохранены в защищённой копии ${recovery.vaultBackupId}; выбранные контакты файла перенесены в Windows.` : 'Защищённая запись Windows не изменена.'} Нажмите «Перезапустить» для повторной безопасной загрузки; до неё обычное сохранение заблокировано.`;
        use.textContent = 'Перезапустить';
        use.disabled = false;
        cancel.textContent = 'Закрыть (сохранение пока заблокировано)';
      } catch {
        result.textContent =
          source.value === 'file'
            ? 'Выбор не подтверждён. Сохранение остаётся остановленным. Копии не удалялись. Перезапустите приложение и сравните источники; автоматического повтора нет.'
            : STOP;
      } finally {
        busy = false;
        cancel.disabled = false;
      }
    };
    source.onchange = () => {
      consent.checked = false;
      use.disabled = true;
      const file = source.value === 'file';
      use.textContent = file ? 'Использовать контакты файла' : 'Использовать контакты Windows';
      consentLabel.lastChild.textContent = file
        ? ' Я сравнил(а) обе версии, закрыл(а) другие копии приложения и выбираю контакты файла. Перед заменой прежние контакты Windows будут сохранены отдельно в защищённом хранилище; исходный файл — в резервной копии.'
        : ' Я сравнил(а) обе версии, закрыл(а) другие копии приложения и выбираю контакты Windows. Исходный файл сохранится в резервной копии.';
    };
    dlg.foot.append(cancel, use);
    consent.onchange = () => {
      if (!busy && !button.disabled) use.disabled = !consent.checked;
    };
  };
}

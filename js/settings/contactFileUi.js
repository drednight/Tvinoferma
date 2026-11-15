import { state } from '../core/state.js';
import { assertStateWriteAvailable, isTauri } from '../core/storage.js';
import { vaultStatus, verifyContactsSource, CONTACT_FIELDS } from '../core/secrets.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import {
  contactSnapshotFromState,
  encryptContactFile,
  decryptContactFile,
  MAX_CONTACT_FILE_BYTES
} from './contactFileCodec.js';

// Witnesses can contain secrets and stay only in memory. They do not lock other processes.
function sourceWitness() {
  return JSON.stringify({
    characters: state.characters,
    archivedCharacters: state.archivedCharacters,
    settings: { security: state.settings?.security },
    secretsInVault: state.secretsInVault
  });
}
async function checkedSource(expected) {
  assertStateWriteAvailable();
  if (sourceWitness() !== expected) throw new Error('changed');
  const status = vaultStatus();
  if (status.blocked) throw new Error('vault');
  const snapshot = JSON.parse(expected);
  if (isTauri()) {
    const enabled = snapshot.settings.security?.useVault !== false;
    if (!status.checked || (enabled && !status.ready) || (!enabled && (status.count || snapshot.secretsInVault)))
      throw new Error('vault');
    if (!(await verifyContactsSource(snapshot))) throw new Error('vault');
  }
  assertStateWriteAvailable();
  if (sourceWitness() !== expected) throw new Error('changed');
  return snapshot;
}

function downloadEncryptedFile(file) {
  const url = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `tvinoferma-contacts-${new Date().toISOString().slice(0, 10)}.tfcontacts.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** One-use encrypted local export. The key and contacts are never saved in state or logs. */
export function openContactFileExport() {
  let closed = false,
    prepared = null,
    witness = null;
  const ov = openOverlay({
    title: 'Защищённая копия контактов',
    onClose: () => {
      closed = true;
      prepared = null;
      witness = null;
      ov.body.replaceChildren();
    }
  });
  const note = document.createElement('p');
  note.textContent =
    'В файл войдут контакты и пароли активных и архивных карточек на этом ПК. Входы GameCenter, сессии, отдельные копии старых контактов, настройки и прочие данные не включаются. Закройте другие копии приложения. После подготовки отдельно сохраните случайный ключ: без него файл невозможно открыть. Любой обладатель ключа и файла сможет прочитать контакты.';
  const message = document.createElement('p');
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'btn';
  start.textContent = 'Проверить данные и подготовить копию';
  const keyLabel = document.createElement('label');
  keyLabel.hidden = true;
  keyLabel.append('Ключ восстановления (сохраните отдельно от файла): ');
  const key = document.createElement('input');
  key.type = 'text';
  key.readOnly = true;
  key.autocomplete = 'off';
  key.spellcheck = false;
  keyLabel.append(key);
  const ackLabel = document.createElement('label');
  ackLabel.hidden = true;
  const ack = document.createElement('input');
  ack.type = 'checkbox';
  ackLabel.append(ack, ' Сохранил ключ отдельно и понимаю, что без него копия не откроется');
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'btn primary';
  download.textContent = 'Сохранить зашифрованный файл';
  download.disabled = true;
  ack.onchange = () => {
    download.disabled = !ack.checked || !prepared;
  };
  start.onclick = async () => {
    start.disabled = true;
    try {
      witness = sourceWitness();
      const source = await checkedSource(witness);
      if (closed) return;
      const encrypted = await encryptContactFile(contactSnapshotFromState(source));
      if (closed) return;
      await checkedSource(witness);
      if (closed) return;
      prepared = encrypted;
      key.value = encrypted.recoveryKey;
      keyLabel.hidden = ackLabel.hidden = false;
      message.textContent = `Подготовлено карточек: ${encrypted.count}. Файл проверен расшифровкой в памяти, но ещё не сохранён. Ключ показывается только здесь; храните его отдельно.`;
    } catch {
      prepared = null;
      witness = null;
      message.textContent =
        'Подготовка остановлена. Проверьте доступность и полноту контактов, отсутствие изменений и свободное место; никаких файлов не создано.';
      if (!closed) start.disabled = false;
    }
  };
  download.onclick = async () => {
    if (!prepared || !witness || !ack.checked) return;
    download.disabled = true;
    try {
      await checkedSource(witness);
      if (closed || !prepared) return;
      downloadEncryptedFile(prepared.file);
      message.textContent =
        'Сохранение запрошено, но приложение не подтверждает запись на носитель. Откройте сохранённый файл отдельно с ключом и проверьте содержимое; затем сохраните копию и ключ в разных надёжных местах.';
    } catch {
      prepared = null;
      witness = null;
      key.value = '';
      ack.checked = false;
      keyLabel.hidden = ackLabel.hidden = true;
      start.disabled = false;
      message.textContent =
        'Не удалось подтвердить сохранение или актуальность данных. Проверьте папку загрузок и источник; при необходимости подготовьте новую копию.';
    }
  };
  ov.body.append(note, start, message, keyLabel, ackLabel);
  ov.foot.append(download);
  return ov;
}

/** Opens a saved file for explicit, read-only manual recovery, with no state writes. */
export function openContactFileReview() {
  let closed = false;
  const ov = openOverlay({
    title: 'Открыть защищённую копию контактов',
    wide: true,
    onClose: () => {
      closed = true;
      ov.body.replaceChildren();
    }
  });
  const note = document.createElement('p');
  note.textContent =
    'Выберите ранее сохранённый файл и введите его отдельный ключ. Контакты показываются только здесь и не применяются автоматически. Файл может быть старым или подменённым тем, у кого есть ключ; сравните данные перед ручным переносом. Не показывайте ключ и пароли посторонним.';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'application/json,.json';
  file.setAttribute('aria-label', 'Зашифрованный файл контактов');
  const key = document.createElement('input');
  key.type = 'password';
  key.autocomplete = 'off';
  key.spellcheck = false;
  key.setAttribute('aria-label', 'Ключ восстановления файла');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn';
  open.textContent = 'Проверить и открыть';
  const message = document.createElement('p');
  const result = document.createElement('div');
  open.onclick = async () => {
    open.disabled = true;
    result.replaceChildren();
    try {
      const selected = file.files?.[0];
      if (!selected || selected.size > MAX_CONTACT_FILE_BYTES) throw new Error('invalid');
      const recoveryKey = key.value.trim();
      key.value = '';
      const contents = await selected.text();
      if (closed) return;
      const snapshot = await decryptContactFile(contents, recoveryKey);
      if (closed) return;
      message.textContent = `Карточек в копии: ${snapshot.characters.length}. Дата создания: ${snapshot.createdAt}. Ничего не записано в приложение.`;
      const label = document.createElement('label');
      const show = document.createElement('input');
      show.type = 'checkbox';
      label.append(show, ' Показать контакты и пароли');
      const table = document.createElement('div');
      const names = { email: 'Почта', password: 'Пароль', recoveryEmail: 'Резервная почта', phone: 'Телефон' };
      const render = () => {
        table.replaceChildren();
        for (const row of snapshot.characters) {
          const section = document.createElement('section');
          const title = document.createElement('h4');
          title.textContent = `${row.nick || 'Без имени'} · ID: ${row.id}${row.archived ? ' · архив' : ''}`;
          section.append(title);
          for (const field of CONTACT_FIELDS) {
            const line = document.createElement('p');
            const value = row.contacts[field];
            line.textContent = `${names[field]}: ${show.checked ? value || 'пусто' : value ? 'заполнено' : 'пусто'}`;
            section.append(line);
          }
          table.append(section);
        }
      };
      show.onchange = render;
      render();
      result.append(label, table);
    } catch {
      key.value = '';
      if (!closed)
        message.textContent =
          'Не удалось открыть копию: неверный ключ, повреждённый или неподдерживаемый файл. Данные не изменены.';
    } finally {
      if (!closed) open.disabled = false;
    }
  };
  ov.body.append(note, file, key, open, message, result);
  return ov;
}

// The journal indicates a possible interruption, not which operation completed.
// This UI never writes contacts or rolls back automatically.
import { readDuplicateMergeJournal, clearDuplicateMergeJournal } from '../core/duplicateMergeJournal.js';
import { inspectStoredBackup, forgetStoredBackupInspection } from '../core/storage.js';
import { openDuplicateContactBackup } from './duplicateContactBackup.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import { confirmModal, toast } from '../core/ui.js';

export function attachDuplicateMergeRecovery(entry) {
  const banner = document.getElementById('storage-readonly-banner');
  if (!banner || entry.status !== 'pending') return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.textContent = 'Проверить слияние и копии';
  button.onclick = () => openDuplicateMergeRecovery(entry);
  banner.append(button);
}

export function openDuplicateMergeRecovery(entry) {
  const ov = openOverlay({ title: 'Возможное прерывание слияния', wide: true });
  const text = document.createElement('p');
  text.textContent = `Операция могла завершиться полностью или только частично. Обычные записи остановлены. Закройте другие копии приложения и проверьте копию состояния «${entry.name}» и отдельные исходные контакты. Копия состояния сама по себе не восстанавливает записи хранилища ОС. При необходимости восстановите файл через Настройки → резервные копии и затем вручную сверьте контакты. Отметка хранится в профиле WebView и может не сохраниться при сбое или очистке профиля; её отсутствие не доказывает успешное слияние.`;
  const stateResult = document.createElement('p');
  const contactsResult = document.createElement('p');
  const checkState = document.createElement('button');
  const checkContacts = document.createElement('button');
  const finish = document.createElement('button');
  let stateChecked = false,
    contactsChecked = false;
  checkState.type = checkContacts.type = finish.type = 'button';
  checkState.className = checkContacts.className = finish.className = 'btn';
  checkState.textContent = 'Проверить копию состояния';
  checkContacts.textContent = 'Открыть исходные контакты';
  finish.textContent = 'Подтвердить ручную проверку и перезапустить';
  finish.disabled = true;
  const update = () => {
    finish.disabled = !(stateChecked && contactsChecked);
  };
  checkState.onclick = async () => {
    checkState.disabled = true;
    let review;
    try {
      review = await inspectStoredBackup(entry.name);
      if (review.schemaVersion === null || review.vaultReference === 'unknown') throw new Error('invalid');
      stateChecked = true;
      stateResult.textContent = `Копия прочитана: версия ${review.schemaVersion}, персонажей ${review.characters ?? 'не определено'}, в архиве ${review.archivedCharacters ?? 'не определено'}. Это проверка формата, а не доказательство полноты или подлинности.`;
    } catch {
      stateChecked = false;
      stateResult.textContent =
        'Не удалось проверить копию состояния. Ничего не восстанавливалось; проверьте резервные копии и файл.';
    } finally {
      if (review) forgetStoredBackupInspection(review);
      checkState.disabled = false;
      update();
    }
  };
  checkContacts.onclick = async () => {
    checkContacts.disabled = true;
    try {
      await openDuplicateContactBackup(entry.name);
      contactsChecked = true;
      contactsResult.textContent =
        'Защищённые записи прочитаны. Сравните их с актуальными контактами; автоматического восстановления нет.';
    } catch {
      contactsChecked = false;
      contactsResult.textContent = 'Не удалось прочитать защищённые записи. Проверьте хранилище ОС; не удаляйте копии.';
    } finally {
      checkContacts.disabled = false;
      update();
    }
  };
  finish.onclick = async () => {
    finish.disabled = true;
    try {
      const ok = await confirmModal({
        title: 'Завершить ручную проверку?',
        text: 'Это не восстанавливает контакты и не подтверждает целостность данных. Продолжайте только после проверки состояния и контактов и, при необходимости, восстановления копии. Приложение перезапустится, обычные записи снова станут доступны.',
        okText: 'Проверено, перезапустить',
        danger: true
      });
      if (!ok) return;
      const current = readDuplicateMergeJournal();
      if (current.status !== 'pending' || current.name !== entry.name || current.at !== entry.at)
        throw new Error('changed');
      clearDuplicateMergeJournal({ version: 1, name: entry.name, at: entry.at });
      window.location.reload();
    } catch {
      toast('Не удалось подтвердить отметку. Запись остаётся остановленной; проверьте копии.', 'error', 10000);
    } finally {
      update();
    }
  };
  ov.body.append(text, checkState, stateResult, checkContacts, contactsResult);
  ov.foot.append(finish);
  return ov;
}

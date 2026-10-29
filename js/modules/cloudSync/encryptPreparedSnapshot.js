// @ts-check
// Только подготовка зашифрованного файла, не сеть и не применение данных.
// Значения контактов не возвращаются вызывающему коду в открытом виде: результат — envelope.
import { buildPublicSnapshot } from './publicSnapshot.js';
import { encryptSnapshot } from './envelope.js';
import { array, boolean, object, text } from './exportSchema.js';

const SECRET_FIELDS = ['email', 'recoveryEmail', 'phone', 'password'];

/**
 * Все категории выключены по умолчанию. Пароли требуют ещё отдельного подтверждения риска.
 * Отсутствующая категория НЕ означает удаление в другом месте. Ключ восстановления должен
 * храниться вне файла; автоматического восстановления ключа этот модуль не предоставляет.
 * @param {{snapshot?: any, choices?: any, acknowledgePasswordRisk?: boolean, contactsSourceConfirmed?: boolean,
 *   settingsSelections?: string[], recoveryKey?: string, datasetId?: string, versionId?: string, cryptoSource?: Crypto}} [options]
 */
export async function encryptPreparedSnapshot(options = {}) {
  const opts = object(
    options,
    ['snapshot', 'recoveryKey', 'datasetId', 'versionId'],
    ['choices', 'acknowledgePasswordRisk', 'contactsSourceConfirmed', 'settingsSelections', 'cryptoSource']
  );
  const choice = object(Object.hasOwn(opts, 'choices') ? opts.choices : {}, [], SECRET_FIELDS);
  const selections = SECRET_FIELDS.filter(key => Object.hasOwn(choice, key) && boolean(choice[key]));
  if (selections.includes('password') && opts.acknowledgePasswordRisk !== true) {
    throw new Error('Для переноса паролей необходимо отдельно подтвердить риск');
  }
  if (Object.hasOwn(opts, 'acknowledgePasswordRisk')) boolean(opts.acknowledgePasswordRisk);
  if (Object.hasOwn(opts, 'contactsSourceConfirmed')) boolean(opts.contactsSourceConfirmed);
  // Пустое поле после сбоя vault не означает, что пользователь его очистил. Вызывающий
  // должен отдельно подтвердить полноту и корректность всех выбранных контактов.
  if (selections.length && opts.contactsSourceConfirmed !== true) {
    throw new Error('Не подтверждена полнота данных контактов; экспорт остановлен');
  }
  const publicSnapshot = buildPublicSnapshot(opts.snapshot, {
    settingsSelections: Object.hasOwn(opts, 'settingsSelections') ? opts.settingsSelections : []
  });
  /** @type {{schemaVersion: number, publicSnapshot: any, private?: any}} */
  const prepared = { schemaVersion: 1, publicSnapshot };
  if (selections.length) {
    const characters = [
      ...array(opts.snapshot.characters, value => value),
      ...array(opts.snapshot.archivedCharacters, value => value)
    ];
    const records = characters.map(character => {
      const contacts = object(character.contacts, SECRET_FIELDS);
      const fields = Object.fromEntries(selections.map(key => [key, text(contacts[key])]));
      return { characterId: character.syncId, fields };
    });
    prepared.private = { schemaVersion: 1, selections, records };
  }
  return encryptSnapshot({
    snapshot: prepared,
    recoveryKey: opts.recoveryKey,
    datasetId: opts.datasetId,
    versionId: opts.versionId,
    cryptoSource: opts.cryptoSource
  });
}

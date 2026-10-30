// @ts-check
// js/core/storage.js

import { serializeState } from './state.js';
import { tauriAdapter } from './storageAdapters/tauriAdapter.js';
import { localStorageAdapter } from './storageAdapters/localStorageAdapter.js';
import { prepareForDisk } from './secrets.js';
import { isUncertainStateWrite, uncertainStateWriteError } from './stateWriteOutcome.js';
import { isVaultWriteGuardError, vaultWriteGuardError, wasVaultUpdated } from './vaultWriteGuard.js';
import { beginCloudCredentialReset } from '../modules/cloudSync/credentialResetCoordination.js';

export const isTauri = () => {
  const w = /** @type {any} */ (window);
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__);
};

/**
 * Выбирает подходящий адаптер в зависимости от окружения.
 * Внутри Tauri — файл через Rust, в браузере (dev mode) — LocalStorage.
 */
export function getAdapter() {
  return isTauri() ? tauriAdapter : localStorageAdapter;
}

// Записи выстраиваются в очередь: параллельные persist() из фоновых скриптов
// не перемешиваются, а несколько вызовов подряд схлопываются в одну запись.
let writeChain = Promise.resolve();
let pending = null;
let restoring = false;
let resetting = false;
let loading = false;
let protectedState = false;
let outcomeUncertain = false;
let backupsInProgress = 0;
// Сохранения, запрошенные во время создания копии, ждут её завершения. Это
// координация одного JS-контекста, а не блокировка других процессов или вкладок.
/** @type {Promise<void> | null} */
let backupGate = null;
// Свидетельство связано с конкретным адаптером и объектом, реально прочитанным из хранилища.
const loadedBy = new WeakMap();
/** @type {null | {snapshot: any, adapter: any, phase: 'backing-up'|'ready'|'writing'}} */
let migration = null;

function blockedWriteError() {
  return new Error('Запись остановлена: проверьте сохранённые данные и резервные копии перед перезапуском приложения');
}

function blockUncertainWrites(source = 'state') {
  if (outcomeUncertain) return;
  outcomeUncertain = true;
  try {
    window.dispatchEvent(new CustomEvent('tf-storage-uncertain', { detail: { source } }));
  } catch {
    /* вне браузера */
  }
}

function notifyPersisted() {
  try {
    window.dispatchEvent(new CustomEvent('tf-persisted'));
  } catch {
    /* вне браузера */
  }
}

async function writeNow() {
  // Не начинаем подготовку vault, если предыдущий результат неизвестен.
  if (outcomeUncertain || protectedState) throw blockedWriteError();
  let data;
  try {
    // Вложенные объекты не разделяются с интерфейсом, пока prepareForDisk ждёт vault.
    const snapshot = JSON.parse(JSON.stringify(serializeState()));
    data = await prepareForDisk(snapshot);
    if (outcomeUncertain || protectedState) throw blockedWriteError();
    const confirmed = await getAdapter().saveState(data);
    if (confirmed !== true) throw uncertainStateWriteError();
  } catch (error) {
    // Даже подтверждённый отказ записи state не отменяет уже сделанные записи vault.
    // Такой частичный результат нельзя автоматически повторять или восстанавливать.
    if (isVaultWriteGuardError(error) || wasVaultUpdated(data)) {
      blockUncertainWrites('vault');
      throw vaultWriteGuardError();
    }
    if (isUncertainStateWrite(error)) blockUncertainWrites();
    throw error;
  }
  // Сообщаем остальным частям приложения, что данные сохранены.
  notifyPersisted();
}

/**
 * Проверка перед синхронным изменением общего состояния. Это проверка только этого
 * JS-контекста; она не удерживает блокировку через await и не проверяет диск.
 */
export function assertStateWriteAvailable() {
  if (outcomeUncertain || restoring || resetting || loading || protectedState || migration) throw blockedWriteError();
}

/**
 * После возможного частичного изменения памяти/хранилища не продолжаем обычные
 * записи и восстановление до проверки и перезапуска. Это не устойчивый карантин.
 */
export function haltAfterPartialStateChange() {
  blockUncertainWrites('state');
}

/**
 * Сохраняет текущее состояние в хранилище.
 * ВАЖНО: Не вызывает автоматический рендеринг UI!
 * Это критически важно для работы чекбоксов в таблице марафонов.
 */
export function persist() {
  try {
    assertStateWriteAvailable();
  } catch (error) {
    return Promise.reject(error);
  }
  if (pending) return pending;
  // Фиксируем именно текущий барьер до постановки в очередь. Не блокируем
  // пользователя отказом: изменения сохранятся после завершения копирования.
  const gate = backupGate;
  const scheduled = writeChain
    .catch(() => {})
    .then(async () => {
      if (gate) await gate;
      // Предыдущая запись не должна сбросить ссылку на новую запись после барьера.
      if (pending === scheduled) pending = null;
      return writeNow();
    })
    .catch(error => {
      // Детали ошибки могут содержать путь или личные данные; вызывающая сторона решает, что показать.
      console.error('[STORAGE] Не удалось подтвердить запись состояния.');
      // Ошибку видит вызывающий код; при неизвестном исходе откат на диск недопустим.
      throw error;
    });
  pending = writeChain = scheduled;
  return scheduled;
}

/**
 * Принудительное сохранение с немедленным обновлением всех разделов.
 * Используется при импорте/экспорте/смене таба/создании сущностей.
 */
export async function forceRenderAndPersist() {
  await persist();

  // Динамические импорты, чтобы избежать циклических зависимостей при старте
  const { renderCharacters } = await import('../modules/characters/list.js');
  const { renderParties } = await import('../modules/parties/index.js');
  const { renderMarathons } = await import('../modules/marathons/page.js');

  renderCharacters();
  renderParties();
  renderMarathons();
}

/** Мгновенное сохранение (дожидается очереди записей). */
export async function saveNow() {
  await persist();
}

/** Загрузка данных из хранилища. При ошибке не разрешаем записать значения по умолчанию поверх файла. */
export async function loadData() {
  if (outcomeUncertain || restoring || resetting || loading || protectedState || migration || backupsInProgress)
    throw blockedWriteError();
  loading = true;
  try {
    await writeChain.catch(() => {});
    if (outcomeUncertain) throw blockedWriteError();
    const adapter = getAdapter();
    const snapshot = await adapter.loadState();
    if (snapshot && typeof snapshot === 'object') loadedBy.set(snapshot, adapter);
    return snapshot;
  } catch (error) {
    protectedState = true;
    throw error;
  } finally {
    loading = false;
  }
}

/** Новая схема не должна быть перезаписана старой версией приложения. */
export function protectIncompatibleState() {
  protectedState = true;
}

/** Забываем временную копию исходной JSON-строки, если миграция не нужна. */
export function forgetLoadedState(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const adapter = loadedBy.get(snapshot);
  adapter?.forgetLoadedState?.(snapshot);
  loadedBy.delete(snapshot);
}

/**
 * Блокирует обычные записи в этом JS-контексте и создаёт проверенную копию именно
 * загруженного состояния, без удаления прежних копий. При любой ошибке запись остаётся
 * остановленной до восстановления или перезапуска. Это не межпроцессная блокировка.
 * @param {any} snapshot объект, возвращённый loadData
 * @param {string} label
 */
export async function beginGuardedMigration(snapshot, label) {
  if (outcomeUncertain || restoring || resetting || loading || protectedState || migration || backupsInProgress)
    throw blockedWriteError();
  const adapter = snapshot && typeof snapshot === 'object' ? loadedBy.get(snapshot) : null;
  if (!adapter) {
    protectedState = true;
    throw new Error('Исходные данные недоступны; миграция остановлена');
  }
  const session = { snapshot, adapter, phase: /** @type {'backing-up'|'ready'|'writing'} */ ('backing-up') };
  migration = session;
  try {
    // Даже подтверждённый отказ предыдущей записи может означать несохранённые
    // изменения в памяти: нельзя молча мигрировать прочитанный до них снимок.
    await writeChain;
    if (outcomeUncertain || protectedState) throw blockedWriteError();
    const name = await adapter.createMigrationBackup(snapshot, label);
    if (typeof name !== 'string' || !name) throw new Error('Не удалось подтвердить резервную копию');
    if (outcomeUncertain || protectedState || migration !== session) throw blockedWriteError();
    session.phase = 'ready';
    return name;
  } catch (error) {
    protectedState = true;
    forgetLoadedState(snapshot);
    if (migration === session) migration = null;
    throw error;
  }
}

/**
 * Завершает только чтение и проверенное копирование, без записи state. Вызывающий
 * обязан синхронно проверить неизменность данных в памяти перед этим вызовом;
 * если она нарушена, следует использовать abortGuardedMigration. Как и сама копия,
 * эта блокировка охватывает лишь текущий JS-контекст, а не другие процессы.
 */
export function finishGuardedBackup() {
  const session = migration;
  if (!session || session.phase !== 'ready' || outcomeUncertain || protectedState) throw blockedWriteError();
  forgetLoadedState(session.snapshot);
  migration = null;
}

/**
 * Сохраняет миграцию только если хранилище всё ещё содержит исходный JSON.
 * Подготовка vault и перенос профилей не входят в эту файловую транзакцию.
 * Иной процесс или вкладка могут изменить файл между проверкой и заменой.
 */
export async function commitGuardedMigration() {
  const session = migration;
  if (!session || session.phase !== 'ready' || outcomeUncertain || protectedState) throw blockedWriteError();
  session.phase = 'writing';
  let data;
  try {
    const snapshot = JSON.parse(JSON.stringify(serializeState()));
    data = await prepareForDisk(snapshot);
    if (outcomeUncertain || protectedState || migration !== session) throw blockedWriteError();
    const confirmed = await session.adapter.saveMigratedState(session.snapshot, data);
    if (confirmed !== true) throw uncertainStateWriteError();
    if (outcomeUncertain || protectedState || migration !== session) {
      blockUncertainWrites();
      throw blockedWriteError();
    }
    notifyPersisted();
  } catch (error) {
    protectedState = true;
    if (isVaultWriteGuardError(error) || wasVaultUpdated(data)) {
      blockUncertainWrites('vault');
      throw vaultWriteGuardError();
    }
    if (isUncertainStateWrite(error)) blockUncertainWrites();
    throw error;
  } finally {
    forgetLoadedState(session.snapshot);
    if (migration === session) migration = null;
  }
}

/** Аварийный выход до записи: текущая копия остаётся, обычные записи запрещены. */
export function abortGuardedMigration() {
  if (!migration) return;
  protectedState = true;
  // Выполняющаяся операция снимает блокировку и освобождает исходный JSON сама.
  if (migration.phase === 'ready') {
    forgetLoadedState(migration.snapshot);
    migration = null;
  }
}

/**
 * Восстановление заменяет сохранённое состояние, но не сохраняет текущие данные
 * из памяти: они могут быть значениями по умолчанию после ошибки загрузки.
 * Дожидаемся уже запланированных записей и не принимаем новые до перезапуска.
 * Это ограничение одного JS-контекста, не блокировка других вкладок/процессов.
 * @param {string} fileName
 * @param {any} [inspection] one-use review returned by inspectStoredBackup
 * @param {() => boolean} [isUnchanged] checks the user's in-memory review
 */
export async function restoreStoredBackup(fileName, inspection, isUnchanged) {
  // A failed or incompatible initial load must block ordinary saves, not recovery from a backup.
  if (outcomeUncertain || restoring || resetting || loading || migration || backupsInProgress)
    throw blockedWriteError();
  restoring = true;
  try {
    await writeChain.catch(() => {});
    if (outcomeUncertain) throw blockedWriteError();
    if (isUnchanged) {
      let same = false;
      try {
        same = isUnchanged() === true;
      } catch {
        /* a failed check cannot authorize replacement */
      }
      if (!same) throw new Error('Данные изменились после просмотра; откройте копию заново');
    }
    const adapter = getAdapter();
    const confirmed =
      inspection === undefined
        ? await adapter.restoreBackup(fileName)
        : await adapter.restoreBackup(fileName, inspection);
    if (confirmed !== true) throw uncertainStateWriteError();
    // После успеха данные в памяти устарели: запись остаётся заблокированной до reload.
  } catch (error) {
    if (isUncertainStateWrite(error)) blockUncertainWrites();
    if (!outcomeUncertain) restoring = false;
    throw error;
  }
}

/**
 * Read-only review of a state-only backup and current disk state. The adapter
 * privately keeps a one-use witness; it is not a vault backup or a CAS.
 * Failed/incompatible initial loads must not prevent inspecting recovery copies.
 */
export async function inspectStoredBackup(fileName) {
  if (outcomeUncertain || restoring || resetting || loading || migration || backupsInProgress)
    throw blockedWriteError();
  backupsInProgress++;
  try {
    await writeChain.catch(() => {});
    if (outcomeUncertain) throw blockedWriteError();
    return await getAdapter().inspectBackup(fileName);
  } finally {
    backupsInProgress--;
  }
}

export function forgetStoredBackupInspection(inspection) {
  getAdapter().forgetBackupInspection?.(inspection);
}

/**
 * Резервная копия сохранённого state с учётом настроек ротации. Дожидаемся уже
 * поставленных записей; новые в этом контексте ждут окончания копии. Ошибка предыдущей
 * записи не позволяет представить старый файл как копию актуальных изменений.
 * Копия не включает vault и не блокирует другие вкладки или процессы.
 */
export async function createBackup(label) {
  // protectedState намеренно не проверяется: при неудачной загрузке или новой схеме
  // полезно иметь возможность скопировать сохранённый файл, не записывая память.
  if (migration || resetting || restoring || loading || outcomeUncertain || backupsInProgress)
    throw blockedWriteError();
  backupsInProgress++;
  const precedingWrites = writeChain;
  // Даже если прежняя запись ещё не начала выполняться, новый запрос не должен
  // схлопнуться с её promise и завершиться раньше копирования.
  pending = null;
  /** @type {() => void} */
  let release = () => {};
  backupGate = new Promise(resolve => {
    release = resolve;
  });
  try {
    try {
      await precedingWrites;
    } catch {
      // Детали исключения могут содержать путь или сведения о пользователе.
      throw new Error('Предыдущее сохранение не подтверждено; резервная копия не создана');
    }
    if (outcomeUncertain) throw blockedWriteError();
    const { state } = await import('./state.js');
    let name;
    try {
      name = await getAdapter().createBackup({ maxCount: state.settings?.backups?.maxCount ?? 10, label });
    } catch {
      // Копия могла появиться даже при потерянном ответе; не показываем детали IPC или файловой системы.
      throw new Error('Создание резервной копии не подтверждено; проверьте список копий и свободное место');
    }
    if (outcomeUncertain) throw blockedWriteError();
    if (typeof name !== 'string' || !name.trim()) throw new Error('Создание резервной копии не подтверждено');
    return name;
  } finally {
    backupGate = null;
    backupsInProgress--;
    release();
  }
}

/** Удаление копии не должно пересекаться с восстановлением и другими операциями копирования. */
export async function deleteStoredBackup(fileName) {
  if (migration || resetting || outcomeUncertain || restoring || loading || protectedState || backupsInProgress)
    throw blockedWriteError();
  backupsInProgress++;
  try {
    const confirmed = await getAdapter().deleteBackup(fileName);
    if (confirmed !== true) throw new Error('Удаление копии не подтверждено');
  } finally {
    backupsInProgress--;
  }
}

/** @param {unknown} error */
export function isUncertainFactoryReset(error) {
  return error instanceof Error && error.message.startsWith('TF_FACTORY_RESET_UNCERTAIN:');
}

/**
 * Только координация этого JS-контекста: блокируем новые операции, дожидаемся
 * очереди и перепроверяем согласованный пользователем снимок до вызова IPC.
 * После вызова сброса любой отказ может означать частичное удаление. До
 * перезапуска не разрешаем повтор, сохранение или восстановление.
 * Это не межпроцессная блокировка и не транзакция других хранилищ.
 * @param {() => boolean} isUnchanged
 * @param {() => Promise<any>} inspect
 * @param {(witness: any) => Promise<any>} perform
 */
export async function runGuardedFactoryReset(isUnchanged, inspect, perform) {
  if (outcomeUncertain || restoring || resetting || loading || protectedState || migration || backupsInProgress) {
    throw blockedWriteError();
  }
  // Если в этом окне ещё идёт вход/забывание OAuth, сброс не должен удалить
  // запись раньше, чем поздний IPC сможет её снова создать. Другие процессы и
  // прямые IPC эта координация не охватывает.
  const releaseCloudBarrier = beginCloudCredentialReset();
  resetting = true;
  let dispatched = false;
  try {
    // Не удаляем копии, если предыдущая запись завершилась с ошибкой: в памяти
    // могут быть изменения, которых нет в файле.
    try {
      await writeChain;
    } catch {
      throw new Error('Сброс остановлен: предыдущее сохранение не завершилось. Проверьте данные и копии.');
    }
    if (outcomeUncertain || protectedState) throw blockedWriteError();
    const assertUnchanged = () => {
      let unchanged = false;
      try {
        unchanged = isUnchanged() === true;
      } catch {
        /* Не удалось проверить согласованный снимок. */
      }
      if (!unchanged) throw new Error('Данные изменились после подтверждения. Проверьте и подтвердите сброс заново.');
    };
    assertUnchanged();
    let witness;
    try {
      witness = await inspect();
    } catch {
      // Ошибка чтения исходного файла не должна разрешать запись поверх него.
      protectedState = true;
      try {
        window.dispatchEvent(new CustomEvent('tf-factory-reset-read-failed'));
      } catch {
        /* вне браузера */
      }
      throw new Error('Не удалось проверить исходный файл. Сохранение и сброс остановлены; проверьте данные и копии.');
    }
    if (outcomeUncertain || protectedState) throw blockedWriteError();
    assertUnchanged();
    try {
      window.dispatchEvent(new CustomEvent('tf-factory-reset-started'));
    } catch {
      /* вне браузера */
    }
    dispatched = true;
    try {
      return await perform(witness);
    } catch {
      blockUncertainWrites('reset');
      throw new Error('TF_FACTORY_RESET_UNCERTAIN: Сброс мог затронуть часть данных; его результат не подтверждён');
    }
  } finally {
    // После начала операции память устарела даже при сообщённом успехе.
    if (!dispatched) {
      resetting = false;
      releaseCloudBarrier();
    }
  }
}

// @ts-check
// Локальная подготовка нового набора ключей. Это НЕ подключение диска: не ищет
// существующие данные, не делает backup state и не создаёт файл в облаке. Нельзя
// включать в UI без проверки исходного состояния, согласования и восстановления.
// Секреты возвращаются только для явно выбранного отображения пользователю и
// хранятся в памяти JS; гарантированного стирания строк в JS нет.
import { object } from './exportSchema.js';
import { generateSyncId } from './envelope.js';
import { createKeyBundle, openKeyBundle } from './keyBundle.js';
import { createKeyStateRecord } from './keyStateRecord.js';

function failed() {
  return new Error('Не удалось безопасно подготовить ключ синхронизации');
}
function result(status) {
  return Object.freeze({ status });
}

/**
 * Один процесс подготовки за раз. `newDatasetConfirmed` — согласие создать новый
 * независимый набор, а не доказательство отсутствия старого облака. Запасной ключ
 * необходимо отдельно сохранить и ввести заново до записи в хранилище ОС.
 * @param {{store:any, cryptoSource?:Crypto}} options
 */
export function createKeyProvisioner(options) {
  let input;
  try {
    input = object(options, ['store'], ['cryptoSource']);
    if (!input.store || typeof input.store.read !== 'function' || typeof input.store.install !== 'function')
      throw failed();
  } catch {
    throw failed();
  }
  const { store, cryptoSource } = input;
  let active = false;
  return Object.freeze({
    async begin(value) {
      if (active) throw failed();
      let params;
      try {
        params = object(value, ['primary', 'backup', 'newDatasetConfirmed']);
        if (params.newDatasetConfirmed !== true) throw failed();
      } catch {
        throw failed();
      }
      active = true;
      let handedOff = false;
      try {
        const local = await store.read();
        if (local?.status === 'ready') return result('already_configured');
        if (local?.status !== 'empty') return result('local_blocked');
        const datasetId = generateSyncId(cryptoSource);
        let created = await createKeyBundle({
          datasetId,
          primary: params.primary,
          backup: params.backup,
          cryptoSource
        });
        const generatedBackupSecret = created.generatedBackupSecret;
        const publicPin = Object.freeze({ ...created.pin });
        let pending = {
          slotId: generateSyncId(cryptoSource),
          revision: generateSyncId(cryptoSource),
          datasetId,
          bundle: created.bundle,
          pin: created.pin,
          dataKey: created.dataKey
        };
        created = null;
        // Проверяем формат/доказательство до показа готового набора; случайные
        // столкновения UUID не исправляем молча и не сохраняем.
        let expectedRaw = (await createKeyStateRecord(pending, cryptoSource)).raw;
        let phase = 'prepared';
        const close = () => {
          pending = null;
          expectedRaw = null;
          phase = 'closed';
          active = false;
        };
        const attempt = Object.freeze({
          status: 'prepared',
          datasetId,
          pin: publicPin,
          generatedBackupSecret,
          cancel() {
            if (phase === 'closed') return result('closed');
            if (phase === 'installing') return result('installation_in_progress');
            close();
            return result('cancelled');
          },
          async confirmBackup(value) {
            if (phase !== 'prepared' || !pending) throw failed();
            let confirmation;
            try {
              confirmation = object(value, ['secret', 'savedSeparately']);
              if (confirmation.savedSeparately !== true) return result('confirmation_required');
              if (typeof confirmation.secret !== 'string') throw failed();
            } catch {
              throw failed();
            }
            phase = 'verifying';
            let opened;
            try {
              opened = await openKeyBundle({
                bundle: pending.bundle,
                expectedDatasetId: pending.datasetId,
                expectedPin: pending.pin,
                role: 'backup',
                secret: confirmation.secret,
                cryptoSource
              });
            } catch {
              if (phase === 'closed') return result('cancelled');
              phase = 'prepared';
              return result('invalid_backup');
            }
            if (phase === 'closed' || !pending) return result('cancelled');
            if (opened.dataKey !== pending.dataKey) {
              close();
              return result('local_blocked');
            }
            phase = 'installing';
            try {
              const installed = await store.install(pending);
              if (installed?.status === 'occupied') {
                close();
                return result('already_configured');
              }
              if (installed?.status === 'blocked') {
                close();
                return result('local_blocked');
              }
              if (installed?.status !== 'installed') {
                close();
                return result('installation_uncertain');
              }
              const readback = await store.read();
              if (readback?.status !== 'ready' || readback.raw !== expectedRaw) {
                close();
                return result('installation_uncertain');
              }
              close();
              return result('installed');
            } catch {
              close();
              return result('installation_uncertain');
            }
          }
        });
        handedOff = true;
        return attempt;
      } catch {
        throw failed();
      } finally {
        if (!handedOff) active = false;
      }
    }
  });
}

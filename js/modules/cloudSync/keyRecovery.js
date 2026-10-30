// @ts-check
// Экспериментальное восстановление локальной OS-записи из зашифрованной версии v2.
// НЕТ поиска облака, проверки аккаунта, доказательства независимости pin, свежести,
// истории, локального backup или применения state. Не подключать как готовую sync.
// Успех означает только проверенную установку и readback; OS vault не доказывает fsync.
import { generateSyncId, isSyncId } from './envelope.js';
import { object } from './exportSchema.js';
import { createKeyStateRecord } from './keyStateRecord.js';
import { inspectPortableEnvelope, openPortableEnvelope } from './portableKeyCapsule.js';

const HEX = /^[0-9a-f]{64}(?![\s\S])/;
function failed() {
  return new Error('Не удалось безопасно восстановить ключ синхронизации');
}
function result(status) {
  return Object.freeze({ status });
}
function copyPin(value) {
  const pin = object(value, ['bundleId', 'sha256']);
  if (!isSyncId(pin.bundleId) || typeof pin.sha256 !== 'string' || !HEX.test(pin.sha256)) throw failed();
  return Object.freeze({ bundleId: pin.bundleId, sha256: pin.sha256 });
}

/**
 * Один активный процесс на экземпляр. `independentPinConfirmed` — утверждение вызывающего
 * кода о сравнении с другим доверенным ПК/носителем, не криптографическое доказательство.
 * Не заменяет обнаружение отката облака и проверки подлинности аккаунта.
 * @param {{store:any, cryptoSource?:Crypto}} options
 */
export function createKeyRecoverer(options) {
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
      let args;
      let expectedPin;
      try {
        args = object(value, ['envelope', 'expectedDatasetId', 'expectedPin', 'independentPinConfirmed']);
        expectedPin = copyPin(args.expectedPin);
        if (!isSyncId(args.expectedDatasetId)) throw failed();
        if (args.independentPinConfirmed !== true) return result('confirmation_required');
      } catch {
        throw failed();
      }
      active = true;
      let handedOff = false;
      try {
        // inspect копирует файл до первого await; чужое изменение во время проверки не действует.
        const inspected = await inspectPortableEnvelope({ envelope: args.envelope, cryptoSource });
        if (
          inspected.envelope.datasetId !== args.expectedDatasetId ||
          inspected.pin.bundleId !== expectedPin.bundleId ||
          inspected.pin.sha256 !== expectedPin.sha256
        )
          return result('pin_mismatch');
        const local = await store.read();
        if (local?.status === 'ready') return result('already_configured');
        if (local?.status !== 'empty') return result('local_blocked');
        const datasetId = inspected.envelope.datasetId;
        const versionId = inspected.envelope.versionId;
        let envelope = inspected.envelope;
        let phase = 'prepared';
        const close = () => {
          if (phase === 'closed') return;
          envelope = null;
          phase = 'closed';
          active = false;
        };
        const attempt = Object.freeze({
          status: 'prepared',
          datasetId,
          versionId,
          pin: expectedPin,
          cancel() {
            if (phase === 'closed') return result('closed');
            if (phase === 'installing') return result('installation_in_progress');
            close();
            return result('cancelled');
          },
          async recover(value) {
            if (phase !== 'prepared' || !envelope) throw failed();
            let params;
            try {
              params = object(value, ['role', 'secret']);
              if (!['main', 'backup'].includes(params.role) || typeof params.secret !== 'string') throw failed();
            } catch {
              throw failed();
            }
            phase = 'verifying';
            let opened;
            try {
              opened = await openPortableEnvelope({
                envelope,
                expectedDatasetId: datasetId,
                expectedPin,
                role: params.role,
                secret: params.secret,
                cryptoSource
              });
            } catch {
              if (phase === 'closed') return result('cancelled');
              phase = 'prepared';
              return result('invalid_secret_or_file');
            }
            if (phase === 'closed' || !envelope) return result('cancelled');
            const pending = {
              slotId: generateSyncId(cryptoSource),
              revision: generateSyncId(cryptoSource),
              datasetId,
              bundle: opened.bundle,
              pin: expectedPin,
              dataKey: opened.dataKey
            };
            // Независимая проверка локальной записи; расшифрованный снимок не применяется.
            let expectedRaw;
            try {
              expectedRaw = (await createKeyStateRecord(pending, cryptoSource)).raw;
            } catch {
              if (phase === 'closed') return result('cancelled');
              close();
              return result('local_blocked');
            }
            if (phase === 'closed' || !envelope) return result('cancelled');
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
              // Не повторять install: исключение не доказывает отсутствие записи.
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

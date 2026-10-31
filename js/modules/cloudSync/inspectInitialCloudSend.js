// @ts-check
// Read-only local preflight. No refresh, HTTP, upload, save, repair or queue writes.
// A ready result is NOT proof of API access or permission to send without rechecking.
import { object } from './exportSchema.js';
import { readLocalCloudPairingCode } from './initialCloudSetup.js';
import { readNativeCredentialBinding } from './providers/nativeCredentialStore.js';
import { parseGoogleCredentialRecord } from './providers/oauthCredentialRecord.js';
import { parseYandexCredentialRecord } from './providers/oauthYandexCredentialRecord.js';

const result = status => Object.freeze({ status });

/** @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,timeoutMs?:number,now?:()=>number}} options */
export async function inspectInitialCloudSend(options) {
  const input = object(options, ['provider', 'invoke'], ['timeoutMs', 'now']);
  const ms = input.timeoutMs ?? 25_000;
  if (
    !['google', 'yandex'].includes(input.provider) ||
    typeof input.invoke !== 'function' ||
    !Number.isSafeInteger(ms) ||
    ms < 20 ||
    ms > 120_000 ||
    (input.now !== undefined && typeof input.now !== 'function')
  )
    throw new Error('Некорректная локальная проверка');
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const common = { provider, invoke: input.invoke, timeoutMs: ms };
  let failure = 'probe_binding_unavailable';
  try {
    const before = /** @type {any} */ (await readLocalCloudPairingCode(common));
    if (before.status !== 'ready')
      return result(['binding_missing_or_blocked', 'queue_blocked'].includes(before.status) ? before.status : failure);
    failure = 'probe_credential_read_unavailable';
    const account = await readNativeCredentialBinding(common);
    if (account.status !== 'ready') return result('credential_missing_or_blocked');
    let timer;
    let reply;
    try {
      reply = object(
        await Promise.race([
          Promise.resolve().then(() => input.invoke('cloud_credential_read', { provider })),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('read timeout')), ms);
          })
        ]),
        ['status'],
        ['slotId', 'record']
      );
    } finally {
      clearTimeout(timer);
    }
    if (reply.status === 'empty' && Object.keys(reply).length === 1) return result('credential_missing');
    if (reply.status !== 'ready' || Object.keys(reply).length !== 3) return result('credential_blocked');
    failure = 'probe_credential_record_invalid';
    const record =
      provider === 'yandex' ? parseYandexCredentialRecord(reply.record) : parseGoogleCredentialRecord(reply.record);
    if (
      reply.slotId !== account.binding.slotId ||
      record.slotId !== account.binding.slotId ||
      record.clientId !== account.binding.clientId ||
      record.accountKey !== account.binding.accountKey
    )
      return result('credential_blocked');
    if (provider === 'google' && record.phase !== 'ready') return result('credential_blocked');
    failure = 'probe_clock_unavailable';
    const now = (input.now || Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) return result(failure);
    const expiresAt = provider === 'yandex' ? record.expiresAt : record.refreshExpiresAt;
    if (expiresAt !== null && now + 5000 >= expiresAt) return result('login_required');
    failure = 'probe_binding_unavailable';
    const after = /** @type {any} */ (await readLocalCloudPairingCode(common));
    if (after.status !== 'ready' || before.pairingCode !== after.pairingCode) return result('local_binding_changed');
    failure = 'probe_clock_unavailable';
    const checkedAt = (input.now || Date.now)();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < now) return result(failure);
    if (expiresAt !== null && checkedAt + 5000 >= expiresAt) return result('login_required');
    return result('local_send_ready');
  } catch {
    return result(failure);
  }
}

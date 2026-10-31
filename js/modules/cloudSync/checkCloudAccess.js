// @ts-check
// Explicit API preflight. No queue, key, dataset or file writes. Google may rotate
// saved credentials when refreshing; Yandex can provision its app folder on GET.
import { object } from './exportSchema.js';
import { openPinnedNativeCloudSession } from './providers/pinnedNativeCloudSession.js';
import { beginCloudDataOperation } from './credentialResetCoordination.js';

/** @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,cryptoSource?:Crypto,timeoutMs?:number,now?:()=>number,openSession?:typeof openPinnedNativeCloudSession}} options */
export async function checkCloudAccess(options) {
  const input = object(options, ['provider', 'invoke'], ['cryptoSource', 'timeoutMs', 'now', 'openSession']);
  if (!['google', 'yandex'].includes(input.provider) || typeof input.invoke !== 'function')
    throw new Error('Неверная проверка диска');
  let operation, session;
  let uncertainRefresh = false;
  try {
    operation = beginCloudDataOperation();
    uncertainRefresh = input.provider === 'google';
    const opened = /** @type {any} */ (
      await (input.openSession || openPinnedNativeCloudSession)({
        provider: input.provider,
        invoke: input.invoke,
        ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.now ? { now: input.now } : {})
      })
    );
    if (opened.status !== 'opened') return Object.freeze({ status: opened.status });
    uncertainRefresh = false;
    session = opened.session;
    const checked = await session.checkAccount();
    return Object.freeze({ status: checked.status });
  } catch {
    return Object.freeze({ status: 'unavailable' });
  } finally {
    session?.dispose?.();
    operation?.finish(uncertainRefresh);
  }
}

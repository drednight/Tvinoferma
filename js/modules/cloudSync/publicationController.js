// @ts-check
// Планировщик узкого экспериментального режима. Включается только явно на этом ПК;
// настройки не входят в переносимый state. Он не обходит проверки истории и не
// повторяет неизвестный запрос создания. Отмена не прерывает уже начатый native IPC.
import { queueConnectedSavedSnapshot, sendConnectedQueuedSnapshot } from './connectedPublication.js';

const KEY = 'tf_cloud_auto_publication_v1';
const DEBOUNCE_MS = 1500;
const RETRY_MS = 90_000;
const STARTUP_MS = 5000;
const CAN_SEND = new Set(['queued', 'coalesced', 'unchanged', 'discarded_unpublished']);
// Эти причины не дают опубликовать новый снимок; sendConnected... при них
// может только сверить уже начатую попытку, иначе самостоятельно остановится.
const CAN_CHECK_ATTEMPT = new Set([
  'deletions_need_review',
  'provenance_review_required',
  'state_changed_or_unsaved',
  'data_unprepared'
]);
function parse(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'provider,version' ||
      value.version !== 1 ||
      !['google', 'yandex'].includes(value.provider)
    )
      return null;
    return value.provider;
  } catch {
    return null;
  }
}
function providerName(value) {
  return value === 'google' || value === 'yandex';
}

/**
 * Участники и часы внедряются для детерминированных тестов. localStorage здесь
 * содержит только разрешение на автоматизацию и имя провайдера, без данных и ключей.
 * Это не защищённая отметка, не межпроцессный lock и не доказательство доставки.
 * @param {{win:Window,desktop:boolean,storage?:Storage,loadNative?:()=>Promise<{invoke:(command:string,args:any)=>Promise<any>}>,
 * queue?:typeof queueConnectedSavedSnapshot,send?:typeof sendConnectedQueuedSnapshot,
 * report?:(provider:string,stage:string,status:string)=>void,isOnline?:()=>boolean,allowAutomatic?:boolean}} options
 */
export function createPublicationController(options) {
  const win = options.win;
  const queue = options.queue || queueConnectedSavedSnapshot;
  const send = options.send || sendConnectedQueuedSnapshot;
  const loadNative = options.loadNative || (async () => ({ invoke: (await import('@tauri-apps/api/core')).invoke }));
  const report = options.report || (() => {});
  const isOnline = options.isOnline || (() => win.navigator.onLine !== false);
  let storage;
  try {
    storage = options.storage || win.localStorage;
  } catch {
    storage = null;
  }
  let configured = null;
  try {
    configured = storage ? parse(storage.getItem(KEY)) : null;
  } catch {
    configured = null;
  }
  if (options.allowAutomatic === false) configured = null;
  let ready = false;
  let disposed = false;
  let active = false;
  let runningAutomatically = false;
  let rerun = false;
  let controller = null;
  let timer = null;
  let retryTimer = null;
  let startupTimer = null;

  function emit(provider, stage, status) {
    try {
      report(provider, stage, status);
    } catch {
      /* UI и журнал не влияют на сохранение или отправку */
    }
  }
  function allowed(provider) {
    return options.desktop && !disposed && ready && configured === provider && !controller?.signal.aborted;
  }
  function cancelTimers() {
    if (timer !== null) win.clearTimeout(timer);
    if (retryTimer !== null) win.clearTimeout(retryTimer);
    if (startupTimer !== null) win.clearTimeout(startupTimer);
    timer = retryTimer = startupTimer = null;
  }
  function schedule(delay = DEBOUNCE_MS) {
    if (!configured || !options.desktop || disposed || !ready) return;
    if (active) {
      rerun = true;
      return;
    }
    if (timer !== null) win.clearTimeout(timer);
    timer = win.setTimeout(() => {
      timer = null;
      void execute(configured, true);
    }, delay);
  }
  function retryLater() {
    if (!configured || !options.desktop || disposed || !ready) return;
    if (retryTimer !== null) win.clearTimeout(retryTimer);
    retryTimer = win.setTimeout(() => {
      retryTimer = null;
      schedule(0);
    }, RETRY_MS);
  }
  async function execute(provider, automatic) {
    if (!providerName(provider) || !options.desktop || disposed) return Object.freeze({ status: 'unavailable' });
    if (active) {
      if (automatic) rerun = true;
      return Object.freeze({ status: 'busy' });
    }
    if (automatic && (!ready || configured !== provider)) return Object.freeze({ status: 'cancelled' });
    active = true;
    runningAutomatically = automatic;
    controller = new AbortController();
    const signal = controller.signal;
    const canContinue = () => !signal.aborted && !disposed && (!automatic || allowed(provider));
    try {
      const native = await loadNative();
      if (!canContinue()) return Object.freeze({ status: 'cancelled' });
      // Двух проходов достаточно для сверки потерянного ответа и отправки
      // последней сохранённой версии. Остальное остаётся в очереди до повтора.
      for (let round = 0; round < 2; round++) {
        const prepared = await queue({ provider, invoke: native.invoke, prepareIdentities: true });
        if (!canContinue()) return Object.freeze({ status: 'cancelled' });
        emit(provider, 'queue', prepared.status);
        if (!CAN_SEND.has(prepared.status) && !CAN_CHECK_ATTEMPT.has(prepared.status)) return prepared;
        if (!isOnline()) {
          if (CAN_SEND.has(prepared.status)) emit(provider, 'send', 'offline');
          return CAN_SEND.has(prepared.status) ? Object.freeze({ status: 'offline' }) : prepared;
        }
        const sent = await send({ provider, invoke: native.invoke, signal });
        if (!canContinue()) return Object.freeze({ status: 'cancelled' });
        // При блокировке очереди сохраняем исходную причину; дополнительно
        // показываем только неподтверждённый исход уже начатой попытки.
        if (!CAN_SEND.has(prepared.status)) {
          if (['verification_pending', 'cloud_content_mismatch'].includes(sent.status))
            emit(provider, 'send', sent.status);
          return prepared;
        }
        emit(provider, 'send', sent.status);
        if (sent.status !== 'verified_previous_attempt') return sent;
      }
      schedule(0);
      return Object.freeze({ status: 'more_pending' });
    } catch {
      emit(provider, 'send', 'unavailable_or_busy');
      return Object.freeze({ status: 'unavailable_or_busy' });
    } finally {
      active = false;
      runningAutomatically = false;
      controller = null;
      if (rerun) {
        rerun = false;
        schedule(DEBOUNCE_MS);
      }
      retryLater();
    }
  }
  function onStartup() {
    if (ready || disposed || !options.desktop) return;
    ready = true;
    if (configured) {
      // Сначала запускается существующая проверка обоих дисков. Если она ещё
      // работает, барьер вернёт busy и повтор произойдёт по таймеру.
      startupTimer = win.setTimeout(() => {
        startupTimer = null;
        schedule(0);
      }, STARTUP_MS);
    }
  }
  function onPersisted() {
    schedule();
  }
  function onOnline() {
    schedule(0);
  }
  function onReset() {
    cancelTimers();
    if (runningAutomatically) controller?.abort();
    configured = null;
    try {
      storage?.removeItem(KEY);
    } catch {
      /* reset и удаление привязок должны оставаться независимыми */
    }
  }
  win.addEventListener('tf-cloud-startup-check', onStartup);
  win.addEventListener('tf-persisted', onPersisted);
  win.addEventListener('tf-cloud-root-confirmed', onOnline);
  win.addEventListener('tf-cloud-reconciled', onOnline);
  win.addEventListener('online', onOnline);
  win.addEventListener('tf-factory-reset-started', onReset);

  return Object.freeze({
    configuredProvider() {
      return configured;
    },
    /** Сохраняет разрешение только после явного согласия UI и проверяет чтение. */
    enable(provider) {
      if (options.allowAutomatic === false || !options.desktop || !providerName(provider) || disposed || !storage)
        return false;
      const value = JSON.stringify({ version: 1, provider });
      try {
        storage.setItem(KEY, value);
        if (storage.getItem(KEY) !== value) throw new Error('write unconfirmed');
      } catch {
        configured = null;
        if (runningAutomatically) controller?.abort();
        try {
          storage.removeItem(KEY);
        } catch {
          /* результат записи не подтверждён */
        }
        return false;
      }
      if (configured !== provider && runningAutomatically) controller?.abort();
      configured = provider;
      schedule();
      return true;
    },
    /** Отключает новые автоматические запросы; начатый IPC может завершиться. */
    disable() {
      configured = null;
      cancelTimers();
      if (runningAutomatically) controller?.abort();
      try {
        if (!storage) return false;
        storage.removeItem(KEY);
        return storage.getItem(KEY) === null;
      } catch {
        return false;
      }
    },
    /** Ручное действие не включает автоматизацию и требует отдельного подтверждения UI. */
    runManual(provider) {
      return execute(provider, false);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimers();
      controller?.abort();
      win.removeEventListener('tf-cloud-startup-check', onStartup);
      win.removeEventListener('tf-persisted', onPersisted);
      win.removeEventListener('tf-cloud-root-confirmed', onOnline);
      win.removeEventListener('tf-cloud-reconciled', onOnline);
      win.removeEventListener('online', onOnline);
      win.removeEventListener('tf-factory-reset-started', onReset);
    }
  });
}

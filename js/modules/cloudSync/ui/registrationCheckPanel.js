// @ts-check
// Интерфейс разовой диагностики, не включающий облачную синхронизацию.
// В эту форму вводится только публичный ID приложения, без client secret.
import { validOAuthClientId } from '../providers/oauthCommon.js';
import { checkCloudOAuthRegistration } from '../providers/oauthRegistrationCheck.js';

/**
 * @param {{doc?:Document, desktop:boolean,
 * loadNative?:()=>Promise<{invoke:(command:string,args:any)=>Promise<any>,openBrowser:(url:string)=>Promise<any>}>,
 * check?:typeof checkCloudOAuthRegistration}} options
 */
export function bindCloudRegistrationCheck(options) {
  const doc = options.doc || document;
  const panel = /** @type {HTMLDetailsElement|null} */ (doc.getElementById('cloud-registration-panel'));
  const form = /** @type {HTMLFormElement|null} */ (doc.getElementById('cloud-registration-form'));
  const provider = /** @type {HTMLSelectElement|null} */ (doc.getElementById('cloud-registration-provider'));
  const client = /** @type {HTMLInputElement|null} */ (doc.getElementById('cloud-registration-client'));
  const start = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-registration-start'));
  const cancelButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-registration-cancel'));
  const status = doc.getElementById('cloud-registration-status');
  const account = doc.getElementById('cloud-registration-account');
  const accountLabel = doc.getElementById('cloud-registration-account-label');
  const accountValue = doc.getElementById('cloud-registration-account-value');
  const yandexHint = doc.getElementById('cloud-registration-yandex-hint');
  const googleHint = doc.getElementById('cloud-registration-google-hint');
  if (
    !yandexHint ||
    !googleHint ||
    !panel ||
    !form ||
    !provider ||
    !client ||
    !start ||
    !cancelButton ||
    !status ||
    !account ||
    !accountLabel ||
    !accountValue
  )
    return;
  if (form.dataset.cloudCheckBound === 'true') return;
  form.dataset.cloudCheckBound = 'true';
  const check = options.check || checkCloudOAuthRegistration;
  const loadNative =
    options.loadNative ||
    (async () => {
      const [{ invoke }, { open }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/plugin-shell')
      ]);
      return { invoke, openBrowser: open };
    });
  /** @type {AbortController|null} */
  let active = null;

  function clearAccount() {
    account.hidden = true;
    accountLabel.textContent = '';
    accountValue.textContent = '';
  }
  function setBusy(busy) {
    provider.disabled = busy;
    client.disabled = busy;
    start.disabled = busy || !options.desktop;
    cancelButton.hidden = !busy;
    cancelButton.disabled = !busy;
  }
  function stop() {
    if (!active || active.signal.aborted) return;
    active.abort();
    cancelButton.disabled = true;
    clearAccount();
    status.textContent =
      'Ожидание отменено. Если запрос уже отправлен, сервис мог сохранить разрешение. Его отзыв в настройках аккаунта может отключить другие устройства этой регистрации.';
  }
  function initialStatus() {
    return options.desktop
      ? 'Диск не подключён.'
      : 'Проверка доступна только в настольном приложении. В браузерном примере подключения и передачи данных нет.';
  }
  function updateProviderHint() {
    yandexHint.hidden = provider.value !== 'yandex';
    googleHint.hidden = provider.value !== 'google';
  }
  status.textContent = initialStatus();
  updateProviderHint();
  setBusy(false);

  provider.addEventListener('change', () => {
    clearAccount();
    updateProviderHint();
    status.textContent = initialStatus();
  });
  client.addEventListener('input', () => {
    clearAccount();
    if (!active) status.textContent = initialStatus();
  });
  panel.addEventListener('toggle', () => {
    if (!panel.open) {
      stop();
      clearAccount();
    }
  });
  cancelButton.addEventListener('click', stop);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!options.desktop || active) return;
    clearAccount();
    const selected = provider.value;
    const clientId = client.value.trim();
    if (!validOAuthClientId(selected, clientId)) {
      status.textContent =
        'Проверьте формат Client ID для выбранного диска. Пароль, секрет приложения и код сюда вводить нельзя.';
      client.focus();
      return;
    }
    const controller = new AbortController();
    active = controller;
    setBusy(true);
    status.textContent = 'Подготавливаем проверку…';
    try {
      const native = await loadNative();
      if (controller.signal.aborted) return;
      const result = await check({
        provider: /** @type {'google'|'yandex'} */ (selected),
        clientId,
        invoke: native.invoke,
        openBrowser: native.openBrowser,
        signal: controller.signal,
        onProgress(stage) {
          if (controller.signal.aborted) return;
          if (stage === 'browser')
            status.textContent = 'Откройте страницу в системном браузере и подтвердите или отмените запрос.';
          else if (stage === 'token') status.textContent = 'Проверяем ответ авторизации…';
          else if (stage === 'identity') status.textContent = 'Проверяем, какой аккаунт выбрал сервис…';
        }
      });
      if (controller.signal.aborted) return;
      if (result.status === 'checked') {
        status.textContent =
          result.scope === 'unverified'
            ? 'Сервис ответил, но запрошенные права не удалось подтвердить. Доступ к файлам не проверялся; диск не подключён.'
            : 'Сервис ответил на проверку. Доступ к файлам не проверялся; диск не подключён и данные не передавались.';
        if (result.label) {
          accountLabel.textContent = selected === 'google' ? 'Адрес аккаунта Google' : 'Логин аккаунта Яндекса';
          accountValue.textContent = result.label.value;
          account.hidden = false;
        } else {
          status.textContent += ' Сервис не сообщил отображаемую метку аккаунта.';
        }
      } else if (result.status === 'denied') {
        status.textContent = 'Доступ отклонён в браузере. Диск не подключён.';
      } else if (result.status === 'expired') {
        status.textContent = 'Время ожидания авторизации истекло. Диск не подключён.';
      } else if (result.status === 'cancelled') {
        status.textContent = 'Проверка отменена. Сервис мог сохранить разрешение; диск не подключён.';
      } else {
        status.textContent =
          'Не удалось проверить регистрацию. Проверьте Client ID, разрешения приложения и Redirect URI; также возможно, что сервис требует дополнительные параметры. Диск не подключён.';
      }
    } catch {
      if (!controller.signal.aborted)
        status.textContent = 'Не удалось запустить проверку. Диск не подключён и данные не передавались.';
    } finally {
      if (active === controller) {
        active = null;
        setBusy(false);
      }
    }
  });
}

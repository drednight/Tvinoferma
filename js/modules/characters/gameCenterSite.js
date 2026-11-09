import { state } from '../../core/state.js';
import { attachedGcs, accountKey, resolveGameCenter } from '../launcher/gameCenters.js';
import { openOverlay } from '../marathons/overlay.js';
import { openCharacterWebLink } from '../../core/linkBrowser.js';
import { escapeHtml } from '../../core/utils.js';
// Browser-process observation is explicit, bounded and native; captured URLs never cross IPC.
// A pasted one-use URL exists only in this dialog and the navigation request.
export function gameCenterSiteUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    const allowed = ['pwonline.ru', 'vkplay.ru', 'vk.com', 'vk.ru'];
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !allowed.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))
    )
      return '';
    return u.href;
  } catch {
    return '';
  }
}
export function openGameCenterSitePilot(char) {
  let closed = false,
    attempt = null,
    countdown = null,
    unlisten = null,
    cancelRequested = false;
  const cancelWait = async () => {
    cancelRequested = true;
    clearInterval(countdown);
    const id = attempt;
    if (!id) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('gc_site_login_cancel', { requestId: id });
    } catch {
      /* never show raw IPC errors */
    }
  };
  const ov = openOverlay({
    title: `Вход через GameCenter: ${char.nick}`,
    onClose: () => {
      closed = true;
      void cancelWait();
      unlisten?.();
    }
  });
  ov.body.innerHTML = `<section class="gc-site-login-wait"><p><b>Авторизация через «Пополнить счёт» — эксперимент</b></p><p>Нажмите «Начать», затем в течение 30 секунд нажмите «Пополнить счёт» в нужном GameCenter. Платить не нужно. Ссылка откроется в профиле этого персонажа только при совпадении user_id с MyComUserUid сохранённого входа.</p><label>Привязанный GameCenter<select data-gc-site-launcher></select></label><div class="row gap"><button type="button" class="btn primary" data-gc-site-start>Начать авторизацию через «Пополнить счёт»</button><button type="button" class="btn ghost" data-gc-site-cancel disabled>Отмена ожидания</button></div><p class="muted">Наблюдаются только новые процессы известных браузеров вашего пользователя, только во время ожидания. Короткий процесс может быть пропущен. GameCenter и браузер Windows не переключаются. Совпадение ID ссылки не подтверждает итоговую сессию сайта.</p></section><details><summary>Ручной способ — если запуск браузера не обнаружен</summary><p><b>Ручная проверка</b></p><ol><li>В GameCenter выберите аккаунт этого персонажа и нажмите «Пополнить счёт». Платить ничего не нужно.</li><li>Если доступна исходная ссылка перехода, откройте её ниже в профиле персонажа. Уже использованная одноразовая ссылка может не сработать. Обычный адрес сайта не переносит авторизацию из другого браузера.</li><li>В окне сайта вручную проверьте аккаунт, затем проверьте наличие входа. Cookies этого профиля сохраняются отдельно от других персонажей.</li></ol><p class="muted">Автоматическое ожидание не гарантирует обнаружение короткого процесса браузера. Браузер Windows не подменяется, GameCenter не переключается автоматически. Ссылки и cookies не нужно присылать в чат.</p><label>Одноразовая ссылка (не сохраняется)<input class="input" type="password" autocomplete="off" spellcheck="false" data-gc-site-url></label><p class="muted">Разрешены только HTTPS-страницы Perfect World и VK/VK Play. Адрес используется только для этой попытки.</p><div class="row gap"><button type="button" class="btn" data-gc-site-open>Открыть ссылку в профиле ${escapeHtml(char.nick)}</button><button type="button" class="btn ghost" data-gc-site-home>Открыть обычный сайт</button></div></details><p><label><input type="checkbox" data-gc-site-identity> Я проверил, что на сайте открыт нужный аккаунт</label></p><button type="button" class="btn" data-gc-site-check disabled>Проверить наличие входа на сайте</button><p role="status" aria-live="polite" data-gc-site-status>Способ входа: GameCenter (эксперимент). Вход пока не проверен этой процедурой.</p>`;
  ov.foot.innerHTML = '<button type="button" class="btn" data-gc-site-close>Закрыть</button>';
  const input = ov.body.querySelector('[data-gc-site-url]');
  const status = ov.body.querySelector('[data-gc-site-status]');
  const check = ov.body.querySelector('[data-gc-site-check]');
  let busy = false;
  const launcherSelect = ov.body.querySelector('[data-gc-site-launcher]');
  const start = ov.body.querySelector('[data-gc-site-start]');
  const cancel = ov.body.querySelector('[data-gc-site-cancel]');
  const settings = state.settings?.launcher || {};
  const gcs = attachedGcs(char, settings.gameCenters || []);
  const resolved = resolveGameCenter(char, {
    gameCenters: settings.gameCenters || [],
    preferredId: settings.preferredGcId
  });
  const targets = gcs.length
    ? gcs
        .filter(gc => gc.kind !== 'astrum')
        .map(gc => ({ key: accountKey(char, gc.id), name: gc.name, saved: !!char.launch?.gcAccounts?.[gc.id] }))
    : resolved?.kind === 'gamecenter'
      ? [{ key: resolved.key, name: 'GameCenter персонажа', saved: resolved.saved }]
      : [];
  launcherSelect.innerHTML = targets
    .map(
      target =>
        `<option value="${escapeHtml(target.key)}" ${target.key === resolved?.key ? 'selected' : ''}>${escapeHtml(target.name)}${target.saved ? '' : ' — вход не запомнен'}</option>`
    )
    .join('');
  const updateStart = () => {
    start.disabled = busy || !targets.some(target => target.key === launcherSelect.value && target.saved);
  };
  launcherSelect.onchange = updateStart;
  const messages = {
    wrong_account:
      'Открыт неправильный аккаунт: ID перехода не совпадает с аккаунтом персонажа, сохранённым для выбранного GameCenter. Ссылка не открыта.',
    missing_account: 'Сначала запомните вход этого персонажа для выбранного GameCenter.',
    missing_uid:
      'В сохранённом входе нет подходящего MyComUserUid. Повторно выполните «Запомнить вход» для нужного аккаунта.',
    account_changed: 'Сохранённый вход изменился во время ожидания. Запустите проверку заново.',
    account_unavailable: 'Хранилище входов недоступно. Авторизация не запускалась.',
    timeout:
      'За 30 секунд переход не обнаружен. Короткий процесс браузера мог быть пропущен; попробуйте снова или используйте ручной способ.',
    process_unavailable:
      'Переход не получен: часть новых процессов браузера недоступна для чтения или уже завершилась. Автоматическое повышение прав не выполняется.',
    cancelled: 'Ожидание отменено.',
    busy: 'Уже запущено ожидание для другого окна. Завершите его перед новой попыткой.',
    windows_only: 'Ожидание запуска браузера доступно только в Windows.',
    open_failed: 'ID совпал, но открыть браузер персонажа не удалось. Ссылка не сохранена.'
  };
  start.onclick = async () => {
    if (busy || !targets.some(target => target.key === launcherSelect.value && target.saved)) return;
    busy = true;
    cancelRequested = false;
    updateStart();
    cancel.disabled = false;
    launcherSelect.disabled = true;
    identity.checked = false;
    check.disabled = true;
    const id = crypto.randomUUID();
    attempt = id;
    status.textContent = 'Подготовка ожидания и проверка сохранённого входа…';
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const { invoke } = await import('@tauri-apps/api/core');
      unlisten = await listen('gc-site-login-ready', event => {
        if (closed || cancelRequested || attempt !== id || event.payload !== id) return;
        const deadline = Date.now() + 30000;
        const tick = () => {
          if (!closed && attempt === id)
            status.textContent = `Ожидаем «Пополнить счёт» в выбранном GameCenter — осталось ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} с.`;
        };
        tick();
        countdown = setInterval(tick, 250);
      });
      if (closed || cancelRequested || attempt !== id) {
        if (!closed) status.textContent = 'Ожидание отменено.';
        return;
      }
      const result = await invoke('gc_site_login_wait', {
        requestId: id,
        charId: char.id,
        charNick: char.nick,
        accountKey: launcherSelect.value
      });
      clearInterval(countdown);
      if (closed || attempt !== id) return;
      if (result === 'opened') {
        status.textContent =
          'ID перехода совпал с сохранённым входом. Браузер персонажа открыт. Проверяем наличие сессии сайта…';
        try {
          const { refreshAuthFor } = await import('../sync/syncManager.js');
          await refreshAuthFor(char);
          if (!closed)
            status.textContent =
              char.isLoggedIn === true
                ? 'ID ссылки совпал; сайт подтвердил наличие входа. Аккаунт итоговой сессии сверьте в браузере персонажа.'
                : 'ID ссылки совпал. Вход пока не подтверждён: дождитесь загрузки сайта, затем повторите проверку ниже.';
        } catch {
          if (!closed)
            status.textContent = 'ID совпал, браузер открыт. После загрузки страницы проверьте вход кнопкой ниже.';
        }
      }
    } catch (error) {
      if (!closed && attempt === id)
        status.textContent =
          messages[typeof error === 'string' ? error : ''] ||
          'Не удалось выполнить авторизацию. Ссылка и технические подробности не выводятся.';
    } finally {
      clearInterval(countdown);
      unlisten?.();
      unlisten = null;
      if (attempt === id) attempt = null;
      busy = false;
      if (!closed) {
        cancel.disabled = true;
        launcherSelect.disabled = false;
        updateStart();
        check.disabled = !identity.checked;
      }
    }
  };
  cancel.onclick = () => {
    status.textContent = 'Отменяем ожидание…';
    void cancelWait();
  };
  updateStart();
  if (!targets.some(target => target.saved))
    status.textContent =
      'Нет запомненного входа GameCenter. Сначала привяжите GameCenter и выполните «Запомнить вход» для этого персонажа.';

  const navigate = async home => {
    if (busy) return;
    const url = home ? 'https://pwonline.ru/' : gameCenterSiteUrl(input.value);
    input.value = '';
    if (!url) {
      status.textContent = 'Ссылка не поддерживается. Допустимы HTTPS-страницы Perfect World и VK/VK Play.';
      return;
    }
    identity.checked = false;
    check.disabled = true;
    busy = true;
    try {
      await openCharacterWebLink(url, char);
      status.textContent = 'Окно открыто. Вручную сверьте аккаунт. Открытие страницы не подтверждает вход.';
    } catch {
      // Never display/log an IPC exception: it may contain an authorization URL.
      status.textContent =
        'Не удалось открыть профиль. Нужна настольная версия приложения. Ссылка не сохранена; повторно использованная ссылка может уже не действовать.';
    } finally {
      busy = false;
      check.disabled = !identity.checked;
    }
  };
  ov.body.querySelector('[data-gc-site-open]').onclick = () => navigate(false);
  ov.body.querySelector('[data-gc-site-home]').onclick = () => navigate(true);
  const identity = ov.body.querySelector('[data-gc-site-identity]');
  identity.onchange = () => {
    check.disabled = busy || !identity.checked;
  };
  check.onclick = async () => {
    if (busy || !identity.checked) return;
    busy = true;
    check.disabled = true;
    try {
      const { refreshAuthFor } = await import('../sync/syncManager.js');
      await refreshAuthFor(char);
      status.textContent =
        char.isLoggedIn === true
          ? 'Сайт подтвердил наличие входа. Соответствие аккаунта вы проверили вручную; автоматического сравнения личности в прототипе нет.'
          : 'Вход не подтверждён. Cookies внешнего браузера сами по себе не переносятся в профиль Твинофермы.';
    } catch {
      status.textContent = 'Проверка входа не завершилась. Повторите после закрытия окна сайта.';
    } finally {
      busy = false;
      check.disabled = !identity.checked;
    }
  };
  ov.foot.querySelector('button').onclick = () => {
    input.value = '';
    ov.close();
  };
  return ov;
}

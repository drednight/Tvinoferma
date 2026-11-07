import { openOverlay } from '../marathons/overlay.js';
import { openCharacterWebLink } from '../../core/linkBrowser.js';
import { escapeHtml } from '../../core/utils.js';
// This pilot does NOT intercept browser launches, extract launcher tokens, or pay money.
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
  const ov = openOverlay({ title: `Вход через GameCenter: ${char.nick}` });
  ov.body.innerHTML = `<p><b>Экспериментальная ручная проверка, не автоматический вход.</b></p><ol><li>В GameCenter выберите аккаунт этого персонажа и нажмите «Пополнить счёт». Платить ничего не нужно.</li><li>Если доступна исходная ссылка перехода, откройте её ниже в профиле персонажа. Уже использованная одноразовая ссылка может не сработать. Обычный адрес сайта не переносит авторизацию из другого браузера.</li><li>В окне сайта вручную проверьте аккаунт, затем проверьте наличие входа. Cookies этого профиля сохраняются отдельно от других персонажей.</li></ol><p class="muted">Перехват ссылки из GameCenter пока не реализован. Браузер Windows не подменяется, GameCenter не переключается автоматически. Ссылки и cookies не нужно присылать в чат.</p><label>Одноразовая ссылка (не сохраняется)<input class="input" type="password" autocomplete="off" spellcheck="false" data-gc-site-url></label><p class="muted">Разрешены только HTTPS-страницы Perfect World и VK/VK Play. Адрес используется только для этой попытки.</p><div class="row gap"><button type="button" class="btn" data-gc-site-open>Открыть ссылку в профиле ${escapeHtml(char.nick)}</button><button type="button" class="btn ghost" data-gc-site-home>Открыть обычный сайт</button></div><p><label><input type="checkbox" data-gc-site-identity> Я проверил, что на сайте открыт нужный аккаунт</label></p><button type="button" class="btn" data-gc-site-check disabled>Проверить наличие входа на сайте</button><p role="status" aria-live="polite" data-gc-site-status>Способ входа: GameCenter (эксперимент). Вход пока не проверен этой процедурой.</p>`;
  ov.foot.innerHTML = '<button type="button" class="btn" data-gc-site-close>Закрыть</button>';
  const input = ov.body.querySelector('[data-gc-site-url]');
  const status = ov.body.querySelector('[data-gc-site-status]');
  const check = ov.body.querySelector('[data-gc-site-check]');
  let busy = false;
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

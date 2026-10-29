// @ts-check
// Отключённое окно подтверждения аккаунта. Само по себе не запускает OAuth,
// не получает токены, не доказывает личность и не подключено к настройкам.
// Метка — личные данные: не журналировать аргументы, DOM или исходные ошибки.
import { object } from '../exportSchema.js';
import { copyOAuthAccountLabel } from '../providers/oauthAccountLabel.js';
import { validOAuthClientId } from '../providers/oauthCommon.js';

const ERROR = 'Не удалось подтвердить выбранную учётную запись';
/** @type {WeakMap<Document, HTMLDialogElement>} */
const activeDialogs = new WeakMap();
let nextId = 0;

function failed() {
  return new Error(ERROR);
}

/**
 * Независимый callback для будущей модели подключения. В нормальном приложении
 * пока НЕ вызывается; example=true используется только с вымышленной меткой.
 * Важны доверенный документ и вызывающий код: чужой JS в том же окне может
 * подменить интерфейс или события. Кнопка не является криптографическим
 * доказательством, что человек действительно сравнил аккаунты.
 *
 * Требует нативный showModal и :modal, без небезопасного немодального fallback.
 * Отмена signal отклоняет promise и убирает окно; явная отмена возвращает false.
 * Одно окно на документ, даже при нескольких экземплярах factory. Метка
 * показывается целиком как текст; после закрытия удаляется из DOM. Строки JS
 * нельзя гарантированно стереть из памяти.
 *
 * @param {{example?:boolean}} [options]
 * @returns {(args:{provider:'google'|'yandex',clientId:string,label:{kind:string,value:string}|null,signal:AbortSignal})=>Promise<boolean>}
 */
export function createCloudAccountConfirmation(options = {}) {
  let settings;
  try {
    settings = object(options, [], ['example']);
    if (settings.example !== undefined && typeof settings.example !== 'boolean') throw failed();
  } catch {
    throw failed();
  }
  const example = settings.example === true;

  return async function confirmCloudAccount(args) {
    let request;
    let label;
    let doc;
    let signal;
    let signalPrototype;
    let abortedGetter;
    try {
      request = object(args, ['provider', 'clientId', 'label', 'signal']);
      if (!['google', 'yandex'].includes(request.provider) || !validOAuthClientId(request.provider, request.clientId))
        throw failed();
      label = copyOAuthAccountLabel(request.provider, request.label);
      if (label === null) throw failed();
      doc = globalThis.document;
      signal = request.signal;
      signalPrototype = globalThis.AbortSignal?.prototype;
      abortedGetter = Object.getOwnPropertyDescriptor(signalPrototype, 'aborted')?.get;
      if (
        !doc?.body ||
        !doc.documentElement ||
        typeof doc.defaultView?.MutationObserver !== 'function' ||
        typeof abortedGetter !== 'function' ||
        typeof signalPrototype?.addEventListener !== 'function' ||
        typeof signalPrototype?.removeEventListener !== 'function' ||
        abortedGetter.call(signal) ||
        activeDialogs.has(doc)
      )
        throw failed();
    } catch {
      throw failed();
    }

    return new Promise((resolve, reject) => {
      /** @type {HTMLDialogElement | null} */
      let dialog = null;
      /** @type {HTMLElement | null} */
      let valueNode = null;
      /** @type {HTMLElement | null} */
      let accountBlock = null;
      /** @type {HTMLElement | null} */
      let contentBody = null;
      /** @type {HTMLElement | null} */
      let visibilityHint = null;
      let expectedContent = '';
      /** @type {HTMLInputElement | null} */
      let acknowledgement = null;
      /** @type {HTMLButtonElement | null} */
      let cancelButton = null;
      /** @type {HTMLButtonElement | null} */
      let confirmButton = null;
      /** @type {MutationObserver | null} */
      let observer = null;
      let listening = false;
      let settled = false;

      const end = outcome => {
        if (settled) return;
        settled = true;
        // Каждый шаг очистки выполняется даже при ошибке другого шага. Детали
        // исключения могут содержать личные данные и никогда не возвращаются.
        const cleanup = [
          () => observer?.disconnect(),
          () => {
            if (listening) signalPrototype.removeEventListener.call(signal, 'abort', onAbort);
          },
          () => acknowledgement?.removeEventListener('change', onChange),
          () => cancelButton?.removeEventListener('click', onCancel),
          () => confirmButton?.removeEventListener('click', onConfirm),
          () => dialog?.removeEventListener('cancel', onDialogCancel),
          () => dialog?.removeEventListener('close', onDialogClose),
          () => {
            if (dialog?.open) dialog.close();
          },
          () => {
            if (valueNode) valueNode.textContent = '';
          },
          () => dialog?.remove()
        ];
        for (const action of cleanup) {
          try {
            action();
          } catch {
            outcome = 'error';
          }
        }
        expectedContent = '';
        // Если окно не удалось убрать, не открываем второе поверх него.
        if (dialog?.isConnected) outcome = 'error';
        else if (activeDialogs.get(doc) === dialog) activeDialogs.delete(doc);
        if (outcome === 'error') reject(failed());
        else resolve(outcome === true);
      };
      const isIntact = () =>
        !!dialog &&
        dialog.parentNode === doc.body &&
        dialog.isConnected &&
        dialog.textContent === expectedContent &&
        !!contentBody &&
        dialog.contains(contentBody) &&
        !!accountBlock &&
        contentBody.contains(accountBlock) &&
        !!valueNode &&
        accountBlock.contains(valueNode) &&
        valueNode.getAttribute('dir') === 'ltr' &&
        valueNode.textContent === label.value &&
        valueNode.children.length === 0 &&
        !!visibilityHint &&
        dialog.contains(visibilityHint) &&
        !!acknowledgement &&
        contentBody.contains(acknowledgement) &&
        !!cancelButton &&
        dialog.contains(cancelButton) &&
        !!confirmButton &&
        dialog.contains(confirmButton);
      // Проверяем, что метку не скрыли стилем/атрибутом и не обрезали по ширине.
      // Это защита от случайно повреждённого UI, а не от чужого JS в том же окне.
      const isRenderable = () => {
        if (!valueNode || !dialog || !contentBody || !doc.defaultView) return false;
        let node = valueNode;
        while (node) {
          const style = doc.defaultView.getComputedStyle(node);
          if (
            node.hidden ||
            node.getAttribute('aria-hidden') === 'true' ||
            style.display === 'none' ||
            style.visibility !== 'visible' ||
            style.contentVisibility === 'hidden' ||
            Number(style.opacity) <= 0.1
          )
            return false;
          if (node === dialog) break;
          node = node.parentElement;
        }
        if (node !== dialog) return false;
        const style = doc.defaultView.getComputedStyle(valueNode);
        const bounds = valueNode.getBoundingClientRect();
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          style.textOverflow !== 'ellipsis' &&
          style.whiteSpace !== 'nowrap' &&
          (valueNode.clientWidth === 0 || valueNode.scrollWidth <= valueNode.clientWidth + 1) &&
          (valueNode.clientHeight === 0 || valueNode.scrollHeight <= valueNode.clientHeight + 1)
        );
      };
      const labelInViewport = () => {
        if (!valueNode || !contentBody || !doc.defaultView) return false;
        const labelBounds = valueNode.getBoundingClientRect();
        const bodyBounds = contentBody.getBoundingClientRect();
        return (
          labelBounds.right > Math.max(bodyBounds.left, 0) &&
          labelBounds.left < Math.min(bodyBounds.right, doc.defaultView.innerWidth) &&
          labelBounds.bottom > Math.max(bodyBounds.top, 0) &&
          labelBounds.top < Math.min(bodyBounds.bottom, doc.defaultView.innerHeight)
        );
      };
      const isModal = () => !!dialog?.open && dialog.matches(':modal');
      const onAbort = () => end('error');
      const onCancel = () => end(false);
      const onDialogCancel = event => {
        event.preventDefault();
        end(false);
      };
      const onDialogClose = () => end(false);
      const onChange = () => {
        try {
          if (!isIntact() || !isRenderable() || !isModal() || abortedGetter.call(signal)) return end('error');
          confirmButton.disabled = !acknowledgement.checked;
        } catch {
          end('error');
        }
      };
      const onConfirm = () => {
        try {
          if (!isIntact() || !isRenderable() || !isModal() || abortedGetter.call(signal)) return end('error');
          if (!acknowledgement.checked || acknowledgement.disabled || confirmButton.disabled) return;
          if (!labelInViewport()) {
            visibilityHint.hidden = false;
            return;
          }
          end(true);
        } catch {
          end('error');
        }
      };

      try {
        dialog = doc.createElement('dialog');
        if (typeof dialog.showModal !== 'function' || typeof dialog.close !== 'function') throw failed();
        dialog.className = 'tf-cloud-account-dialog';
        dialog.setAttribute('aria-modal', 'true');
        const id = `tf-cloud-account-${++nextId}`;
        dialog.setAttribute('aria-labelledby', `${id}-title`);
        dialog.setAttribute('aria-describedby', `${id}-instruction ${id}-account`);

        const header = doc.createElement('header');
        header.className = 'tf-cloud-account-header';
        const kicker = doc.createElement('span');
        kicker.className = 'tf-cloud-account-kicker';
        kicker.textContent = example ? 'ВЫМЫШЛЕННЫЙ ПРИМЕР · НЕ ВХОД' : 'ПОДТВЕРЖДЕНИЕ АККАУНТА';
        const title = doc.createElement('h2');
        title.id = `${id}-title`;
        title.textContent =
          request.provider === 'google' ? 'Проверьте аккаунт Google Диска' : 'Проверьте аккаунт Яндекс Диска';
        header.append(kicker, title);

        contentBody = doc.createElement('div');
        contentBody.className = 'tf-cloud-account-body';
        contentBody.tabIndex = 0;
        const instruction = doc.createElement('p');
        instruction.id = `${id}-instruction`;
        instruction.textContent = example
          ? 'Это вымышленный пример: браузер не открывался, никакой аккаунт не подключится. В рабочей версии сравните показанную метку с аккаунтом, который выбрали в системном браузере.'
          : 'Сравните показанную метку с аккаунтом, который вы выбрали в системном браузере. Если она отличается или вы не уверены, нажмите «Отмена».';
        accountBlock = doc.createElement('div');
        accountBlock.id = `${id}-account`;
        accountBlock.className = 'tf-cloud-account-value';
        const caption = doc.createElement('span');
        caption.textContent = request.provider === 'google' ? 'Адрес аккаунта Google' : 'Логин аккаунта Яндекса';
        valueNode = doc.createElement('bdi');
        valueNode.setAttribute('dir', 'ltr');
        valueNode.setAttribute('data-cloud-account-label', '');
        valueNode.textContent = label.value;
        accountBlock.append(caption, valueNode);
        const warning = doc.createElement('p');
        warning.className = 'tf-cloud-account-warning';
        warning.textContent =
          'Вводить пароль от диска в Твиноферму не нужно. Метка сама по себе не защищает от подмены интерфейса.';
        const checkLabel = doc.createElement('label');
        checkLabel.className = 'tf-cloud-account-ack';
        acknowledgement = doc.createElement('input');
        acknowledgement.type = 'checkbox';
        acknowledgement.setAttribute('data-cloud-account-ack', '');
        const checkText = doc.createElement('span');
        checkText.textContent = example
          ? 'В примере я подтвердил бы, что сверил аккаунт с браузером.'
          : 'Я сверил аккаунт с выбранным в системном браузере.';
        checkLabel.append(acknowledgement, checkText);
        contentBody.append(instruction, accountBlock, warning, checkLabel);

        const footer = doc.createElement('footer');
        footer.className = 'tf-cloud-account-footer';
        cancelButton = doc.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn ghost';
        cancelButton.setAttribute('data-cloud-account-cancel', '');
        cancelButton.setAttribute('autofocus', '');
        cancelButton.textContent = 'Отмена';
        confirmButton = doc.createElement('button');
        confirmButton.type = 'button';
        confirmButton.className = 'btn primary';
        confirmButton.setAttribute('data-cloud-account-confirm', '');
        confirmButton.textContent = example ? 'Подтвердить в примере' : 'Подтвердить аккаунт';
        confirmButton.disabled = true;
        visibilityHint = doc.createElement('p');
        visibilityHint.className = 'tf-cloud-account-visibility-hint';
        visibilityHint.setAttribute('role', 'status');
        visibilityHint.textContent = 'Прокрутите окно так, чтобы метка аккаунта была видна, и повторите подтверждение.';
        visibilityHint.hidden = true;
        footer.append(visibilityHint, cancelButton, confirmButton);
        dialog.append(header, contentBody, footer);
        expectedContent = dialog.textContent;

        acknowledgement.addEventListener('change', onChange);
        cancelButton.addEventListener('click', onCancel);
        confirmButton.addEventListener('click', onConfirm);
        dialog.addEventListener('cancel', onDialogCancel);
        dialog.addEventListener('close', onDialogClose);
        activeDialogs.set(doc, dialog);
        signalPrototype.addEventListener.call(signal, 'abort', onAbort, { once: true });
        listening = true;
        if (abortedGetter.call(signal)) return end('error');
        doc.body.append(dialog);
        observer = new doc.defaultView.MutationObserver(() => {
          try {
            if (!isIntact() || !isRenderable()) end('error');
          } catch {
            end('error');
          }
        });
        observer.observe(doc.documentElement, { childList: true });
        observer.observe(doc.body, { childList: true });
        observer.observe(dialog, { childList: true, subtree: true, characterData: true, attributes: true });
        dialog.showModal();
        if (settled) return;
        if (!isIntact() || !isRenderable() || !isModal() || abortedGetter.call(signal)) return end('error');
        cancelButton.focus({ preventScroll: true });
      } catch {
        end('error');
      }
    });
  };
}

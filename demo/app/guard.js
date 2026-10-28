/* Изоляция снимка. Подключается обычным скриптом до любых модулей приложения. */
(() => {
  function memoryStorage() {
    const values = new Map();
    const api = {
      getItem(key) {
        return values.has(String(key)) ? values.get(String(key)) : null;
      },
      setItem(key, value) {
        values.set(String(key), String(value));
      },
      removeItem(key) {
        values.delete(String(key));
      },
      clear() {
        values.clear();
      },
      key(index) {
        return [...values.keys()][index] ?? null;
      }
    };
    return new Proxy(api, {
      get(target, key) {
        if (key === 'length') return values.size;
        if (Reflect.has(target, key)) return Reflect.get(target, key);
        return typeof key === 'string' ? values.get(key) : undefined;
      },
      set(target, key, value) {
        if (typeof key !== 'string') return false;
        values.set(key, String(value));
        return true;
      },
      deleteProperty(target, key) {
        values.delete(String(key));
        return true;
      },
      ownKeys() {
        return [...values.keys()];
      },
      getOwnPropertyDescriptor(target, key) {
        return values.has(key)
          ? { configurable: true, enumerable: true, writable: true, value: values.get(key) }
          : Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
  }

  const notify = message => {
    if (window.parent !== window) window.parent.postMessage({ type: 'tf-demo:notice', message }, '*');
    else {
      const box = document.getElementById('demo-guard-message');
      if (box) box.textContent = message;
    }
  };

  try {
    // Не используем даже отдельный ключ в настоящем localStorage: приложения на одном
    // домене могут иметь свои данные. Всё остаётся в памяти этой вкладки iframe.
    Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: false });
    Object.defineProperty(window, 'sessionStorage', { value: memoryStorage(), configurable: false });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: undefined, configurable: false });
    Object.defineProperty(window, '__TAURI__', { value: undefined, configurable: false });
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: false });
    Object.defineProperty(document, 'cookie', { get: () => '', set: () => {}, configurable: false });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          notify('В демо буфер обмена не изменяется.');
          throw new Error('Буфер обмена в демо отключён.');
        }
      },
      configurable: false
    });
    window.fetch = async () => {
      throw new Error('В демо обращения к сети и отправка данных отключены.');
    };
    window.open = () => {
      notify('В демо внешние сайты не открываются.');
      return null;
    };
    document.execCommand = () => {
      notify('В демо буфер обмена не изменяется.');
      return false;
    };
    // Разрешаем события форм для локальных обработчиков, но запрещаем любые переходы.
    // form-action 'none' в CSP остаётся второй линией защиты, в том числе от form.submit().
    document.addEventListener('submit', event => event.preventDefault(), true);
    document.addEventListener(
      'drop',
      event => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        notify('Импорт файлов в демо отключён.');
      },
      true
    );
    document.addEventListener(
      'paste',
      event => {
        if (![...(event.clipboardData?.items || [])].some(item => item.kind === 'file')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        notify('Вставка файлов в демо отключена.');
      },
      true
    );
    document.addEventListener(
      'click',
      event => {
        const element = event.target.closest?.('a[href], input[type="file"], label[for]');
        if (!element) return;
        const fileInput =
          element.matches('input[type="file"]') ||
          (element.matches('label[for]') && document.getElementById(element.htmlFor)?.type === 'file');
        const href = element.getAttribute('href') || '';
        const isDemoBack = element.matches('[data-demo-back]') && href === 'demo/today/index.html';
        const external = element.matches('a[href]') && !href.startsWith('#') && !isDemoBack;
        if (fileInput || external || element.hasAttribute('download')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          notify(fileInput ? 'Импорт файлов в демо отключён.' : 'Переходы и сохранение файлов в демо отключены.');
        }
      },
      true
    );
    if (window.parent !== window) document.documentElement.classList.add('is-demo-embedded');
    window.__DEMO_GUARD_READY__ = true;
  } catch (error) {
    // Закрываем запуск при невозможности изолировать хранилище, а не запускаем
    // оригинал в реальном окружении. bootstrap.js проверит этот флаг до импорта.
    window.__DEMO_GUARD_READY__ = false;
    window.__DEMO_GUARD_ERROR__ = String(error?.message || error);
    console.error('Не удалось изолировать демо:', error);
  }
})();

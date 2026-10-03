// Общий слой для скриптов разбора страниц. Выполняется перед каждым скриптом.
// Rust (parsers.rs → with_common) подставляет сюда selectors.json вместо маркера в строке ниже.
// Селекторы, тексты и регулярные выражения живут только в selectors.json: имя → список вариантов
// [основной, запасной, ...]. Если сайт изменит вёрстку, правится JSON, а не код скриптов.
window.__TF_SELECTORS = {} /*TF_SELECTORS*/;
window.__TF = (function () {
  var cfg = window.__TF_SELECTORS || {};

  function entry(kind, name) {
    var v = cfg[kind] && cfg[kind][name];
    if (!Array.isArray(v) || !v.length) throw new Error('config_missing:' + name);
    return v;
  }
  // Первый вариант из списка, который что-то нашёл. Неверный селектор не ломает остальные.
  function firstOf(list, fn) {
    for (var i = 0; i < list.length; i++) {
      try { var r = fn(list[i]); if (r) return r; } catch (e) { /* пробуем запасной */ }
    }
    return null;
  }

  return {
    version: cfg.version || 0,
    /** Первый найденный элемент: основной селектор, затем запасные. */
    q: function (name, root) {
      return firstOf(entry('selectors', name), function (s) { return (root || document).querySelector(s); });
    },
    /** Все элементы по первому селектору, который что-то нашёл (иначе пустой массив). */
    qa: function (name, root) {
      return firstOf(entry('selectors', name), function (s) {
        var list = (root || document).querySelectorAll(s);
        return list.length ? Array.prototype.slice.call(list) : null;
      }) || [];
    },
    /** Содержит ли текст хотя бы одну фразу из перечисленных списков. */
    has: function (text, names) {
      text = String(text == null ? '' : text);
      return [].concat(names).some(function (n) {
        return entry('texts', n).some(function (p) { return text.indexOf(p) !== -1; });
      });
    },
    /** Первое совпадение среди регулярных выражений списка (основное, затем запасные). */
    match: function (name, text) {
      return firstOf(entry('regex', name), function (src) { return String(text).match(new RegExp(src)); });
    },
    /** Сайт показывает «Проверку безопасности» или страница ещё грузится. */
    isChallenge: function () {
      return document.readyState === 'loading' ||
        this.has(document.title || '', 'common.challengeTitle') ||
        !!this.q('common.challengeScript');
    }
  };
})();

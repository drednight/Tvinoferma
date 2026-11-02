import { createPublicNewsReader } from './publicNewsReader.js';
import { newsArticles, articleCodes } from './promoNewsParser.js';
export const DISCOVERY_KEY = 'tf_promo_discovery_v1';
const day = ms =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(ms);
const empty = () => ({
  version: 1,
  codes: [],
  articles: {},
  lastCompleteAt: 0,
  lastAttemptAt: 0,
  status: 'idle',
  durationMs: 0,
  checked: 0,
  total: 0,
  errors: []
});
export function createPromoDiscovery({
  read,
  storage = globalThis.localStorage,
  now = Date.now,
  budgetMs = 60000,
  onChange = () => {}
}) {
  let flight = null;
  let disposed = false;
  let cache = empty();
  try {
    const old = JSON.parse(storage.getItem(DISCOVERY_KEY) || 'null');
    if (old?.version === 1 && Array.isArray(old.codes) && old.articles && typeof old.articles === 'object')
      cache = { ...empty(), ...old, codes: old.codes.filter(c => /^[A-Z0-9_-]{4,40}$/.test(c?.code)).slice(0, 200) };
  } catch {}
  cache.hiddenCodes = Array.isArray(cache.hiddenCodes)
    ? cache.hiddenCodes.filter(c => typeof c === 'string' && /^[A-Z0-9_-]{4,40}$/.test(c)).slice(-5000)
    : [];
  if (cache.metadataVersion !== 2) {
    cache.articles = {};
    cache.lastCompleteAt = 0;
    cache.lastAttemptAt = 0;
    cache.metadataVersion = 2;
  }
  if (cache.status === 'checking') cache.status = 'partial';
  const publish = () => {
    if (disposed) return;
    try {
      storage.setItem(DISCOVERY_KEY, JSON.stringify(cache));
    } catch {}
    onChange(snapshot());
  };
  const snapshot = () => structuredClone(cache);
  async function scan(force) {
    if (disposed) return empty();
    const started = now();
    if (!force && cache.lastCompleteAt <= started && cache.lastCompleteAt && day(cache.lastCompleteAt) === day(started))
      return snapshot();
    if (!force && started - cache.lastAttemptAt >= 0 && started - cache.lastAttemptAt < 600000 && cache.lastAttemptAt)
      return snapshot();
    cache.lastAttemptAt = started;
    cache.status = 'checking';
    cache.errors = [];
    cache.checked = 0;
    cache.total = 0;
    publish();
    let failed = false;
    const failure = error => {
      failed = true;
      const code = typeof error === 'string' ? error : error?.message;
      const safe =
        /^news_(?:network|timeout|http(?:_\d{3})?|size|body|client|content_type|challenge|markup|budget)$/.test(
          code || ''
        )
          ? code
          : 'news_network';
      if (!cache.errors.includes(safe) && cache.errors.length < 10) cache.errors.push(safe);
    };
    const ids = new Set();
    await Promise.all(
      [1, 2].map(async page => {
        try {
          const r = await read({ page, article: null });
          if (r?.status !== 200) throw Error(`news_http_${Number.isInteger(r?.status) ? r.status : 0}`);
          newsArticles(r.html).forEach(id => ids.add(id));
        } catch (error) {
          failure(error);
        }
      })
    );
    const list = [...ids].slice(0, 80);
    cache.total = list.length;
    if (ids.size > 80) failed = true;
    publish();
    let cursor = 0;
    async function worker() {
      while (cursor < list.length) {
        if (disposed || now() - started >= budgetMs) {
          failure(Error('news_budget'));
          return;
        }
        const id = list[cursor++];
        try {
          // Same-day successful articles are reusable after a partial scan/restart.
          if (
            !force &&
            cache.articles[id] &&
            cache.articles[id] <= started &&
            day(cache.articles[id]) === day(started)
          ) {
            cache.checked++;
            continue;
          }
          const r = await read({ page: null, article: id });
          if (r?.status !== 200) throw Error(`news_http_${Number.isInteger(r?.status) ? r.status : 0}`);
          if (disposed) return;
          const rows = articleCodes(r.html, id);
          for (const row of rows) {
            const existing = cache.codes.find(c => c.code === row.code);
            if (existing) Object.assign(existing, row, { lastSeenAt: now() });
            else cache.codes.push({ ...row, firstSeenAt: now(), lastSeenAt: now() });
          }
          cache.articles[id] = now();
          cache.checked++;
        } catch (error) {
          failure(error);
        }
        publish();
      }
    }
    await Promise.all([worker(), worker()]);
    if (disposed) return empty();
    cache.codes = cache.codes.sort((a, b) => b.firstSeenAt - a.firstSeenAt).slice(0, 200);
    cache.articles = Object.fromEntries(
      Object.entries(cache.articles)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 160)
    );
    cache.status = failed ? 'partial' : 'checked';
    if (!failed) cache.lastCompleteAt = now();
    cache.durationMs = Math.max(0, now() - started);
    publish();
    return snapshot();
  }
  return {
    dispose() {
      disposed = true;
      cache = empty();
    },
    snapshot,
    restoreHidden() {
      cache.hiddenCodes = [];
      publish();
    },
    setHidden(code, hidden = true) {
      if (!/^[A-Z0-9_-]{4,40}$/.test(code)) return;
      cache.hiddenCodes = Array.isArray(cache.hiddenCodes) ? cache.hiddenCodes : [];
      cache.hiddenCodes = cache.hiddenCodes.filter(value => value !== code);
      if (hidden) cache.hiddenCodes.push(code);
      cache.hiddenCodes = cache.hiddenCodes.slice(-5000);
      publish();
    },
    check({ force = false } = {}) {
      if (flight) return flight;
      flight = scan(force).finally(() => {
        flight = null;
      });
      return flight;
    }
  };
}
let service;
if (typeof window !== 'undefined')
  window.addEventListener('tf-factory-reset-started', () => {
    service?.dispose();
    service = null;
  });
export function promoDiscovery() {
  if (!service) {
    let reader;
    service = createPromoDiscovery({
      read: async args => {
        if (!window.__TAURI_INTERNALS__) throw Error('desktop_only');
        const { invoke } = await import('@tauri-apps/api/core');
        reader ||= createPublicNewsReader(invoke);
        return reader(args);
      },
      onChange: () => window.dispatchEvent(new CustomEvent('tf-promo-news-changed'))
    });
  }
  return service;
}
export function discoveredPromos() {
  const cache = promoDiscovery().snapshot();
  return cache.codes.filter(c => !cache.hiddenCodes?.includes(c.code));
}
export function promoCoverage(codes, characters, log) {
  return codes.map(code => {
    const record = log.find(r => r.code?.toUpperCase() === code.code);
    const entered = characters.filter(c => record?.entered?.[c.id]).length;
    return { ...code, entered, remaining: characters.length - entered };
  });
}

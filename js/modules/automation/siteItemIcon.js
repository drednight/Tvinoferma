// Only an image URL read from the actual website item. No name→icon guesses,
// arbitrary remote hosts, query tokens, referrers or executable image schemes.
import { escapeHtml } from '../../core/utils.js';
export function siteItemImage(value) {
  try {
    const url = new URL(String(value).startsWith('//') ? 'https:' + value : value);
    return url.protocol === 'https:' &&
      ['pwonline.ru', 'www.pwonline.ru', 'cdn.pwonline.ru'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
      ? url.href
      : '';
  } catch {
    return '';
  }
}
export function siteItemIconHtml(image) {
  const url = siteItemImage(image);
  return url
    ? `<span class="site-item-icon"><img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
    : '<span class="site-item-icon" aria-hidden="true">🎁</span>';
}

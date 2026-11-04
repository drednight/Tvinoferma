import { localItemIcon } from './localItemIcons.js';
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
export function siteItemIconHtml(image, name = '') {
  const local = localItemIcon(name);
  const url = local || siteItemImage(image);
  // These site previews are 120×80 frames with a centred 32×32 item icon.
  // Other images (including chest artwork) must retain their original fit.
  const framed =
    !local && url && /\/img\/promo_items\/item_\d+\.png$/i.test(new URL(url).pathname) && !/сундук/i.test(name);
  return url
    ? `<span class="site-item-icon${framed ? ' site-item-icon--framed' : ''}"><img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer"></span>`
    : '<span class="site-item-icon" aria-hidden="true">🎁</span>';
}

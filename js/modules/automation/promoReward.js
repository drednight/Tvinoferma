// Match only a trailing quantity, never category suffixes such as «(доспех)».
import { localItemIcon } from './localItemIcons.js';
import { escapeHtml } from '../../core/utils.js';

export function promoRewardName(text) {
  return String(text ?? '')
    .trim()
    .replace(/\s*\(\s*\d[\d\s.,]*\s*(?:шт\.?|штук[аи]?|ед\.?)\s*\)\s*$/iu, '')
    .replace(/\s*[×xх]\s*\d[\d\s.,]*(?:\s*(?:шт\.?|штук[аи]?|ед\.?))?\s*$/iu, '')
    .trim();
}
export function promoRewardHtml(text, bound = false, itemName = text) {
  const icon = localItemIcon(itemName);
  return `<li class="promo-reward-row${icon ? ' promo-reward-row--icon' : ''}">${icon ? `<img class="promo-reward-icon" src="${escapeHtml(icon)}" width="18" height="18" alt="" aria-hidden="true" decoding="async">` : ''}<span>${escapeHtml(text)}${bound ? ' <span class="promo-muted">(привязанный)</span>' : ''}</span></li>`;
}

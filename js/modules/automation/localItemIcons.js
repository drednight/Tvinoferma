// Exact user-supplied artwork, not heuristic matching. Unknown items retain site images.
// One entry per artwork file shipped in public/assets/icons/items.
const files = {
  'Великий метеорит': 'great-meteorite',
  'Вино «Медная печать»': 'copper-seal-wine',
  'Волшебная кукла': 'magic-doll',
  'Дар из прошлого': 'gift-from-past',
  'Запечатанная грамота Лиги': 'sealed-league-charter',
  'Звонкий колокольчик': 'ringing-bell',
  'Золотой камень жребия': 'golden-lot-stone',
  'Камень божества': 'divinity-stone',
  'Камень Инь-ян': 'yin-yang-stone',
  'Карта божества': 'divinity-map',
  'Карта хорошего человека': 'good-person-card',
  'Коробочка с картой S': 's-card-box',
  'Королевские особые пирожки': 'royal-pies',
  'Королевское особое печенье': 'royal-cookie',
  'Кровь черного дракона': 'black-dragon-blood',
  'Купон «Гнев Джонса»': 'jones-blessing',
  'Купон на поздравление': 'congratulation-coupon',
  Метеорит: 'meteorite',
  'Набор «Самоцветы грез»': 'dream-gems',
  'Набор рун (8-го ур.)': 'rune-set-8',
  'Небесная пилюля 1-го уровня': 'heavenly-pill-1',
  'Облачная пыль': 'cloud-dust',
  'Порошок духов': 'spirit-powder',
  'Приказ Феникса': 'phoenix-order',
  'Самоцвет грез (доспех)': 'dream-gem-armor',
  'Самоцвет грез (оружие)': 'dream-gem-weapon',
  'Самоцвет грез (реликвия)': 'dream-gem-relic',
  'Серебряный камень жребия': 'silver-lot-stone',
  'Солдатское жалование': 'soldier-pay',
  'Сущность карты': 'card-essence',
  'Тайная пилюля: Покой': 'secret-pill-tranquility',
  'Талон на платиновый амулет': 'platinum-charm-ticket',
  'Талон на платиновый идол': 'platinum-idol-ticket',
  'Томик стихов: Безупречность': 'poems-perfection',
  'Томик стихов: Бесстрашие': 'poems-fearlessness',
  'Томик стихов: Неуязвимость': 'poems-invulnerability',
  'Экстракт жидкого золота': 'liquid-gold-extract'
};
// The site draws the same picture for a box and for the matching ticket: the
// supplied box uploads are pixel-identical to the ticket artwork, so the two
// items keep separate names but share one file instead of duplicating it.
const shared = {
  'Шкатулка с платиновым амулетом': 'platinum-charm-ticket',
  'Шкатулка с платиновым идолом': 'platinum-idol-ticket'
};
// Other wordings the site uses for the very same artwork.
const wordings = {
  'Набор рун (8-й уровень)': 'rune-set-8',
  'Тайная пилюля - Покой': 'secret-pill-tranquility',
  'Томик стихов - Безупречность': 'poems-perfection',
  'Томик стихов - Бесстрашие': 'poems-fearlessness',
  'Томик стихов - Неуязвимость': 'poems-invulnerability'
};
const normalize = value =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[–—−]/g, '-')
    .replace(/[«»“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const icons = new Map(
  [...Object.entries(files), ...Object.entries(shared), ...Object.entries(wordings)].map(([name, key]) => [
    normalize(name),
    key
  ])
);
export function localItemIcon(name) {
  const exact = normalize(name);
  // Strip presentation-only quantity/binding suffixes; never strip categories or levels.
  const item = exact
    .replace(/\s*\((?:привязан(?:ный|ная|ное)?|персональн(?:ый|ая|ое)|непередаваемый)\)\s*[.;,]?$/iu, '')
    .replace(/\s*\(\s*(?:[×xх]\s*)?\d[\d\s.,]*(?:\s*(?:шт\.?|штук[аи]?|ед\.?))?\s*\)\s*[.;,]?$/iu, '')
    .replace(/\s*(?:[×xх:]|[-]\s*(?=\d))\s*\d[\d\s.,]*(?:\s*(?:шт\.?|штук[аи]?|ед\.?))?\s*[.;,]?$/iu, '')
    .trim();
  const key = icons.get(exact) || icons.get(item);
  return key ? `${import.meta.env.BASE_URL}assets/icons/items/${key}.webp` : '';
}
// Items the site draws with a local icon: one name per artwork plus the
// separate items that share an artwork.
export const localItemNames = [...Object.keys(files), ...Object.keys(shared)];
// Artwork files behind those items; two items may share one file.
export const localItemIcons = [...new Set([...Object.values(files), ...Object.values(shared)])];
// Alternative wordings of the same artwork.
export const localItemWordings = Object.keys(wordings);

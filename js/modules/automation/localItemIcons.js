// Exact user-supplied artwork, not heuristic matching. Unknown items retain site images.
const files = {
  'Облачная пыль': 'cloud-dust',
  'Великий метеорит': 'great-meteorite',
  'Вино «Медная печать»': 'copper-seal-wine',
  'Волшебная кукла': 'magic-doll',
  'Дар из прошлого': 'gift-from-past',
  'Звонкий колокольчик': 'ringing-bell',
  'Камень божества': 'divinity-stone',
  'Камень Инь-ян': 'yin-yang-stone',
  'Карта хорошего человека': 'good-person-card',
  'Коробочка с картой S': 's-card-box',
  'Королевские особые пирожки': 'royal-pies',
  'Королевское особое печенье': 'royal-cookie',
  'Кровь черного дракона': 'black-dragon-blood',
  'Купон «Гнев Джонса»': 'jones-blessing',
  'Купон на поздравление': 'congratulation-coupon',
  Метеорит: 'meteorite',
  'Набор «Самоцветы грез»': 'dream-gems',
  'Небесная пилюля 1-го уровня': 'heavenly-pill-1',
  'Золотой камень жребия': 'golden-lot-stone',
  'Порошок духов': 'spirit-powder',
  'Приказ феникса': 'phoenix-order',
  'Самоцвет грез (доспех)': 'dream-gem-armor',
  'Самоцвет грез (оружие)': 'dream-gem-weapon',
  'Самоцвет грез (реликвия)': 'dream-gem-relic',
  'Серебряный камень жребия': 'silver-lot-stone',
  'Солдатское жалование': 'soldier-pay',
  'Сущность карты': 'card-essence',
  'Тайная пилюля - Покой': 'secret-pill-tranquility',
  'Талон на платиновый амулет': 'platinum-charm-ticket',
  'Талон на платиновый идол': 'platinum-idol-ticket',
  'Томик стихов - Безупречность': 'poems-perfection',
  'Томик стихов - Бесстрашие': 'poems-fearlessness',
  'Томик стихов - Неуязвимость': 'poems-invulnerability',
  'Экстракт жидкого золота': 'liquid-gold-extract'
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
const icons = new Map(Object.entries(files).map(([name, key]) => [normalize(name), key]));
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
export const localItemNames = Object.keys(files);

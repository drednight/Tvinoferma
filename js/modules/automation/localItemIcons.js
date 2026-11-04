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
  'Небесная пилюля 1-го уровня': 'heavenly-pill-1'
};
const normalize = value =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const icons = new Map(Object.entries(files).map(([name, key]) => [normalize(name), key]));
export function localItemIcon(name) {
  const key = icons.get(normalize(name));
  return key ? `${import.meta.env.BASE_URL}assets/icons/items/${key}.webp` : '';
}
export const localItemNames = Object.keys(files);

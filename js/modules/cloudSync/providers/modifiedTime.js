// @ts-check
// Метаданные времени файла от облачного сервиса предназначены только для показа.
// Они не подтверждают содержимое, происхождение, актуальность или порядок версий.
// Некорректное/неоднозначное значение никогда не показываем как настоящую дату.

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Консервативное подмножество RFC 3339 с явно указанным смещением. Возвращает UTC с
 * миллисекундами либо null. Не использует локальный часовой пояс и не вызывает toString
 * на непроверенных объектах. Значение -00:00 означает неизвестное смещение, не UTC.
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseCloudModifiedTime(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = RFC3339.exec(value);
  if (!match || match[8] === '-00:00') return null;
  const [year, month, day, hours, minutes, seconds] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  )
    return null;
  if (match[8] !== 'Z') {
    const offsetHours = Number(match[8].slice(1, 3));
    const offsetMinutes = Number(match[8].slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  const canonical = new Date(instant).toISOString();
  // Смещение у самой границы четырёхзначного года может выйти за поддерживаемый формат.
  return /^\d{4}-/.test(canonical) && !canonical.startsWith('0000-') ? canonical : null;
}

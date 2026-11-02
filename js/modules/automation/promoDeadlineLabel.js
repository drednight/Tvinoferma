const months = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря'
];
// Yearless deadlines in recent news use the nearest calendar year across a clear
// year boundary. Explicit years always win; digits in a PIN are never a date.
export function promoDeadlineLabel({ expiresText, expiresOn }, now = Date.now()) {
  const match =
    /(?:до|по)\s+(?:(\d{1,2}:\d{2})\s*(мск|по Москве)?\s*)?(\d{1,2})[.\s/-]+(\d{1,2}|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)[.\s/-]*(\d{4})?(?:\s*года)?(?:\s*включительно)?(?:\s*[,;]?\s*(?:до|в)?\s*(\d{1,2}:\d{2})\s*(мск|по Москве)?)?/i.exec(
      String(expiresText || '')
    );
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiresOn || '');
  if (!match && !iso) return 'не указан — проверьте новость';
  let year = iso?.[1] || match?.[5];
  const month = iso
    ? Number(iso[2])
    : /^\d+$/.test(match[4])
      ? Number(match[4])
      : months.indexOf(match[4].toLowerCase()) + 1;
  const day = iso ? Number(iso[3]) : Number(match[3]);
  if (!year) {
    const today = new Date(now + 3 * 3600000);
    const difference = month - (today.getUTCMonth() + 1);
    year = String(today.getUTCFullYear() + (difference < -6 ? 1 : difference > 6 ? -1 : 0));
  }
  const date = new Date(Date.UTC(Number(year || 2000), month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCFullYear() !== Number(year || 2000))
    return 'не распознан — проверьте новость';
  const time = match?.[1] || match?.[6];
  if (time && (Number(time.split(':')[0]) > 23 || Number(time.split(':')[1]) > 59))
    return 'не распознан — проверьте новость';
  const zone = match?.[2] || match?.[7];
  return `${time ? `${time}${zone ? ' мск' : ''} ` : ''}${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}${year ? `.${year}` : ''}`;
}

export function promoDeadlineState(row, now = Date.now()) {
  const label = promoDeadlineLabel(row, now);
  const date = /(\d{2})\.(\d{2})\.(\d{4})$/.exec(label);
  if (!date) return { expired: false, days: null, text: 'Срок окончания не определён' };
  const at = Date.UTC(Number(date[3]), Number(date[2]) - 1, Number(date[1]));
  const today = new Date(now + 3 * 3600000);
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const time = /^(\d{1,2}):(\d{2}) мск /.exec(label);
  const end = time
    ? at + (Number(time[1]) * 60 + Number(time[2])) * 60000 - 3 * 3600000
    : at + 86400000 - 3 * 3600000 - 1;
  const expired = now > end;
  const days = expired ? 0 : Math.max(1, Math.floor((at - midnight) / 86400000) + 1);
  return {
    expired,
    days,
    tone: expired ? 'danger' : days <= 3 ? 'warning' : 'success',
    text: expired
      ? 'Срок промокода истек'
      : days <= 3
        ? `Скоро истечет, осталось: ${days} ${days === 1 ? 'день' : 'дня'}`
        : `Дней до окончания (включительно): ${days}`
  };
}
export const promoExpiryKey = (row, now = Date.now()) => `${row.code}|${promoDeadlineLabel(row, now)}`;

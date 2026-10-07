// js/modules/runes/submit.js
// Публичный URL Apps Script не является секретом; он задаётся после развёртывания приёмника.

import { CLASSES } from '../../core/constants.js';

export const RUNE_SUBMISSION_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwXnA-Fn_BtMo3RAMYeaO-0urnPEeCqdXh05E8GxS8m187TDRKe57K3NoPebvUA3VoU/exec';

const LIMITS = { author: 100, pve: 2000, pvp: 2000, additional: 2000, note: 500 };

export function createRuneSubmission(values) {
	const submission = {
		class: String(values.class || '').trim(),
		author: String(values.author || '').trim(),
		pve: String(values.pve || '').trim(),
		pvp: String(values.pvp || '').trim(),
		additional: String(values.additional || '').trim(),
		note: String(values.note || '').trim()
	};
	if (!CLASSES.includes(submission.class)) throw new Error('Выберите класс из списка.');
	if (!submission.author) throw new Error('Укажите автора раскладки.');
	if (!submission.pve || !submission.pvp) throw new Error('Заполните PvE- и PvP-руны.');
	for (const [field, limit] of Object.entries(LIMITS)) {
		if (submission[field].length > limit) throw new Error(`Поле «${field}» превышает ${limit} символов.`);
	}
	return submission;
}

export async function submitRuneSuggestion(values, {
	endpoint = RUNE_SUBMISSION_ENDPOINT,
	fetchImpl = globalThis.fetch
} = {}) {
	if (!endpoint) throw new Error('Приём заявок ещё не подключён. Сначала настройте Apps Script.');
	const payload = createRuneSubmission(values);
	return fetchImpl(endpoint, {
		method: 'POST',
		mode: 'no-cors',
		headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
		body: JSON.stringify(payload)
	});
}

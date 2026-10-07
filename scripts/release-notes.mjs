// Текст «Что нового» для релиза: берётся из CHANGELOG.md, раздел версии (`## [X.Y.Z]`).
// Он попадает и в описание черновика релиза, и в поле `notes` файла latest.json — его приложение
// показывает в окне «Доступно обновление». Раздел версии — это изменения с прошлого релиза.
//
//   node scripts/release-notes.mjs v1.1.0                 — вывести текст
//   node scripts/release-notes.mjs v1.1.0 --github-output — записать его в вывод шага GitHub Actions
//
// Правила для CHANGELOG.md:
//   * перед тегом раздел `[Unreleased]` переименовывается в `[X.Y.Z] — дата` (без раздела скрипт падает,
//     и релиз не собирается);
//   * короткий человеческий текст для окна обновления пишется в подразделе `### Кратко` (маркированный список);
//   * если «Кратко» нет, список собирается из жирных заголовков пунктов раздела.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CHANGELOG_URL = 'https://github.com/drednight/Tvinoferma/blob/main/CHANGELOG.md';
const MAX_ITEM = 160;
const MAX_NOTES = 3000;

/** «v1.1.0» → «1.1.0»; всё, что не похоже на версию (ветка при ручном запуске), → null. */
export function normalizeVersion(ref) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(String(ref || '').trim());
  return m ? m[1] : null;
}

/** Строки раздела версии (без заголовка `## [X.Y.Z]`) или null, если раздела нет. */
export function extractSection(changelog, version) {
  const lines = String(changelog || '').replace(/\r\n/g, '\n').split('\n');
  const head = new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`);
  const start = lines.findIndex(l => head.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/** Markdown → обычный текст: без **, `, ссылок и html-тегов. */
export function plainText(md) {
  return String(md || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text, max = MAX_ITEM) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const dot = cut.lastIndexOf('. ');
  return (dot > 40 ? cut.slice(0, dot + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`).trim();
}

/** Пункты верхнего уровня: [{ text }] — строки `- …` без отступа вместе с продолжением. */
function topLevelBullets(lines) {
  const items = [];
  for (const line of lines) {
    if (/^[-*]\s+/.test(line)) items.push(line.replace(/^[-*]\s+/, ''));
    else if (/^\s+\S/.test(line) && items.length && !/^\s+[-*]\s/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/** Короткая строка пункта: жирный заголовок (если он сам по себе понятен), иначе первое предложение. */
function headline(item) {
  const bold = /^\*\*([^*]+)\*\*/.exec(item);
  const lead = bold ? plainText(bold[1]).replace(/[:.]$/, '') : '';
  return clip(lead.length >= 30 ? lead : plainText(item));
}

/** Подразделы `### …`: [{ title, lines }]; текст до первого заголовка — подраздел с пустым title. */
function subsections(section) {
  const out = [{ title: '', lines: [] }];
  for (const line of section) {
    const m = /^###\s+(.*?)\s*$/.exec(line);
    if (m) out.push({ title: m[1], lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

/** Строки для окна «Доступно обновление»: «Кратко» либо заголовки пунктов раздела. */
export function shortItems(section) {
  const parts = subsections(section);
  const brief = parts.find(p => /^Кратко$/i.test(p.title));
  const own = brief ? topLevelBullets(brief.lines) : [];
  if (own.length) return own.map(i => clip(plainText(i), 220));
  return parts.filter(p => p !== brief).flatMap(p => topLevelBullets(p.lines)).map(headline).filter(Boolean);
}

/**
 * Итоговый текст релиза.
 * @throws если в CHANGELOG нет раздела версии или он пуст
 */
export function buildNotes(changelog, version) {
  const section = extractSection(changelog, version);
  if (!section) {
    throw new Error(`В CHANGELOG.md нет раздела «## [${version}]». Перед тегом переименуйте «[Unreleased]» в «[${version}] — дата».`);
  }
  const items = shortItems(section);
  if (!items.length) throw new Error(`Раздел [${version}] в CHANGELOG.md пуст: опишите изменения (подраздел «### Кратко»).`);
  let list = items.map(i => `- ${i}`).join('\n');
  if (list.length > MAX_NOTES) list = `${list.slice(0, MAX_NOTES).replace(/\n[^\n]*$/, '')}\n- …`;
  return `Что нового в ${version}\n\n${list}\n\nВсе изменения: ${CHANGELOG_URL}\n`;
}

function main(argv) {
  const [ref, ...flags] = argv;
  const version = normalizeVersion(ref) || JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const text = buildNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), version);
  if (flags.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nbody<<TF_NOTES_EOF\n${text}TF_NOTES_EOF\n`);
  }
  process.stdout.write(text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

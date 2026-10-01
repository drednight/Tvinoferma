// Общие функции скриптов роадмапа. Требуется Node 18+ и GitHub CLI (gh), если не используется --offline.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const data = JSON.parse(readFileSync(new URL('./items.json', import.meta.url), 'utf8'));
export const { versions, labels, items } = data;

export function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "[0.1] Заголовок" -> "0.1" */
export const idFromTitle = (title) => /^\[(\d+\.\d+)\]/.exec(title || '')?.[1] ?? null;

export const issueTitle = (item) => `[${item.id}] ${item.title}`;

export function issueBody(item) {
  const src = item.sources.join(', ');
  return [
    item.body,
    '',
    '---',
    `Этап ${item.stage}: ${item.stageTitle} · Приоритет: **${item.priority}** · Трудоёмкость: **${item.effort}** · Версия: **${item.version}** · Источник: ${src}`,
    '',
    'Полный контекст: [docs/ROADMAP-FULL.md](../blob/main/docs/ROADMAP-FULL.md)',
  ].join('\n');
}

export function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (const a of argv) {
    if (a.startsWith('--') && a.includes('=')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      out.values[k] = v;
    } else if (a.startsWith('--')) out.flags.add(a.slice(2));
  }
  return out;
}

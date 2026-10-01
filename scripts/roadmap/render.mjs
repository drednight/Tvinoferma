#!/usr/bin/env node
// Обновляет блок прогресса в ROADMAP.md по состоянию Issues (open/closed) на GitHub.
// Блок находится между маркерами <!-- roadmap:start --> и <!-- roadmap:end -->.
//
//   node scripts/roadmap/render.mjs                    # берёт Issues через gh
//   node scripts/roadmap/render.mjs --offline          # без GitHub: все пункты "не сделаны"
//   node scripts/roadmap/render.mjs --input=issues.json --out=/tmp/R.md   # для проверки
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { versions, items, gh, idFromTitle, parseArgs } from './lib.mjs';

const { flags, values } = parseArgs(process.argv.slice(2));
const target = values.out || fileURLToPath(new URL('../../ROADMAP.md', import.meta.url));

let issues;
if (flags.has('offline')) issues = [];
else if (values.input) issues = JSON.parse(readFileSync(values.input, 'utf8'));
else issues = JSON.parse(gh(['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title,state,url']));

const byId = new Map();
for (const i of issues) { const id = idFromTitle(i.title); if (id) byId.set(id, i); }

const bar = (done, total) => {
  const n = total ? Math.round((done / total) * 10) : 0;
  return '█'.repeat(n) + '░'.repeat(10 - n);
};

let totalAll = 0, doneAll = 0;
const blocks = [];
for (const v of versions) {
  const list = items.filter((i) => i.version === v.title).sort((a, b) => a.order - b.order);
  if (!list.length) continue;
  const rows = list.map((it) => {
    const iss = byId.get(it.id);
    const closed = iss?.state === 'CLOSED' || iss?.state === 'closed';
    const ref = iss?.url ? `[#${iss.number}](${iss.url}) ` : '';
    return { closed, line: `- [${closed ? 'x' : ' '}] ${ref}**${it.id}** ${it.title} — ${it.priority}, ${it.effort}` };
  });
  const done = rows.filter((r) => r.closed).length;
  totalAll += rows.length; doneAll += done;
  const pct = Math.round((done / rows.length) * 100);
  blocks.push(`### ${v.title} — ${v.description}\n\n\`${bar(done, rows.length)}\` ${done}/${rows.length} (${pct}%)\n\n${rows.map((r) => r.line).join('\n')}\n`);
}

const today = new Date().toISOString().slice(0, 10);
const pctAll = totalAll ? Math.round((doneAll / totalAll) * 100) : 0;
const body = `**Всего выполнено:** \`${bar(doneAll, totalAll)}\` ${doneAll}/${totalAll} (${pctAll}%) · обновлено ${today}\n\n${blocks.join('\n')}`;

const md = readFileSync(target, 'utf8');
const re = /<!-- roadmap:start -->[\s\S]*?<!-- roadmap:end -->/;
if (!re.test(md)) { console.error('В ROADMAP.md нет маркеров <!-- roadmap:start --> / <!-- roadmap:end -->'); process.exit(1); }
writeFileSync(target, md.replace(re, `<!-- roadmap:start -->\n${body}\n<!-- roadmap:end -->`));
console.log(`ROADMAP.md обновлён: ${doneAll}/${totalAll}`);

#!/usr/bin/env node
// Создаёт в репозитории метки, вехи (milestones) и Issues из items.json.
// Безопасно запускать повторно: существующие пункты (по префиксу "[0.1]") пропускаются.
//
// Использование:
//   node scripts/roadmap/setup.mjs --dry-run            # только показать, что будет сделано
//   node scripts/roadmap/setup.mjs                      # репозиторий берётся из текущей папки
//   node scripts/roadmap/setup.mjs --repo=owner/name
//   node scripts/roadmap/setup.mjs --only=0.1,0.2       # только выбранные пункты
//   node scripts/roadmap/setup.mjs --version=v0.3       # только пункты одной версии
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versions, labels, items, gh, sleep, idFromTitle, issueTitle, issueBody, parseArgs } from './lib.mjs';

const { flags, values } = parseArgs(process.argv.slice(2));
const dry = flags.has('dry-run');
const only = values.only ? new Set(values.only.split(',').map((s) => s.trim())) : null;
const onlyVersion = values.version || null;

const repo = values.repo || (dry ? '(dry-run)' : gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim());
console.log(`Репозиторий: ${repo}${dry ? '  [DRY RUN, ничего не создаётся]' : ''}`);

// 1. Метки
console.log(`\n== Метки (${labels.length}) ==`);
for (const l of labels) {
  console.log(`  label ${l.name}`);
  if (!dry) gh(['label', 'create', l.name, '--color', l.color, '--description', l.description, '--force', '--repo', repo]);
}

// 2. Вехи
console.log(`\n== Вехи (${versions.length}) ==`);
let existingMilestones = new Set();
if (!dry) {
  const list = JSON.parse(gh(['api', `repos/${repo}/milestones?state=all&per_page=100`]));
  existingMilestones = new Set(list.map((m) => m.title));
}
for (const v of versions) {
  if (existingMilestones.has(v.title)) { console.log(`  milestone ${v.title} (уже есть)`); continue; }
  console.log(`  milestone ${v.title} — ${v.description}`);
  if (!dry) gh(['api', '-X', 'POST', `repos/${repo}/milestones`, '-f', `title=${v.title}`, '-f', `description=${v.description}`]);
}

// 3. Issues
let existingIds = new Set();
if (!dry) {
  const list = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'number,title']));
  existingIds = new Set(list.map((i) => idFromTitle(i.title)).filter(Boolean));
}
const todo = items
  .filter((i) => (!only || only.has(i.id)) && (!onlyVersion || i.version === onlyVersion))
  .sort((a, b) => a.order - b.order);
console.log(`\n== Issues (к созданию: ${todo.filter((i) => !existingIds.has(i.id)).length} из ${todo.length}) ==`);

const tmp = dry ? null : mkdtempSync(join(tmpdir(), 'roadmap-'));
let created = 0;
for (const item of todo) {
  if (existingIds.has(item.id)) { console.log(`  skip   ${issueTitle(item)} (уже есть)`); continue; }
  console.log(`  create ${issueTitle(item)}  [${item.version}] ${item.labels.join(', ')}`);
  if (dry) continue;
  const file = join(tmp, `${item.id}.md`);
  writeFileSync(file, issueBody(item));
  const args = ['issue', 'create', '--repo', repo, '--title', issueTitle(item), '--body-file', file, '--milestone', item.version];
  for (const l of item.labels) args.push('--label', l);
  console.log('         ' + gh(args).trim());
  created++;
  await sleep(1500); // мягкий лимит GitHub на создание контента
}
if (tmp) rmSync(tmp, { recursive: true, force: true });
console.log(`\nГотово. Создано issues: ${created}.`);

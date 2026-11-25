// Генератор Markdown-справочника по примерам внешнего API.
//
//   node scripts/build-external-api-examples.mjs           — перезаписать docs/EXTERNAL-API-EXAMPLES.md
//   node scripts/build-external-api-examples.mjs --check   — только проверить, что файл свежий
//
// Источник правды — каталог src-tauri/src/external_api/web/recipes.js (он же рисует
// вкладку «Рецепты» на странице API). Режим --check нужен в CI: если забыли
// перегенерировать документ, сборка должна падать, а не расходиться с каталогом.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipes, renderExamplesMarkdown } from './lib/api-examples.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'docs/EXTERNAL-API-EXAMPLES.md');
const check = process.argv.includes('--check');

const catalog = loadRecipes(root);
const markdown = renderExamplesMarkdown(catalog);

if (check) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error('docs/EXTERNAL-API-EXAMPLES.md не найден — соберите его: npm run docs:api-examples');
    process.exit(1);
  }
  if (current !== markdown) {
    console.error(
      'docs/EXTERNAL-API-EXAMPLES.md разошёлся с каталогом примеров.\n' + 'Пересоберите: npm run docs:api-examples'
    );
    process.exit(1);
  }
  console.log(`docs/EXTERNAL-API-EXAMPLES.md в порядке: рецептов — ${catalog.recipes.length}.`);
} else {
  writeFileSync(target, markdown, 'utf8');
  console.log(`Записан docs/EXTERNAL-API-EXAMPLES.md: рецептов — ${catalog.recipes.length}.`);
}

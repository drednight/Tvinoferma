// Сборка Markdown-справочника по примерам внешнего API.
//
// Источник правды — каталог `src-tauri/src/external_api/web/recipes.js`: тот же,
// что рисует вкладка «Рецепты» на странице API. Документ и страница не могут
// разойтись, потому что собираются из одного списка.
//
// Файл документа перегенерируется скриптом scripts/build-external-api-examples.mjs;
// руками его править не нужно: правка каталога и повторная сборка.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Загрузить каталог примеров так же, как это делает страница.
 * @param {string} root корень репозитория
 * @returns {{ groups: any[], recipes: any[], snippets: Record<string, (recipe: any) => string> }}
 */
export function loadRecipes(root) {
  const source = readFileSync(resolve(root, 'src-tauri/src/external_api/web/recipes.js'), 'utf8');
  const scope = {};
  new Function('window', source)(scope);
  return {
    groups: scope.TF_API_RECIPE_GROUPS || [],
    recipes: scope.TF_API_RECIPES || [],
    snippets: scope.TF_API_RECIPE_SNIPPETS || {}
  };
}

/** Название права по-человечески. */
const SCOPE_NAMES = {
  read: 'чтение',
  modify: 'изменение',
  launchClose: 'запуск и закрытие окон'
};

/** Блок кода: если текст — JSON, оборачиваем в json, иначе оставляем как есть. */
function codeBlock(text, language = '') {
  return `\`\`\`${language}\n${String(text).replace(/\s+$/, '')}\n\`\`\``;
}

/** Тело ответа: JSON — pretty, строка — как есть. */
function responseBlock(response) {
  if (typeof response === 'string') return codeBlock(response, 'text');
  return codeBlock(JSON.stringify(response, null, 2), 'json');
}

/**
 * Собрать Markdown-документ по каталогу.
 * @param {{ groups: any[], recipes: any[], snippets: Record<string, (recipe: any) => string> }} catalog
 * @returns {string}
 */
export function renderExamplesMarkdown(catalog) {
  const { groups, recipes, snippets } = catalog;
  const lines = [];
  lines.push('# Примеры внешнего API Твинофермы');
  lines.push('');
  lines.push(
    '> Файл собран автоматически из каталога `src-tauri/src/external_api/web/recipes.js` — того же,',
    '> что показывает вкладка «Рецепты» на странице API. Правьте каталог и запускайте',
    '> `npm run docs:api-examples`; руками этот документ не редактируют.'
  );
  lines.push('');
  lines.push(
    'Каждый пример — это законченный сценарий: **когда он нужен**, **запрос**, **ответ** и **что ответ значит**.',
    'Ошибки разобраны отдельно: у каждого примера перечислены коды, которые он может вернуть, и что делать в каждом.'
  );
  lines.push('');

  // Оглавление
  lines.push('## Содержание');
  lines.push('');
  groups.forEach(group => {
    const inGroup = recipes.filter(recipe => recipe.group === group.id);
    if (!inGroup.length) return;
    lines.push(`- **${group.title}**`);
    inGroup.forEach(recipe => {
      lines.push(`  - [${recipe.title}](#${anchor(recipe.title)})`);
    });
  });
  lines.push('');

  groups.forEach(group => {
    const inGroup = recipes.filter(recipe => recipe.group === group.id);
    if (!inGroup.length) return;
    lines.push(`## ${group.title}`);
    lines.push('');
    inGroup.forEach(recipe => {
      lines.push(`### ${recipe.title}`);
      lines.push('');
      lines.push(`**Когда нужно.** ${recipe.scenario}`);
      lines.push('');
      lines.push(`\`${recipe.method} ${recipe.template}\` · право: ${SCOPE_NAMES[recipe.scope] || recipe.scope}`);
      if (recipe.body) {
        lines.push('');
        lines.push('Тело запроса:');
        lines.push('');
        lines.push(codeBlock(JSON.stringify(recipe.body, null, 2), 'json'));
      }
      lines.push('');
      lines.push('#### Запрос');
      lines.push('');
      lines.push('```bash');
      lines.push(snippets.curl ? snippets.curl(recipe) : '');
      lines.push('```');
      lines.push('');
      lines.push('#### Ответ');
      lines.push('');
      lines.push(responseBlock(recipe.response));
      lines.push('');
      lines.push('#### Что это значит');
      lines.push('');
      lines.push(recipe.explanation);
      if (recipe.errors && recipe.errors.length) {
        lines.push('');
        lines.push('#### Если придёт ошибка');
        lines.push('');
        lines.push('| Код | Что значит | Что делать |');
        lines.push('| --- | --- | --- |');
        recipe.errors.forEach(error => {
          lines.push(`| ${error.status} \`${error.code}\` | ${error.why.split('.')[0]}. | ${error.why} |`);
        });
      }
      lines.push('');
    });
  });

  lines.push('---');
  lines.push('');
  lines.push(
    'Тот же набор примеров доступен прямо в приложении: «Настройки → 🔌 Внешний API → Открыть страницу API»,',
    'вкладка «Рецепты» — там же примеры копируются кнопкой и подставляется настоящий токен.'
  );
  lines.push('');
  return lines.join('\n');
}

/** Якорь заголовка в Markdown — как его делает GitHub. */
function anchor(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

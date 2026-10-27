import js from '@eslint/js';
import globals from 'globals';

export default [
  // demo/ — площадка макетов (лаборатория окон скриптов), не код приложения: линтер там
  // лишний, форматирование обеспечивает prettier, в сборку и тесты демо не попадает.
  { ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'public/**', 'coverage/**', 'demo/**'] },
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none', varsIgnorePattern: '^_' }
      ],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.{js,mjs}', 'vite.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none', varsIgnorePattern: '^_' }
      ],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    // Прототип в docs/visuals: обычные скрипты в браузере, глобальная переменная TV.
    files: ['docs/visuals/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, TV: 'writable' }
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none', varsIgnorePattern: '^_' }
      ],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
];

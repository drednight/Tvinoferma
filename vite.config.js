import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
let revision = 'unknown';
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* source archive */
}

export default defineConfig({
  clearScreen: false,
  define: { __TF_BUILD_INFO__: JSON.stringify({ version, revision }) },
  server: {
    port: 1420,
    strictPort: true,
    allowedHosts: ['.e2b.app'],
    // ВАЖНОЕ ИЗМЕНЕНИЕ НИЖЕ:
    watch: {
      // Игнорируем папку src-tauri/target, чтобы OneDrive/Vite не конфликтовали с Cargo
      ignored: ['**/src-tauri/target/**']
    }
  },
  build: {
    outDir: 'dist',
    rollupOptions: { input: { main: 'index.html', overlay: 'game-overlay.html' } },
    target: 'es2021'
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    // На медленной машине (OneDrive, антивирус, параллельная сборка) тесты страниц сайта выполняются дольше 5 с по умолчанию
    testTimeout: 30000,
    hookTimeout: 30000
  }
});

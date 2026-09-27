import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // ВАЖНОЕ ИЗМЕНЕНИЕ НИЖЕ:
    watch: {
      // Игнорируем папку src-tauri/target, чтобы OneDrive/Vite не конфликтовали с Cargo
      ignored: ['**/src-tauri/target/**'] 
    }
  },
  build: {
    outDir: 'dist',
    target: 'es2021'
  }
});
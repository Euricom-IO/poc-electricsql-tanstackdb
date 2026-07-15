import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  // This monorepo keeps a single `.env` at the repo root, so tell Vite to load
  // env files (and expose `VITE_*` vars to `import.meta.env`) from there rather
  // than from this package directory.
  envDir: path.resolve(import.meta.dirname, '../..'),
  // PowerSync ships its SQLite WASM + sync workers as separate ESM bundles.
  // Excluding them from dep-optimization keeps those worker URLs intact, and the
  // ES worker format is required for the bundled comlink workers to load.
  optimizeDeps: {
    include: ['@powersync/web > js-logger'],
    exclude: ['@journeyapps/wa-sqlite', '@powersync/web'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});

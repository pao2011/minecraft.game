import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'build/web',
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  server: { host: true, port: 5173 },
});

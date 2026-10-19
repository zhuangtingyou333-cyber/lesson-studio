import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'apps/admin-web', plugins: [react()],
  server: { port: 5187, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4310' } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});

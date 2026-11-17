import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_BASE: Pfad, unter dem die App ausgeliefert wird, zum Beispiel /jobbster/app/ auf GitHub Pages.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as never);

import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwind from '@tailwindcss/vite';
import { resolve } from 'path';

// Standalone build of the Mission Control v2 frontend.
// Vite root is web/ (this directory). Output lands in web/dist/.
// API proxy + dashboard wiring are intentionally NOT configured here —
// those are A.2/A.3 follow-up missions per v2-port-plan.md.
export default defineConfig({
  plugins: [preact(), tailwind()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['preact', '@preact/signals', 'wouter-preact', 'lucide-preact'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // wouter-preact pulls in `react` shims; alias to preact/compat.
      // preset-vite handles this for most libs but we keep it explicit.
      react: 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
});

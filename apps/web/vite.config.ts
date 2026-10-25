import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const gateway = process.env.KRONOS_GATEWAY ?? 'http://127.0.0.1:7777';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': gateway,
      '/v1': gateway,
      '/ws': { target: gateway.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          markdown: ['marked', 'dompurify', 'highlight.js'],
          terminal: ['@xterm/xterm', '@xterm/addon-fit'],
        },
      },
    },
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const edge = process.env.IPC_EDGE_URL ?? 'https://ipc.localhost';

export default defineConfig({
  base: '/officer/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/ipc': { target: edge, changeOrigin: true, secure: false } },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // App code apart from third-party code, so app releases do not re-download vendors.
        manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const edge = process.env.IPC_EDGE_URL ?? 'https://ipc.localhost';

export default defineConfig({
  base: '/field/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'IPC Field',
        short_name: 'IPC Field',
        description: 'Ward assessments, tasks and evidence, offline for up to 7 days.',
        start_url: '/field/',
        scope: '/field/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#1d4ed8',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only. API data is never put in Cache Storage: it lives encrypted in IndexedDB.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/ipc\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        // Background Sync: the sync event wakes open app windows to flush the outbox.
        importScripts: ['sw-sync.js'],
      },
    }),
  ],
  server: {
    port: 5174,
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

import { fileURLToPath } from 'url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Code the browser and the server both run lives in shared/ at the repo root.
const CLIENT_DIR = fileURLToPath(new URL('.', import.meta.url));
const SHARED_DIR = fileURLToPath(new URL('../shared', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@shared': SHARED_DIR },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'offline.html', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'RO-IPTV',
        short_name: 'RO-IPTV',
        description: 'Self-hosted M3U / IPTV player with EPG, radio and recordings.',
        theme_color: '#0D0F1A',
        background_color: '#0D0F1A',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Activate a new build immediately so installed PWAs don't run stale code.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Account/source data and provider logos must not survive a session.
        // The precached static shell remains available offline.
        importScripts: ['/privacy-sw.js'],
        runtimeCaching: [{
          urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
          handler: 'NetworkOnly',
          options: { fetchOptions: { cache: 'no-store' } },
        }],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    // The dev server has to read shared/, which sits outside the client root.
    // Scoped to that one directory rather than the whole repo: this server binds
    // on the LAN (host: true), and the repo also holds .env, data/ and .git.
    fs: { allow: [CLIENT_DIR, SHARED_DIR] },
    // Dev server only answers localhost/LAN by default. To expose it through a
    // reverse-proxy hostname, set VITE_ALLOWED_HOSTS (comma-separated) — no
    // personal domain is hardcoded here. Production (the Docker/Express image)
    // serves any hostname, so that's where a domain like a reverse-proxy points.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
      : undefined,
    proxy: {
      // Dev API target. Defaults to the container on :56892; override with
      // VITE_API_TARGET to point at a locally-run dev backend.
      '/api': process.env.VITE_API_TARGET || 'http://localhost:56892',
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
});

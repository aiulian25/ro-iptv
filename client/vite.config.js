import { fileURLToPath } from 'url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Code the browser and the server both run lives in shared/ at the repo root.
const CLIENT_DIR = fileURLToPath(new URL('.', import.meta.url));
const SHARED_DIR = fileURLToPath(new URL('../shared', import.meta.url));

// Workbox decides what to cache from the response status alone, and an authenticating
// reverse proxy (Pangolin/Badger, Authelia, oauth2-proxy…) answers its login page with
// a 200. Without these guards that page is stored as the app's own data and served from
// cache long after the session is valid again. A followed redirect is the tell: our own
// origin never redirects an API call.
//
// Both callbacks are STRINGIFIED into sw.js by workbox-build, so they run with none of
// this file's scope around them: every value they use has to be written inline, and a
// shared constant would reach the browser as a ReferenceError.

// Cache only what is really ours: not redirected, and actually JSON.
const cacheOwnJsonOnly = {
  cacheWillUpdate: async ({ response }) =>
    response.redirected || !/\bjson\b/.test(response.headers.get('content-type') || '') ? null : response,
};

// Logos come from arbitrary third-party CDNs, so an opaque (status 0, headerless)
// response is normal here and must stay cacheable — only a redirect is disqualifying.
const rejectRedirected = {
  cacheWillUpdate: async ({ response }) => (response.redirected ? null : response),
};

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
        runtimeCaching: [
          {
            // Channel & station logos — cache-first, long-lived.
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'logo-cache',
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
              plugins: [rejectRedirected],
            },
          },
          {
            // EPG / playlist API data — network-first with offline fallback to cache.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/epg') || url.pathname.startsWith('/api/playlist'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'epg-cache',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 6 },
              cacheableResponse: { statuses: [0, 200] },
              plugins: [cacheOwnJsonOnly],
            },
          },
        ],
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

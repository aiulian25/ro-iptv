import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
            },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
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

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        id: '/',
        name: 'dlvault',
        short_name: 'dlvault',
        description: 'Automatische Film-Downloads von Trakt Watchlist',
        lang: 'de',
        dir: 'ltr',
        theme_color: '#0b0c0e',
        background_color: '#0b0c0e',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'any',
        start_url: '/',
        scope: '/',
        categories: ['entertainment', 'utilities'],
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
        shortcuts: [
          {
            name: 'Sync starten',
            short_name: 'Sync',
            description: 'Watchlist mit Quellen synchronisieren',
            url: '/?action=sync',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }],
          },
          {
            name: 'Warteschlange',
            short_name: 'Queue',
            description: 'Aktive Suche und Downloads',
            url: '/movies',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }],
          },
          {
            name: 'Mediathek',
            short_name: 'Library',
            description: 'Heruntergeladene Filme und Serien',
            url: '/library',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }],
          },
          {
            name: 'Downloads',
            short_name: 'Downloads',
            description: 'Aktive JDownloader-Pakete',
            url: '/downloads',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        skipWaiting: true,
        clientsClaim: true,
        // No runtime cache for /api/ — internal app, not offline-first.
        // Caching can mask stale sync state and would incorrectly try to cache the
        // long-lived /api/events SSE stream.
      },
    }),
  ],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});

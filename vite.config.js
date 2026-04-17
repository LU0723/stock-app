import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',

      // 靜態資源快取清單（build 時自動 precache）
      includeAssets: ['pwa-192x192.png', 'pwa-512x512.png'],

      // Web App Manifest
      manifest: {
        name:             '投資總覽',
        short_name:       '投資總覽',
        description:      '個人投資組合總覽',
        theme_color:      '#0f0f0f',
        background_color: '#0f0f0f',
        display:          'standalone',
        orientation:      'portrait',
        start_url:        '/',
        scope:            '/',
        icons: [
          {
            src:   'pwa-192x192.png',
            sizes: '192x192',
            type:  'image/png',
          },
          {
            src:   'pwa-512x512.png',
            sizes: '512x512',
            type:  'image/png',
          },
          {
            // maskable：Android 自適應 icon，讓系統可裁切成圓形等形狀
            src:     'pwa-512x512.png',
            sizes:   '512x512',
            type:    'image/png',
            purpose: 'maskable',
          },
        ],
      },

      // Workbox 快取策略
      workbox: {
        // 快取所有靜態資源（JS、CSS、HTML、圖片）
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff,woff2}'],

        runtimeCaching: [
          {
            // 股價 API：永遠走網路，不快取（確保資料即時）
            urlPattern: /\/api\/stock.*/,
            handler: 'NetworkOnly',
          },
          {
            // 美股報價 API：永遠走網路，不快取
            urlPattern: /\/api\/us-stock.*/,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],

  server: {
    proxy: {
      // 代理 TWSE MIS 即時 API，避免瀏覽器 CORS 限制
      '/mis-api': {
        target:      'https://mis.twse.com.tw',
        changeOrigin: true,
        rewrite:     (path) => path.replace(/^\/mis-api/, ''),
      },
    },
  },
})

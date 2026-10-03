import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

const repo = resolve(import.meta.dirname, '../..');
const cert = process.env.PWA_CERT ?? resolve(repo, 'data/certs/cert.pem');
const key = process.env.PWA_KEY ?? resolve(repo, 'data/certs/key.pem');
// HTTPS when mkcert certs exist (phone camera needs a secure context); plain HTTP otherwise (localhost is secure).
const https = existsSync(cert) && existsSync(key) ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: { navigateFallbackDenylist: [/^\/api\//] }, // app shell only; API calls are never cached
      manifest: {
        name: 'Care Agent',
        short_name: 'Care Agent',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        background_color: '#ece5dd',
        theme_color: '#075e54',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    https,
    proxy: {
      // timeout 0: the analysis stream never closes by itself
      '/api': { target: process.env.API_URL ?? 'http://localhost:8787', timeout: 0, proxyTimeout: 0 },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});

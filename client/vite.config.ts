
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    plugins: [
        react(),

        VitePWA({
            registerType: 'prompt',
            injectRegister: false,

            includeAssets: [
                'stratify-logo.png',
                'icons/icon-192.png',
                'icons/icon-512.png'
            ],

            manifest: {
                id: '/',

                name: 'StratifyPOS',

                short_name: 'StratifyPOS',

                description:
                    'Smart Business Management and Point of Sale',

                start_url: '/app',

                scope: '/',

                display: 'standalone',

                background_color: '#FFFFFF',

                theme_color: '#082E43',

                icons: [
                    {
                        src: '/icons/icon-192.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: '/icons/icon-512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any'
                    }
                ]
            },

            workbox: {
                globPatterns: [
                    '**/*.{js,css,html,ico,png,svg,woff2}'
                ],

                navigateFallback: null,
                directoryIndex: null,
                runtimeCaching: [
                    {
                        urlPattern: ({ request, sameOrigin, url }) => sameOrigin && request.mode === 'navigate'
                            && !/^\/(?:api|admin-api)(?:\/|$)/.test(url.pathname),
                        handler: 'NetworkOnly',
                        options: { precacheFallback: { fallbackURL: '/index.html' } }
                    }
                ],

                cleanupOutdatedCaches: true,

                skipWaiting: true,

                clientsClaim: false
            },

            devOptions: {
                enabled: false
            }
        })
    ]
});

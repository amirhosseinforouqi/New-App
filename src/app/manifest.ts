import type { MetadataRoute } from 'next';

import { env } from '@/lib/env';

/**
 * Web app manifest.
 *
 * `display: standalone` is what makes the portal launch without browser
 * chrome once installed — the "persistently installed app" the borrower keeps
 * on their home screen.
 *
 * `start_url: /dashboard` rather than `/`: someone who installed this did so
 * because they are mid-application, and the root only redirects anyway.
 * Shortcuts go straight to the two things they actually open it for.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: env.appName,
    short_name: 'UWA',
    description: 'Track your mortgage application, upload documents and message your broker.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f6f7f9',
    theme_color: '#1e3a5f',
    lang: 'en-CA',
    categories: ['finance', 'productivity'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Upload a document', url: '/dashboard#documents' },
      { name: 'Message my broker', url: '/dashboard#messages' },
    ],
  };
}

import type { Metadata, Viewport } from 'next';

import './globals.css';
import { env } from '@/lib/env';

export const metadata: Metadata = {
  title: env.appName,
  description: 'Secure client portal for your mortgage application.',
  // A client portal has no business being indexed. Note this does NOT cover
  // /apply and /calculators, which are public marketing surfaces and set their
  // own metadata.
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'UWA',
    // 'default' keeps the iOS status bar legible against the light canvas;
    // 'black-translucent' would put dark text on a dark header.
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1e3a5f',
  // Installed apps run edge-to-edge on notched phones; without this the
  // content sits behind the home indicator.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

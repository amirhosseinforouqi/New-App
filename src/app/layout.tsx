import type { Metadata, Viewport } from 'next';

import './globals.css';
import { env } from '@/lib/env';

export const metadata: Metadata = {
  title: env.appName,
  description: 'Secure client portal for your mortgage application.',
  // A client portal has no business being indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#12161f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

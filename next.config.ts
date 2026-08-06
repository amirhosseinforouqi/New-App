import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Standalone output bundles only the files the server actually needs, which
  // keeps the production image small and makes the app portable across hosts.
  output: 'standalone',

  // These are Node-only and must not be bundled into the serverless/edge
  // graph. googleapis in particular breaks the build if webpack tries to
  // trace it.
  serverExternalPackages: ['googleapis', 'pg', 'nodemailer', 'imapflow', 'mailparser'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // Content-Security-Policy is NOT set here. It needs a per-request
          // nonce so Next's inline bootstrap and RSC payload scripts are
          // allowed to run — a static `script-src 'self'` blocks them and the
          // app never hydrates. See src/middleware.ts.
        ],
      },
    ];
  },
};

export default config;

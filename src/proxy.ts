/**
 * Per-request Content-Security-Policy with a nonce.
 *
 * Named `proxy` in a file called proxy.ts: Next 16 renamed the `middleware`
 * convention. The old name still runs but warns, and Next refuses to start if
 * both files exist.
 *
 * Why this is not a static header in next.config.ts (where it started, and
 * where it was broken):
 *
 * Next.js injects inline `<script>` tags on every page — the bootstrap and the
 * streamed RSC payload. A policy of `script-src 'self'` blocks all of them, so
 * React never hydrates and the app renders as dead HTML: no login, no upload,
 * no messaging. `next build` does not catch this, because the failure only
 * happens in a browser.
 *
 * The fix Next.js documents is a nonce generated per request. Next reads it
 * back off the request's own Content-Security-Policy header and stamps it onto
 * the scripts it emits.
 *
 * `'strict-dynamic'` lets those nonce-carrying scripts load the rest of the
 * bundle without enumerating every chunk — and, usefully, means the `'self'`
 * fallback is ignored by supporting browsers, so an injected `<script src>`
 * pointing at our own origin still will not run.
 */

import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  // Next's dev server compiles with eval; production does not need it. Scoping
  // the exception to development keeps the shipped policy tight.
  const scriptSrc =
    process.env.NODE_ENV === 'development'
      ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
      : `'self' 'nonce-${nonce}' 'strict-dynamic'`;

  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Next inlines critical CSS; there is no nonce hook for it. Styles cannot
    // exfiltrate data on their own, so this is a far smaller concession than
    // the equivalent would be for scripts.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next reads the nonce from this request header — without it, the scripts it
  // renders carry no nonce and the policy blocks them.
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the favicon. Note the exclusion of
     * `_next/static` — hashing a nonce into an immutable, cacheable asset
     * response would make it uncacheable for no benefit.
     */
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

/*
 * Service worker for the borrower portal.
 *
 * Scope is deliberately narrow. A mortgage portal is not a news site: caching
 * a borrower's document list or message thread would mean showing stale
 * financial information, and — worse — leaving it on the device after they
 * sign out. So:
 *
 *   Static build assets are cached (they are content-hashed and immutable).
 *   The offline fallback page is cached.
 *   EVERYTHING ELSE is network-only. No HTML, no API response, nothing
 *   client-specific ever touches the cache.
 *
 * The app is installable and launches like an app; it is not usable offline
 * beyond telling you it needs a connection. That is the honest trade for a
 * product whose entire content is other people's private financial data.
 */

const VERSION = 'uwa-v1';
const OFFLINE_URL = '/offline';
const PRECACHE = [OFFLINE_URL];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch anything but same-origin GETs.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Immutable build output: cache-first is safe and makes launch instant.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
    return;
  }

  // Page navigations: network only, with an offline page if the network is
  // gone. Deliberately NOT cached — a cached dashboard is stale financial
  // information that outlives sign-out.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Everything else, including every /api/ call: straight to the network.
});

/*
 * Push notifications for milestone updates.
 *
 * The payload carries no financial detail on purpose — a notification is
 * rendered on a lock screen, potentially in public. It says something moved
 * and links to the portal; the actual information is behind the login.
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Update on your application', body: 'Open your portal to see it.' };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'Your mortgage application', {
      body: payload.body ?? 'There is an update on your file.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag ?? 'uwa-update',
      data: { url: payload.url ?? '/dashboard' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/dashboard';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.includes(target) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

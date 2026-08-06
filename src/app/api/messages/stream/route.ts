/**
 * Server-Sent Events stream for a client's message thread.
 *
 * SSE rather than websockets: it is one HTTP response, it reconnects on its
 * own, it survives proxies that mangle upgrades, and it needs no extra process
 * or dependency. For a one-direction notification channel that is the whole
 * requirement.
 *
 * A heartbeat comment every 25 seconds keeps intermediaries from closing an
 * idle connection — 30s and 60s idle timeouts are common defaults, and a
 * silently dropped stream looks to the user like messages simply stopped
 * arriving.
 */

import { eq } from 'drizzle-orm';

import { asSystem } from '@/db';
import { clients } from '@/db/schema';
import { getCurrentUser } from '@/lib/auth/session';
import { messageChannel, subscribe } from '@/lib/events';

export const dynamic = 'force-dynamic';
// Node runtime: the events bus and pg pool are not edge-compatible.
export const runtime = 'nodejs';

const HEARTBEAT_MS = 25_000;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const clientId = new URL(request.url).searchParams.get('clientId');
  if (!clientId) return new Response('Missing clientId', { status: 400 });

  // A client may only stream their own thread. A broker may stream any thread,
  // but the client must exist — otherwise this is a probe.
  if (user.kind === 'client') {
    if (user.id !== clientId) return new Response('Not found', { status: 404 });
  } else {
    const exists = await asSystem(async (db) => {
      const [row] = await db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.id, clientId))
        .limit(1);
      return Boolean(row);
    });
    if (!exists) return new Response('Not found', { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          closed = true;
        }
      };

      // Tell the browser to wait 5s before reconnecting after a drop.
      send('retry: 5000\n\n');
      send(': connected\n\n');

      const unsubscribe = subscribe(messageChannel(clientId), (payload) => {
        send(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      });

      const heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which defeats SSE entirely.
      'X-Accel-Buffering': 'no',
    },
  });
}

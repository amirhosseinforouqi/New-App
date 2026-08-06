/**
 * In-process pub/sub for Server-Sent Events.
 *
 * Scope and limits, stated plainly: this is an in-memory bus, so it delivers
 * only to browsers connected to the SAME Node process. That is correct for a
 * single-container deployment, which is what this app is built for.
 *
 * If you scale to multiple web replicas, messages will still be persisted and
 * still appear on refresh — but live push will only reach clients attached to
 * the emitting instance. Swap this file for Postgres LISTEN/NOTIFY (the
 * database is already there) or Redis pub/sub at that point; the interface is
 * deliberately small enough to make that a contained change.
 */

type Listener = (payload: unknown) => void;

const channels = new Map<string, Set<Listener>>();

export function subscribe(channel: string, listener: Listener): () => void {
  let listeners = channels.get(channel);
  if (!listeners) {
    listeners = new Set();
    channels.set(channel, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) channels.delete(channel);
  };
}

export function publish(channel: string, payload: unknown): void {
  const listeners = channels.get(channel);
  if (!listeners) return;

  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (error) {
      console.error('[events] listener threw', error);
    }
  }
}

/** One channel per client thread. */
export const messageChannel = (clientId: string) => `messages:${clientId}`;

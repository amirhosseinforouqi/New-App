'use client';

/**
 * Persistent message thread.
 *
 * Not ephemeral chat: every message is a row, the whole history loads, and it
 * survives sign-out. New messages arrive over Server-Sent Events, which need
 * no extra infrastructure and reconnect on their own — a good fit for a
 * self-hosted deployment where adding a websocket layer would be the single
 * largest operational cost in the stack.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

export interface ThreadMessage {
  id: string;
  senderType: 'client' | 'broker' | 'agent' | 'system';
  body: string;
  createdAt: string;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();

  return sameDay
    ? date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString('en-CA', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

export function MessageThread({
  clientId,
  viewerType,
  initialMessages,
  brokerName,
  clientName,
}: {
  clientId: string;
  viewerType: 'client' | 'broker';
  initialMessages: ThreadMessage[];
  brokerName: string;
  clientName: string;
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  useEffect(() => {
    scrollToBottom('instant');
  }, [scrollToBottom]);

  // Live updates. EventSource retries automatically on disconnect, so there is
  // no reconnect logic to get wrong here.
  useEffect(() => {
    const source = new EventSource(`/api/messages/stream?clientId=${encodeURIComponent(clientId)}`);

    source.addEventListener('message', (event) => {
      try {
        const incoming = JSON.parse((event as MessageEvent).data) as ThreadMessage;
        setMessages((current) =>
          current.some((message) => message.id === incoming.id)
            ? current
            : [...current, incoming],
        );
      } catch {
        /* a malformed frame should not kill the stream */
      }
    });

    return () => source.close();
  }, [clientId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Only auto-scroll when the reader is already near the bottom — yanking
    // someone away from a message they are reading is worse than a missed
    // notification.
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    if (nearBottom) scrollToBottom();
  }, [messages, scrollToBottom]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setError(null);

    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, body }),
      });

      const data = (await response.json()) as { message?: ThreadMessage; error?: string };

      if (!response.ok || !data.message) {
        setError(data.error ?? 'Message could not be sent.');
        setSending(false);
        return;
      }

      setMessages((current) =>
        current.some((m) => m.id === data.message!.id) ? current : [...current, data.message!],
      );
      setDraft('');
    } catch {
      setError('Could not reach the server. Your message was not sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="card flex h-[520px] flex-col" aria-labelledby="thread-heading">
      <div className="border-b border-[var(--color-line)] px-5 py-4">
        <h2 id="thread-heading" className="text-base font-semibold">
          Messages
        </h2>
        <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
          {viewerType === 'client'
            ? `Direct line to ${brokerName}. Everything here is saved.`
            : `Thread with ${clientName}.`}
        </p>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-5 py-4"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.length === 0 && (
          <p className="py-8 text-center text-sm text-[var(--color-ink-400)]">
            No messages yet. Say hello — questions are welcome at any stage.
          </p>
        )}

        {messages.map((message) => {
          const isOwn = message.senderType === viewerType;
          const isSystem = message.senderType === 'agent' || message.senderType === 'system';

          if (isSystem) {
            return (
              <div key={message.id} className="py-1 text-center">
                <span className="inline-block rounded-full bg-[var(--color-canvas)] px-3 py-1 text-xs text-[var(--color-ink-400)]">
                  {message.body}
                </span>
              </div>
            );
          }

          return (
            <div key={message.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-[80%]">
                <div
                  className={`rounded-[12px] px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words ${
                    isOwn
                      ? 'bg-[var(--color-accent-700)] text-white'
                      : 'bg-[var(--color-canvas)] text-[var(--color-ink-900)]'
                  }`}
                >
                  {message.body}
                </div>
                <p
                  className={`mt-1 text-[11px] text-[var(--color-ink-400)] ${
                    isOwn ? 'text-right' : 'text-left'
                  }`}
                >
                  {isOwn ? 'You' : message.senderType === 'broker' ? brokerName : clientName} ·{' '}
                  {formatTime(message.createdAt)}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={send} className="border-t border-[var(--color-line)] p-3">
        {error && (
          <div className="alert alert-error mb-2" role="alert">
            {error}
          </div>
        )}
        <div className="flex items-end gap-2">
          <label htmlFor="message-body" className="sr-only">
            Your message
          </label>
          <textarea
            id="message-body"
            className="input min-h-[42px] resize-none py-2.5"
            rows={1}
            placeholder="Write a message…"
            value={draft}
            maxLength={5000}
            onChange={(event) => {
              setDraft(event.target.value);
              const el = event.target;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
            }}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter makes a new line — the convention
              // every messaging app has trained people into.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(event as unknown as FormEvent);
              }
            }}
          />
          <button
            type="submit"
            className="btn btn-primary shrink-0"
            disabled={sending || draft.trim().length === 0}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </section>
  );
}

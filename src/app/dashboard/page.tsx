/**
 * Client dashboard.
 *
 * Server component: every query runs under the client's own RLS context, so
 * this page physically cannot render another client's data even if a query
 * below were written wrong.
 */

import { redirect } from 'next/navigation';
import { asc, desc, eq } from 'drizzle-orm';

import { asClient, asSystem } from '@/db';
import { brokers, clientStageHistory, documentRequests, documents, messages } from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { DocumentPanel } from '@/components/document-panel';
import { MessageThread } from '@/components/message-thread';
import { StageTimeline } from '@/components/stage-timeline';
import { getCurrentUser } from '@/lib/auth/session';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'client') redirect('/broker');
  if (user.mustChangePassword) redirect('/change-password');

  const data = await asClient(user.id, async (db) => {
    const [checklist, uploaded, thread, history] = await Promise.all([
      db
        .select()
        .from(documentRequests)
        .where(eq(documentRequests.clientId, user.id))
        .orderBy(asc(documentRequests.sortOrder)),
      db
        .select()
        .from(documents)
        .where(eq(documents.clientId, user.id))
        .orderBy(desc(documents.createdAt)),
      db
        .select()
        .from(messages)
        .where(eq(messages.clientId, user.id))
        .orderBy(asc(messages.createdAt)),
      db
        .select()
        .from(clientStageHistory)
        .where(eq(clientStageHistory.clientId, user.id))
        .orderBy(asc(clientStageHistory.createdAt)),
    ]);

    return { checklist, uploaded, thread, history };
  });

  // Broker name is used for message attribution. `brokers` is not a
  // client-scoped table (it carries no client data), so it is read under the
  // system actor rather than widening the client's own permissions.
  const brokerName = await asSystem(async (db) => {
    const [broker] = await db
      .select({ fullName: brokers.fullName })
      .from(brokers)
      .where(eq(brokers.isActive, true))
      .limit(1);
    return broker?.fullName ?? 'Your broker';
  });

  // First time each stage was reached — later re-entries do not overwrite,
  // so a stage that was corrected backwards keeps its original date.
  const reachedAt: Record<string, string> = {};
  for (const entry of data.history) {
    reachedAt[entry.stageKey] ??= entry.createdAt.toISOString();
  }

  const firstName = user.fullName.trim().split(/\s+/)[0] ?? user.fullName;

  return (
    <div className="min-h-dvh">
      <AppHeader appName={env.appName} userName={user.fullName} subtitle="Client portal" />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Hello, {firstName}</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-500)]">
            Here is where your application stands.
          </p>
        </div>

        <div className="space-y-6">
          <StageTimeline currentStageKey={user.stageKey} reachedAt={reachedAt} />

          <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
            <DocumentPanel
              checklist={data.checklist.map((item) => ({
                id: item.id,
                label: item.label,
                description: item.description,
                category: item.category,
                isRequired: item.isRequired,
                status: item.status,
                reviewNote: item.reviewNote,
              }))}
              documents={data.uploaded.map((doc) => ({
                id: doc.id,
                fileName: doc.fileName,
                mimeType: doc.mimeType,
                sizeBytes: doc.sizeBytes,
                status: doc.status,
                reviewNote: doc.reviewNote,
                requestId: doc.requestId,
                createdAt: doc.createdAt.toISOString(),
              }))}
            />

            <MessageThread
              clientId={user.id}
              viewerType="client"
              brokerName={brokerName}
              clientName={user.fullName}
              initialMessages={data.thread.map((message) => ({
                id: message.id,
                senderType: message.senderType,
                body: message.body,
                createdAt: message.createdAt.toISOString(),
              }))}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * Broker's view of one client file.
 *
 * Everything the broker needs in one screen: where the file sits, what is
 * outstanding, what is waiting for review, the message thread, and the agent's
 * recent runs.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { asc, desc, eq } from 'drizzle-orm';

import { asBroker } from '@/db';
import {
  agentRuns,
  clients,
  clientStageHistory,
  documentRequests,
  documents,
  messages,
} from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { MessageThread } from '@/components/message-thread';
import { getCurrentUser } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { getStage } from '@/lib/pipeline/stages';
import { AgentPanel } from './agent-panel';
import { DocumentReview } from './document-review';
import { StageController } from './stage-controller';

export const dynamic = 'force-dynamic';

export default async function ClientDetailPage(props: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'broker') redirect('/dashboard');

  const { id } = await props.params;

  const data = await asBroker(user.id, async (db) => {
    const [client] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
    if (!client) return null;

    // Sequential, not Promise.all — see the note in src/app/dashboard/page.tsx.
    // These all share the single pooled connection this transaction holds.
    const checklist = await db
      .select()
      .from(documentRequests)
      .where(eq(documentRequests.clientId, id))
      .orderBy(asc(documentRequests.sortOrder));

    const files = await db
      .select()
      .from(documents)
      .where(eq(documents.clientId, id))
      .orderBy(desc(documents.createdAt));

    const thread = await db
      .select()
      .from(messages)
      .where(eq(messages.clientId, id))
      .orderBy(asc(messages.createdAt));

    const history = await db
      .select()
      .from(clientStageHistory)
      .where(eq(clientStageHistory.clientId, id))
      .orderBy(desc(clientStageHistory.createdAt));

    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.clientId, id))
      .orderBy(desc(agentRuns.createdAt))
      .limit(10);

    // Mark inbound messages read now that the broker is looking at them.
    await db
      .update(messages)
      .set({ readAt: new Date() })
      .where(eq(messages.clientId, id));

    return { client, checklist, files, thread, history, runs };
  });

  if (!data) notFound();

  const { client } = data;
  const stage = getStage(client.stageKey);
  const outstanding = data.checklist.filter(
    (item) => item.status === 'requested' || item.status === 'needs_attention',
  );

  return (
    <div className="min-h-dvh">
      <AppHeader appName={env.appName} userName={user.fullName} subtitle="Broker workspace" />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          href="/broker"
          className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
        >
          ← All clients
        </Link>

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{client.fullName}</h1>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">
              {client.email} · username <code className="font-mono">{client.username}</code> ·{' '}
              {client.applicationType}
            </p>
            {client.notes && (
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--color-ink-500)]">
                {client.notes}
              </p>
            )}
          </div>

          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-400)]">
              Current stage
            </p>
            <p className="text-sm font-semibold text-[var(--color-accent-700)]">{stage.label}</p>
          </div>
        </div>

        {!client.driveFolderId && (
          <div className="alert alert-warn mb-6">
            This client has no Google Drive folder, so uploads will fail. This usually means the
            Drive credentials were not working when they were created — check{' '}
            <code>/api/health?verbose=1</code>, then re-create the client or create the folder
            manually and set <code>drive_folder_id</code>.
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-6">
            <StageController
              clientId={client.id}
              currentStageKey={client.stageKey}
              history={data.history.map((entry) => ({
                stageKey: entry.stageKey,
                note: entry.note,
                createdAt: entry.createdAt.toISOString(),
              }))}
            />

            <DocumentReview
              clientId={client.id}
              checklist={data.checklist.map((item) => ({
                id: item.id,
                label: item.label,
                description: item.description,
                status: item.status,
                isRequired: item.isRequired,
                createdBy: item.createdBy,
              }))}
              documents={data.files.map((doc) => ({
                id: doc.id,
                fileName: doc.fileName,
                sizeBytes: doc.sizeBytes,
                status: doc.status,
                reviewNote: doc.reviewNote,
                requestId: doc.requestId,
                classifiedAs: doc.classifiedAs,
                createdAt: doc.createdAt.toISOString(),
              }))}
              outstandingCount={outstanding.length}
            />
          </div>

          <div className="space-y-6">
            <MessageThread
              clientId={client.id}
              viewerType="broker"
              brokerName={user.fullName}
              clientName={client.fullName}
              initialMessages={data.thread.map((message) => ({
                id: message.id,
                senderType: message.senderType,
                body: message.body,
                createdAt: message.createdAt.toISOString(),
              }))}
            />

            <AgentPanel
              clientId={client.id}
              runs={data.runs.map((run) => ({
                id: run.id,
                skillKey: run.skillKey,
                status: run.status,
                trigger: run.trigger,
                error: run.error,
                output: run.output,
                createdAt: run.createdAt.toISOString(),
                durationMs: run.durationMs,
              }))}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

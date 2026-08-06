/**
 * Document upload.
 *
 * The file goes straight to the client's Google Drive folder; only metadata is
 * written to Postgres. Nothing is persisted on the app server's disk, so a
 * compromised or ephemeral container holds no client documents.
 *
 * After a successful upload the `document.uploaded` trigger fires, which
 * queues classification. That is deliberately asynchronous — the client's
 * upload returns as soon as the bytes are safely in Drive.
 */

import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { asClient, asSystem } from '@/db';
import { clients, documentRequests, documents } from '@/db/schema';
import { dispatchTrigger } from '@/lib/agent';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { uploadToClientFolder } from '@/lib/drive/service';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
// Uploads over a phone connection are slow; the default 15s serverless budget
// is not enough for a 20 MB scan.
export const maxDuration = 120;

/**
 * Types the portal accepts. An allowlist rather than a blocklist: the risk is
 * a client uploading an executable or an HTML file that later gets served
 * back, and enumerating what is safe is the only version of that check which
 * does not rot.
 */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'client') {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Could not read the upload.' }, { status: 400 });
  }

  const file = form.get('file');
  const requestIdRaw = form.get('requestId');
  const requestId = typeof requestIdRaw === 'string' && requestIdRaw ? requestIdRaw : null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was included.' }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 });
  }

  if (file.size > env.maxUploadBytes) {
    const limitMb = Math.floor(env.maxUploadBytes / (1024 * 1024));
    return NextResponse.json(
      { error: `That file is larger than the ${limitMb} MB limit. Try splitting it up.` },
      { status: 413 },
    );
  }

  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      {
        error:
          'That file type is not accepted. Please upload a PDF, a photo (JPG/PNG/HEIC), or an Office document.',
      },
      { status: 415 },
    );
  }

  // The client's Drive folder id. Read under the client's own context so RLS
  // confirms the row is genuinely theirs.
  const client = await asClient(user.id, async (db) => {
    const [row] = await db
      .select({
        id: clients.id,
        fullName: clients.fullName,
        driveFolderId: clients.driveFolderId,
      })
      .from(clients)
      .where(eq(clients.id, user.id))
      .limit(1);
    return row;
  });

  if (!client) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

  if (!client.driveFolderId) {
    return NextResponse.json(
      {
        error:
          'Your document folder is not ready yet. Please message your broker — they can fix this in a moment.',
      },
      { status: 503 },
    );
  }

  // If a checklist item was named, confirm it belongs to this client before
  // linking. RLS would block a foreign row anyway; this turns a silent no-op
  // into a clear error.
  if (requestId) {
    const owned = await asClient(user.id, async (db) => {
      const [row] = await db
        .select({ id: documentRequests.id })
        .from(documentRequests)
        .where(and(eq(documentRequests.id, requestId), eq(documentRequests.clientId, user.id)))
        .limit(1);
      return Boolean(row);
    });

    if (!owned) {
      return NextResponse.json({ error: 'That checklist item was not found.' }, { status: 404 });
    }
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const checksum = createHash('sha256').update(buffer).digest('hex');

  let uploaded;
  try {
    uploaded = await uploadToClientFolder(client.driveFolderId, {
      name: file.name,
      mimeType: file.type,
      body: Readable.from(buffer),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[upload] Drive upload failed', { clientId: user.id, message });
    return NextResponse.json(
      { error: 'The upload could not be saved. Please try again in a moment.' },
      { status: 502 },
    );
  }

  const record = await asClient(user.id, async (db) => {
    const [row] = await db
      .insert(documents)
      .values({
        clientId: user.id,
        requestId,
        driveFileId: uploaded.fileId,
        fileName: uploaded.name,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes || file.size,
        checksumSha256: checksum,
        status: 'in_review',
        uploadedBy: 'client',
      })
      .returning();
    return row;
  });

  if (!record) {
    return NextResponse.json({ error: 'Upload saved but could not be recorded.' }, { status: 500 });
  }

  // Move the checklist item out of "requested", and queue classification.
  await asSystem(async (db) => {
    if (requestId) {
      await db
        .update(documentRequests)
        .set({ status: 'in_review', reviewNote: null, updatedAt: new Date() })
        .where(eq(documentRequests.id, requestId));
    }

    await recordAudit(db, {
      actorType: 'client',
      actorId: user.id,
      action: 'document.uploaded',
      targetType: 'document',
      targetId: record.id,
      clientId: user.id,
      metadata: { fileName: record.fileName, sizeBytes: record.sizeBytes },
    });

    const openRequests = await db
      .select({ id: documentRequests.id, label: documentRequests.label })
      .from(documentRequests)
      .where(
        and(eq(documentRequests.clientId, user.id), eq(documentRequests.status, 'requested')),
      );

    await dispatchTrigger(db, 'document.uploaded', {
      clientId: user.id,
      input: {
        clientId: user.id,
        documentId: record.id,
        driveFileId: record.driveFileId,
        fileName: record.fileName,
        mimeType: record.mimeType,
        openRequests,
      },
    });
  });

  return NextResponse.json({
    document: {
      id: record.id,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      status: record.status,
      requestId: record.requestId,
    },
  });
}

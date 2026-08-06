/**
 * Authenticated document download.
 *
 * This is the ONLY way to retrieve a stored file. There is no public Drive
 * link anywhere in the system: ownership is re-checked on every single
 * request, and the bytes are proxied through this route.
 *
 * Two defences stack here:
 *   1. The lookup runs under the requester's own RLS context, so a client
 *      asking for another client's document id gets zero rows — not a denial,
 *      an absence. The response is 404, which also avoids confirming that the
 *      id exists at all.
 *   2. `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff`
 *      means an uploaded HTML or SVG file can never execute in the portal's
 *      origin.
 */

import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';

import { asBroker, asClient, asSystem } from '@/db';
import { documents } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { downloadFile } from '@/lib/drive/service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * RFC 5987 encoding so filenames with accents or spaces survive the header.
 * The ASCII fallback keeps old clients working.
 */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { id } = await context.params;

  const document =
    user.kind === 'client'
      ? await asClient(user.id, async (db) => {
          const [row] = await db
            .select()
            .from(documents)
            .where(and(eq(documents.id, id), eq(documents.clientId, user.id)))
            .limit(1);
          return row;
        })
      : await asBroker(user.id, async (db) => {
          const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
          return row;
        });

  if (!document) return new Response('Not found', { status: 404 });

  let stream: Readable;
  try {
    stream = await downloadFile(document.driveFileId);
  } catch (error) {
    console.error('[download] Drive fetch failed', {
      documentId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response('The file could not be retrieved.', { status: 502 });
  }

  // Fire-and-forget: an audit failure must not block the download.
  void asSystem(async (db) => {
    await recordAudit(db, {
      actorType: user.kind,
      actorId: user.id,
      action: 'document.downloaded',
      targetType: 'document',
      targetId: document.id,
      clientId: document.clientId,
      metadata: { fileName: document.fileName },
    });
  });

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'Content-Type': document.mimeType || 'application/octet-stream',
      'Content-Disposition': contentDisposition(document.fileName),
      'Content-Length': String(document.sizeBytes),
      'X-Content-Type-Options': 'nosniff',
      // Never let a proxy or the browser cache a client's document.
      'Cache-Control': 'private, no-store, max-age=0',
    },
  });
}

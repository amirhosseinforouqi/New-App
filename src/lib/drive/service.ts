/**
 * Drive operations used by the portal.
 *
 * Every client gets one folder under the configured root, named
 * "Lastname, Firstname — <short id>". The short id disambiguates two clients
 * with the same name without making the folder unreadable to a human browsing
 * Drive, which is the whole reason for using Drive rather than a bucket.
 *
 * Nothing here ever produces a shareable link. Files are streamed back to the
 * browser through an authenticated route (src/app/api/documents/[id]/download)
 * which re-checks ownership on every request. Drive permissions are never
 * widened to "anyone with the link".
 */

import { Readable } from 'node:stream';
import type { drive_v3 } from 'googleapis';

import { driveIds, getDrive, sharedDriveParams } from './client';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Drive query strings are not parameterised, so escape user-derived values. */
function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Strip path separators and control characters from a filename.
 *
 * Drive itself tolerates slashes, but a name containing "../" that later gets
 * used to build a local path or a Content-Disposition header is a traversal
 * bug waiting to happen. Normalise once, at the boundary.
 */
export function sanitiseFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/\.{2,}/g, '.')
    .trim();

  return (cleaned || 'upload').slice(0, 200);
}

export function clientFolderName(fullName: string, clientId: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const shortId = clientId.slice(0, 8);

  if (parts.length < 2) {
    return sanitiseFileName(`${fullName.trim() || 'Client'} — ${shortId}`);
  }

  const last = parts[parts.length - 1]!;
  const rest = parts.slice(0, -1).join(' ');
  return sanitiseFileName(`${last}, ${rest} — ${shortId}`);
}

/**
 * Create (or find) the client's folder.
 *
 * Idempotent: a retried onboarding does not produce two folders. We search
 * before creating because Drive happily allows duplicate names in the same
 * parent.
 */
export async function ensureClientFolder(fullName: string, clientId: string): Promise<string> {
  const drive = getDrive();
  const { rootFolderId } = driveIds();
  const name = clientFolderName(fullName, clientId);

  const existing = await drive.files.list({
    q: [
      `name = '${escapeQuery(name)}'`,
      `'${escapeQuery(rootFolderId)}' in parents`,
      `mimeType = '${FOLDER_MIME}'`,
      'trashed = false',
    ].join(' and '),
    fields: 'files(id, name)',
    pageSize: 1,
    ...sharedDriveParams(),
  });

  const found = existing.data.files?.[0]?.id;
  if (found) return found;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [rootFolderId],
      description: `UWA client folder — client id ${clientId}`,
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  if (!created.data.id) {
    throw new Error(`Drive did not return an id when creating folder "${name}".`);
  }

  return created.data.id;
}

export interface UploadResult {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Stream an upload straight into the client's Drive folder.
 *
 * The body is a Node Readable so large files never buffer fully in memory and
 * never touch the app server's disk — Drive is the only place bytes come to
 * rest, which is what makes the storage story simple for PIPEDA purposes.
 */
export async function uploadToClientFolder(
  folderId: string,
  file: { name: string; mimeType: string; body: Readable | Buffer },
): Promise<UploadResult> {
  const drive = getDrive();
  const name = sanitiseFileName(file.name);

  const created = await drive.files.create({
    requestBody: {
      name,
      parents: [folderId],
    },
    media: {
      mimeType: file.mimeType || 'application/octet-stream',
      body: Buffer.isBuffer(file.body) ? Readable.from(file.body) : file.body,
    },
    fields: 'id, name, mimeType, size',
    supportsAllDrives: true,
  });

  if (!created.data.id) {
    throw new Error(`Drive did not return an id when uploading "${name}".`);
  }

  return {
    fileId: created.data.id,
    name: created.data.name ?? name,
    mimeType: created.data.mimeType ?? file.mimeType,
    sizeBytes: Number.parseInt(created.data.size ?? '0', 10),
  };
}

/** Metadata lookup, used to set download headers. */
export async function getFileMetadata(fileId: string): Promise<drive_v3.Schema$File> {
  const drive = getDrive();
  const response = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, parents, trashed',
    supportsAllDrives: true,
  });
  return response.data;
}

/**
 * Open a read stream for a file.
 *
 * The caller is responsible for having already verified that the requesting
 * user owns this document — this function trusts its input, so it must never
 * be reachable from a route that has not done that check.
 */
export async function downloadFile(fileId: string): Promise<Readable> {
  const drive = getDrive();
  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  return response.data as unknown as Readable;
}

/**
 * Move a file to the Drive trash.
 *
 * Trash rather than permanent delete, deliberately: a mis-click on a mortgage
 * file should be recoverable, and Drive keeps trashed items for 30 days.
 */
export async function trashFile(fileId: string): Promise<void> {
  const drive = getDrive();
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}

/**
 * Verify the Drive integration end to end. Called by the health endpoint and
 * worth running once after setup — it surfaces the two failure modes that
 * otherwise appear much later: wrong Shared Drive id, and a service account
 * that was never added as a member.
 */
export async function checkDriveAccess(): Promise<{ ok: boolean; detail: string }> {
  try {
    const drive = getDrive();
    const { sharedDriveId, rootFolderId } = driveIds();

    await drive.drives.get({ driveId: sharedDriveId, fields: 'id, name' });
    await drive.files.get({ fileId: rootFolderId, fields: 'id, name', supportsAllDrives: true });

    return { ok: true, detail: 'Shared Drive and root folder are reachable.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail:
        `${message}. Check that the service account email has been added as a ` +
        'Content manager on the Shared Drive — see docs/GOOGLE_DRIVE_SETUP.md.',
    };
  }
}

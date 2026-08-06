/**
 * Authenticated Google Drive client.
 *
 * Auth model: a service account added as a member of a Workspace Shared Drive.
 * This matters — a bare service account has no Drive storage quota of its own,
 * so uploading to its "My Drive" fails with a storage quota error. Putting the
 * files in a Shared Drive means the organisation owns them, quota comes from
 * the Workspace plan, and nothing breaks when an individual leaves.
 *
 * Every Drive call therefore passes `supportsAllDrives: true` and, where the
 * API accepts it, `driveId` + `corpora: 'drive'`. Omitting these is the usual
 * reason a Shared Drive integration returns "File not found" for files that
 * plainly exist.
 */

import { readFileSync } from 'node:fs';
import { google, type drive_v3 } from 'googleapis';

import { driveConfig } from '@/lib/env';

/**
 * `drive.file` would be tighter, but it only grants access to files the app
 * itself created — which breaks the broker's ability to see documents they
 * added directly in the Drive UI. `drive` scope on a dedicated Shared Drive
 * that contains nothing else is the right trade here.
 */
const SCOPES = ['https://www.googleapis.com/auth/drive'];

let cached: drive_v3.Drive | undefined;

function loadCredentials(): { client_email: string; private_key: string } {
  const config = driveConfig();

  const raw = config.inlineJson
    ? Buffer.from(config.inlineJson, 'base64').toString('utf8')
    : readFileSync(config.keyFile, 'utf8');

  const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string };

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      'Google service account key is missing client_email or private_key. ' +
        'Make sure you downloaded the JSON key (not the P12) from the service account.',
    );
  }

  return {
    client_email: parsed.client_email,
    // Keys pasted through env vars arrive with literal "\n" instead of real
    // newlines; the JWT signer rejects those with an opaque error.
    private_key: parsed.private_key.replace(/\\n/g, '\n'),
  };
}

export function getDrive(): drive_v3.Drive {
  if (cached) return cached;

  const credentials = loadCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
  });

  cached = google.drive({ version: 'v3', auth });
  return cached;
}

/** Shared arguments every Shared Drive call needs. */
export function sharedDriveParams() {
  const config = driveConfig();
  return {
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    driveId: config.sharedDriveId,
    corpora: 'drive' as const,
  };
}

export function driveIds() {
  const config = driveConfig();
  return {
    sharedDriveId: config.sharedDriveId,
    // Falling back to the Shared Drive id is correct: the drive's root folder
    // has the same id as the drive itself.
    rootFolderId: config.rootFolderId || config.sharedDriveId,
  };
}

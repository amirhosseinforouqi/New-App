/**
 * Centralised, fail-fast environment configuration.
 *
 * Every process (web server, mail worker, agent worker) imports from here.
 * Missing required values throw at import time with a message naming the
 * variable — a misconfigured deployment fails at boot rather than at 2am when
 * a client tries to upload a document.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for what it should contain.`,
    );
  }
  return value;
}

export function optional(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function intVar(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}".`);
  }
  return parsed;
}

function boolVar(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Values every process needs.
 *
 * Defined as getters rather than a plain object so that *importing* this module
 * costs nothing and validates nothing. Only reading a field can throw.
 *
 * This matters beyond tidiness: `sanitiseFileName` lives two imports away from
 * `driveConfig`, and with eager evaluation a unit test — or any module wanting
 * one pure helper — would fail on a missing DATABASE_URL it never uses.
 * Validation still happens on first real read, which for a server is during
 * boot.
 */
export const env = {
  get appUrl(): string {
    return optional('APP_URL', 'http://localhost:3000').replace(/\/$/, '');
  },
  get appName(): string {
    return optional('APP_NAME', 'UWA Mortgage Portal');
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  get databaseSsl(): boolean {
    return optional('DATABASE_SSL', 'disable') !== 'disable';
  },
  get maxUploadBytes(): number {
    return intVar('MAX_UPLOAD_BYTES', 25 * 1024 * 1024);
  },
};

/**
 * Session secret, read lazily so that tooling which only needs the database
 * (migrations, seeds) does not have to supply it.
 */
export function sessionSecret(): string {
  const secret = required('SESSION_SECRET');
  if (Buffer.from(secret, 'base64').length < 32) {
    throw new Error(
      'SESSION_SECRET must decode to at least 32 bytes. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"',
    );
  }
  return secret;
}

export function smtpConfig() {
  return {
    host: required('SMTP_HOST'),
    port: intVar('SMTP_PORT', 465),
    secure: boolVar('SMTP_SECURE', true),
    user: required('SMTP_USER'),
    password: required('SMTP_PASSWORD'),
    fromName: optional('MAIL_FROM_NAME', env.appName),
    fromAddress: required('MAIL_FROM_ADDRESS'),
    replyTo: optional('MAIL_REPLY_TO', ''),
  };
}

export function imapConfig() {
  return {
    host: required('IMAP_HOST'),
    port: intVar('IMAP_PORT', 993),
    secure: boolVar('IMAP_SECURE', true),
    user: required('IMAP_USER'),
    password: required('IMAP_PASSWORD'),
    mailbox: optional('IMAP_MAILBOX', 'INBOX'),
    processedFolder: optional('IMAP_PROCESSED_FOLDER', 'UWA/Processed'),
    pollIntervalSeconds: intVar('IMAP_POLL_INTERVAL', 60),
    ignoreList: optional('INBOUND_IGNORE_LIST', 'no-reply@,noreply@,mailer-daemon@,postmaster@')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  };
}

export function driveConfig() {
  const keyFile = optional('GOOGLE_SERVICE_ACCOUNT_KEY_FILE');
  const inlineJson = optional('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!keyFile && !inlineJson) {
    throw new Error(
      'Google Drive is not configured. Set either GOOGLE_SERVICE_ACCOUNT_KEY_FILE ' +
        '(path to the JSON key) or GOOGLE_SERVICE_ACCOUNT_JSON (base64 of the same file). ' +
        'See docs/GOOGLE_DRIVE_SETUP.md.',
    );
  }
  return {
    keyFile,
    inlineJson,
    sharedDriveId: required('GOOGLE_SHARED_DRIVE_ID'),
    rootFolderId: optional('GOOGLE_DRIVE_ROOT_FOLDER_ID'),
  };
}

export function anthropicConfig() {
  return {
    apiKey: required('ANTHROPIC_API_KEY'),
    // Opus 5 is the default: mortgage document classification and income
    // verification are exactly the kind of careful, high-stakes reading where
    // the capability difference shows up. Override per deployment if needed.
    model: optional('ANTHROPIC_MODEL', 'claude-opus-5'),
    effort: optional('ANTHROPIC_EFFORT', 'high'),
  };
}

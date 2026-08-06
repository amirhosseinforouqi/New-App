/**
 * Inbound mail worker.
 *
 * Long-lived process. Connects to the broker's mailbox, uses IMAP IDLE where
 * the server supports it (so new mail is handled within seconds rather than at
 * the next poll), and falls back to interval polling otherwise.
 *
 * Run with:  npm run worker:mail
 */

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { eq } from 'drizzle-orm';

import { asSystem } from '@/db';
import { brokers } from '@/db/schema';
import { imapConfig } from '@/lib/env';
import { processInboundMessage } from '@/lib/mail/inbound';
import '@/lib/agent';

let shuttingDown = false;

/** The name that signs credential emails. Falls back if no broker exists yet. */
async function primaryBrokerName(): Promise<string> {
  return asSystem(async (db) => {
    const [broker] = await db
      .select({ fullName: brokers.fullName })
      .from(brokers)
      .where(eq(brokers.isActive, true))
      .limit(1);
    return broker?.fullName ?? 'Your mortgage broker';
  });
}

async function ensureProcessedFolder(client: ImapFlow, path: string): Promise<boolean> {
  try {
    const list = await client.list();
    if (list.some((box) => box.path === path)) return true;
    await client.mailboxCreate(path);
    return true;
  } catch (error) {
    console.warn(
      `[mail-worker] Could not create folder "${path}": ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Processed messages will be marked seen but left in place.',
    );
    return false;
  }
}

async function drainUnseen(client: ImapFlow, brokerName: string, processedFolder: string | null) {
  const uids = await client.search({ seen: false });
  if (!uids || uids.length === 0) return;

  console.info(`[mail-worker] ${uids.length} unseen message(s)`);

  for (const uid of uids) {
    if (shuttingDown) return;

    try {
      const downloaded = await client.download(String(uid), undefined, { uid: true });
      if (!downloaded?.content) continue;

      const mail = await simpleParser(downloaded.content);
      const result = await processInboundMessage(mail, brokerName);

      console.info('[mail-worker] processed', {
        uid,
        from: mail.from?.value?.[0]?.address,
        outcome: result.outcome,
        detail: result.detail,
      });

      // Mark seen regardless of outcome — the inbound_emails ledger is the
      // real dedupe mechanism, and leaving a poison message unseen would make
      // the worker retry it forever.
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });

      if (processedFolder && result.outcome !== 'error') {
        await client.messageMove(String(uid), processedFolder, { uid: true });
      }
    } catch (error) {
      console.error('[mail-worker] failed to handle message', {
        uid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function main() {
  const config = imapConfig();
  const brokerName = await primaryBrokerName();

  console.info(`[mail-worker] starting — watching ${config.user} (${config.mailbox})`);

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });

  client.on('error', (error) => {
    console.error('[mail-worker] IMAP error', error instanceof Error ? error.message : error);
  });

  await client.connect();

  const processedFolder = (await ensureProcessedFolder(client, config.processedFolder))
    ? config.processedFolder
    : null;

  const lock = await client.getMailboxLock(config.mailbox);
  try {
    await drainUnseen(client, brokerName, processedFolder);
  } finally {
    lock.release();
  }

  // New-mail notifications. `exists` fires on delivery when IDLE is active.
  client.on('exists', () => {
    void (async () => {
      if (shuttingDown) return;
      const innerLock = await client.getMailboxLock(config.mailbox);
      try {
        await drainUnseen(client, brokerName, processedFolder);
      } catch (error) {
        console.error('[mail-worker] drain failed', error);
      } finally {
        innerLock.release();
      }
    })();
  });

  // Safety net: some servers drop IDLE silently. A slow poll costs nothing and
  // means a missed notification delays a client by a minute, not forever.
  const interval = setInterval(
    () => {
      void (async () => {
        if (shuttingDown) return;
        try {
          const innerLock = await client.getMailboxLock(config.mailbox);
          try {
            await drainUnseen(client, brokerName, processedFolder);
          } finally {
            innerLock.release();
          }
        } catch (error) {
          console.error('[mail-worker] poll failed', error);
        }
      })();
    },
    Math.max(30, config.pollIntervalSeconds) * 1000,
  );

  const shutdown = async (signal: string) => {
    console.info(`[mail-worker] ${signal} received, shutting down`);
    shuttingDown = true;
    clearInterval(interval);
    await client.logout().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.info('[mail-worker] ready');
}

main().catch((error) => {
  console.error('[mail-worker] fatal', error);
  process.exit(1);
});

/**
 * Populate the database with a realistic demo file, for previewing the portal
 * without Google Drive, SMTP or an Anthropic key configured.
 *
 *   npm run db:demo
 *
 * Creates one broker and two clients at different pipeline stages, with a
 * checklist, document records, message history and stage history — so the
 * dashboard, broker list and client detail pages all render as they would in
 * use rather than as empty states.
 *
 * Documents are metadata-only: there are no bytes in Drive behind them, so the
 * download links will 502. Everything else behaves normally.
 *
 * Safe to re-run — it deletes its own demo rows first. It refuses to run when
 * NODE_ENV=production, because seeding known passwords into a live brokerage
 * database would be a very bad afternoon.
 */

import 'dotenv/config';
import pg from 'pg';

import { hashPassword } from '../src/lib/auth/password';

const DEMO_BROKER = 'demo.broker@example.test';
const DEMO_PASSWORD = 'demo-portal-2026';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      'Refusing to run: NODE_ENV=production.\n' +
        'This script inserts accounts with a known, published password.',
    );
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    console.error('Set DATABASE_MIGRATION_URL (the owner role) before running the demo seed.');
    process.exit(1);
  }

  const db = new pg.Client({ connectionString });
  await db.connect();

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  try {
    await db.query('BEGIN');

    // Idempotent: clear previous demo data before re-seeding.
    await db.query(`DELETE FROM clients WHERE email LIKE '%@example.test'`);
    await db.query(`DELETE FROM brokers WHERE email = $1`, [DEMO_BROKER]);

    const broker = await db.query<{ id: string }>(
      `INSERT INTO brokers (email, full_name, password_hash)
       VALUES ($1, 'Amir Foroughi', $2) RETURNING id`,
      [DEMO_BROKER, passwordHash],
    );
    const brokerId = broker.rows[0]!.id;

    // ── Client 1: mid-file, documents outstanding, one flagged ──────────────
    const priya = await db.query<{ id: string }>(
      `INSERT INTO clients
         (email, full_name, username, password_hash, status, application_type,
          stage_key, drive_folder_id, phone, notes, broker_id, must_change_password)
       VALUES ($1, 'Priya Ramanathan', 'pramanathan', $2, 'active', 'purchase',
               'under_review', 'demo-folder-priya', '(416) 555-0142',
               'Salaried, 6 years at current employer. Co-applicant on maternity leave.',
               $3, false)
       RETURNING id`,
      ['priya@example.test', passwordHash, brokerId],
    );
    const priyaId = priya.rows[0]!.id;

    const stages: Array<[string, string, number]> = [
      ['inquiry', 'Created from inbound email.', 21],
      ['documents_received', 'Core documents in. Thanks Priya!', 12],
      ['under_review', 'Submitted to the lender for assessment.', 4],
    ];
    for (const [key, note, daysAgo] of stages) {
      await db.query(
        `INSERT INTO client_stage_history (client_id, stage_key, note, advanced_by, created_at)
         VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval)`,
        [priyaId, key, note, brokerId, String(daysAgo)],
      );
    }

    const checklist: Array<[string, string, string, string, boolean]> = [
      ['Government-issued photo ID', 'Driver’s licence or passport — both sides, unexpired.', 'identity', 'approved', true],
      ['2024 Notice of Assessment', 'All pages, exactly as issued by the CRA.', 'income', 'approved', true],
      ['2024 T4', 'From your current employer.', 'income', 'approved', true],
      ['Recent pay stubs', 'Your two most recent, showing year-to-date earnings.', 'income', 'needs_attention', true],
      ['Letter of employment', 'On company letterhead, dated within 30 days, stating position, start date and salary.', 'employment', 'in_review', true],
      ['90 days of bank statements', 'All pages for every account holding your down payment.', 'assets', 'requested', true],
      ['Agreement of Purchase and Sale', 'The fully signed copy including all schedules and waivers.', 'property', 'requested', true],
      ['Gift letter', 'Only if any part of your down payment is a gift from family.', 'assets', 'requested', false],
    ];

    const requestIds: string[] = [];
    for (const [index, [label, description, category, status, required]] of checklist.entries()) {
      const row = await db.query<{ id: string }>(
        `INSERT INTO document_requests
           (client_id, label, description, category, is_required, status, created_by, sort_order,
            review_note)
         VALUES ($1, $2, $3, $4, $5, $6, 'agent', $7, $8) RETURNING id`,
        [
          priyaId,
          label,
          description,
          category,
          required,
          status,
          index,
          status === 'needs_attention'
            ? 'The right edge is cut off on the second stub — could you re-photograph it with all four corners in frame?'
            : null,
        ],
      );
      requestIds.push(row.rows[0]!.id);
    }

    const documents: Array<[number, string, string, string, string | null, string | null]> = [
      [0, 'drivers-licence-front-back.pdf', 'application/pdf', 'approved', 'Ontario Driver’s Licence', null],
      [1, '2024-notice-of-assessment.pdf', 'application/pdf', 'approved', '2024 Notice of Assessment', null],
      [2, 'T4-2024-northwind.pdf', 'application/pdf', 'approved', '2024 T4 Statement of Remuneration Paid', null],
      [3, 'paystub-jan-2026.jpg', 'image/jpeg', 'needs_attention', 'Pay stub', 'Right edge of the page is cropped; year-to-date column is not fully readable.'],
      [4, 'letter-of-employment.pdf', 'application/pdf', 'in_review', 'Letter of Employment', null],
    ];

    for (const [requestIndex, fileName, mime, status, classifiedAs, reviewNote] of documents) {
      await db.query(
        `INSERT INTO documents
           (client_id, request_id, drive_file_id, file_name, mime_type, size_bytes,
            status, classified_as, review_note, uploaded_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'client', now() - ($10 || ' days')::interval)`,
        [
          priyaId,
          requestIds[requestIndex],
          `demo-drive-${fileName}`,
          fileName,
          mime,
          420_000 + requestIndex * 180_000,
          status,
          classifiedAs,
          reviewNote,
          String(14 - requestIndex * 2),
        ],
      );
    }

    const thread: Array<[string, string, number]> = [
      ['client', 'Hi — my partner and I are looking at a place in Leslieville and would like to get pre-approved. What do you need from us?', 21],
      ['broker', 'Great to hear from you, Priya. I’ve set up your portal — your document list is in there. Start with ID and your NOA and we’ll go from there.', 21],
      ['client', 'Uploaded the ID, NOA and T4. Working on the bank statements this weekend.', 13],
      ['broker', 'Perfect, those all look good. One thing — the second pay stub is cropped on the right. Could you retake it with all four corners in frame?', 6],
      ['client', 'Ah sorry about that. Will redo it tonight. Any idea how long the review usually takes?', 4],
      ['broker', 'No problem at all. Usually 2–3 business days once the lender has everything. I’ll message you the moment I hear back.', 4],
    ];

    for (const [sender, body, daysAgo] of thread) {
      await db.query(
        `INSERT INTO messages (client_id, sender_type, sender_id, body, created_at, read_at)
         VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval, now())`,
        [priyaId, sender, sender === 'broker' ? brokerId : priyaId, body, String(daysAgo)],
      );
    }

    await db.query(
      `INSERT INTO agent_runs
         (client_id, skill_key, trigger, status, input, output, duration_ms, created_at, completed_at)
       VALUES
         ($1, 'checklist.generate', 'client.created', 'succeeded', $2, $3, 8420,
          now() - interval '21 days', now() - interval '21 days'),
         ($1, 'document.classify', 'document.uploaded', 'succeeded', $4, $5, 5130,
          now() - interval '8 days', now() - interval '8 days')`,
      [
        priyaId,
        JSON.stringify({ clientId: priyaId, applicationType: 'purchase' }),
        JSON.stringify({
          items: checklist.map(([label]) => ({ label })),
          rationale:
            'Salaried purchase with a co-applicant. Standard income set plus the APS; gift letter marked conditional pending confirmation of down payment source.',
        }),
        JSON.stringify({ documentId: 'demo', fileName: 'paystub-jan-2026.jpg' }),
        JSON.stringify({
          documentType: 'Pay stub',
          category: 'income',
          confidence: 'high',
          taxYear: null,
          subjectName: 'Priya Ramanathan',
          matchedRequestId: requestIds[3],
          legibilityIssue:
            'Right edge of the page is cropped; year-to-date column is not fully readable.',
          summary: 'January 2026 pay stub, cropped on the right edge.',
        }),
      ],
    );

    // ── Client 2: brand new, nothing uploaded yet ───────────────────────────
    const marcus = await db.query<{ id: string }>(
      `INSERT INTO clients
         (email, full_name, username, password_hash, status, application_type,
          stage_key, drive_folder_id, notes, broker_id, must_change_password)
       VALUES ($1, 'Marcus Delacroix-Webb', 'mdelacroixwebb', $2, 'invited', 'refinance',
               'inquiry', 'demo-folder-marcus',
               'Self-employed, incorporated 2019. Refinancing to consolidate.', $3, true)
       RETURNING id`,
      ['marcus@example.test', passwordHash, brokerId],
    );
    const marcusId = marcus.rows[0]!.id;

    await db.query(
      `INSERT INTO client_stage_history (client_id, stage_key, note, created_at)
       VALUES ($1, 'inquiry', 'Created from inbound email.', now() - interval '2 days')`,
      [marcusId],
    );

    const refinanceChecklist: Array<[string, string, string]> = [
      ['Government-issued photo ID', 'Driver’s licence or passport — both sides, unexpired.', 'identity'],
      ['2023 and 2024 T1 Generals', 'Complete returns, all schedules included.', 'income'],
      ['2023 and 2024 Notices of Assessment', 'All pages, as issued by the CRA.', 'income'],
      ['2024 T2 corporate return', 'Including financial statements.', 'income'],
      ['Articles of Incorporation', 'The full registered copy.', 'employment'],
      ['Current mortgage statement', 'Showing balance, rate and maturity date.', 'liabilities'],
      ['Property tax bill', 'Most recent, showing the annual amount.', 'property'],
    ];

    for (const [index, [label, description, category]] of refinanceChecklist.entries()) {
      await db.query(
        `INSERT INTO document_requests
           (client_id, label, description, category, is_required, status, created_by, sort_order)
         VALUES ($1, $2, $3, $4, true, 'requested', 'agent', $5)`,
        [marcusId, label, description, category, index],
      );
    }

    await db.query(
      `INSERT INTO messages (client_id, sender_type, sender_id, body, created_at)
       VALUES ($1, 'client', $1, $2, now() - interval '2 days')`,
      [
        marcusId,
        '**Refinance enquiry**\n\nHi, I’d like to look at refinancing to consolidate some debt. I’m self-employed through my own corporation. What do you need?',
      ],
    );

    await db.query('COMMIT');

    console.info(`
  Demo data seeded.

    Broker   ${DEMO_BROKER}
    Clients  pramanathan  (mid-file, documents to review)
             mdelacroixwebb  (new enquiry, nothing uploaded)

    Password for all three: ${DEMO_PASSWORD}

  Note: document records have no bytes behind them in Drive, so download
  links will fail. Everything else works.
`);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('[demo-seed] error:', error instanceof Error ? error.message : error);
  process.exit(1);
});

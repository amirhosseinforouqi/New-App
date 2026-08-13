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

    // The deal: a purchase in Leslieville, comfortably inside GDS/TDS with 20%+
    // down (no default insurance to explain), locked because it is genuinely
    // with the lender — a live demonstration of the application-lock feature.
    const priyaDeal = await db.query<{ id: string }>(
      `INSERT INTO deals
         (client_id, reference, deal_type, stage_key, status, assigned_to,
          locked_at, locked_by, property_address, property_city, property_province,
          property_type, occupancy, purchase_price, property_value, down_payment,
          mortgage_amount, interest_rate, amortization_years, payment_frequency,
          annual_property_tax, monthly_heat, lead_source)
       VALUES ($1, next_deal_reference(), 'purchase', 'under_review', 'active', $2,
               now() - interval '3 days', $2, '184 Ashdale Ave', 'Toronto', 'ON',
               'semi_detached', 'owner_occupied', 850000, 850000, 250000,
               600000, 4.89, 25, 'monthly',
               5100, 110, 'inbound_email')
       RETURNING id`,
      [priyaId, brokerId],
    );
    const priyaDealId = priyaDeal.rows[0]!.id;

    await db.query(
      `INSERT INTO deal_borrowers (deal_id, client_id, role, accepted_at)
       VALUES ($1, $2, 'primary', now() - interval '21 days')`,
      [priyaDealId, priyaId],
    );

    await db.query(
      `INSERT INTO borrower_incomes
         (deal_id, client_id, employment_type, employer_name, years_at_job, annual_income, is_primary)
       VALUES ($1, $2, 'salaried', 'Northwind Logistics Inc.', 6, 155000, true)`,
      [priyaDealId, priyaId],
    );

    await db.query(
      `INSERT INTO borrower_liabilities
         (deal_id, client_id, liability_type, description, monthly_payment, include_in_tds, source)
       VALUES ($1, $2, 'auto', 'Car lease', 340, true, 'client')`,
      [priyaDealId, priyaId],
    );

    const stages: Array<[string, string, number]> = [
      ['inquiry', 'Created from inbound email.', 21],
      ['documents_received', 'Core documents in. Thanks Priya!', 12],
      ['under_review', 'Submitted to the lender for assessment.', 4],
    ];
    for (const [key, note, daysAgo] of stages) {
      await db.query(
        `INSERT INTO client_stage_history (client_id, deal_id, stage_key, note, advanced_by, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval)`,
        [priyaId, priyaDealId, key, note, brokerId, String(daysAgo)],
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
           (client_id, deal_id, label, description, category, is_required, status, created_by,
            sort_order, review_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'agent', $8, $9) RETURNING id`,
        [
          priyaId,
          priyaDealId,
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
           (client_id, deal_id, request_id, drive_file_id, file_name, mime_type, size_bytes,
            status, classified_as, review_note, uploaded_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'client', now() - ($11 || ' days')::interval)`,
        [
          priyaId,
          priyaDealId,
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
        `INSERT INTO messages (client_id, deal_id, sender_type, sender_id, body, created_at, read_at)
         VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval, now())`,
        [priyaId, priyaDealId, sender, sender === 'broker' ? brokerId : priyaId, body, String(daysAgo)],
      );
    }

    await db.query(
      `INSERT INTO agent_runs
         (client_id, deal_id, skill_key, trigger, status, input, output, duration_ms, created_at, completed_at)
       VALUES
         ($1, $2, 'checklist.generate', 'client.created', 'succeeded', $3, $4, 8420,
          now() - interval '21 days', now() - interval '21 days'),
         ($1, $2, 'document.classify', 'document.uploaded', 'succeeded', $5, $6, 5130,
          now() - interval '8 days', now() - interval '8 days')`,
      [
        priyaId,
        priyaDealId,
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

    // A refinance with a maturity date inside the renewal window, self-employed
    // income across two years, and enough consumer debt that the payout-on-
    // closing flag visibly changes TDS on the deal page.
    const marcusDeal = await db.query<{ id: string }>(
      `INSERT INTO deals
         (client_id, reference, deal_type, stage_key, status, assigned_to,
          property_address, property_city, property_province, property_type, occupancy,
          property_value, mortgage_amount, interest_rate, amortization_years,
          payment_frequency, annual_property_tax, monthly_heat,
          existing_balance, existing_lender, maturity_date, lead_source, notes)
       VALUES ($1, next_deal_reference(), 'refinance', 'inquiry', 'active', $2,
               '77 Rue Sainte-Catherine', 'Gatineau', 'QC', 'detached', 'owner_occupied',
               620000, 410000, 5.44, 25,
               'accelerated_biweekly', 4200, 145,
               338000, 'Desjardins', (current_date + interval '4 months')::date,
               'inbound_email',
               'Consolidating a line of credit and two cards into the new mortgage.')
       RETURNING id`,
      [marcusId, brokerId],
    );
    const marcusDealId = marcusDeal.rows[0]!.id;

    await db.query(
      `INSERT INTO deal_borrowers (deal_id, client_id, role)
       VALUES ($1, $2, 'primary')`,
      [marcusDealId, marcusId],
    );

    await db.query(
      `INSERT INTO borrower_incomes
         (deal_id, client_id, employment_type, employer_name, years_at_job,
          annual_income, prior_year_income, is_primary)
       VALUES ($1, $2, 'self_employed', 'Delacroix-Webb Design Inc.', 7, 142000, 118000, true)`,
      [marcusDealId, marcusId],
    );

    // The line of credit and cards are being paid out on closing — that is the
    // point of the refinance — so they must not count against TDS.
    const marcusLiabilities: Array<[string, string, number, boolean]> = [
      ['line_of_credit', 'Line of credit', 520, true],
      ['credit_card', 'Credit cards', 310, true],
      ['auto', 'Car loan', 465, false],
    ];
    for (const [type, description, monthly, payout] of marcusLiabilities) {
      await db.query(
        `INSERT INTO borrower_liabilities
           (deal_id, client_id, liability_type, description, monthly_payment,
            include_in_tds, payout_on_closing, source)
         VALUES ($1, $2, $3, $4, $5, true, $6, 'client')`,
        [marcusDealId, marcusId, type, description, monthly, payout],
      );
    }

    await db.query(
      `INSERT INTO client_stage_history (client_id, deal_id, stage_key, note, created_at)
       VALUES ($1, $2, 'inquiry', 'Created from inbound email.', now() - interval '2 days')`,
      [marcusId, marcusDealId],
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
           (client_id, deal_id, label, description, category, is_required, status, created_by,
            sort_order)
         VALUES ($1, $2, $3, $4, $5, true, 'requested', 'agent', $6)`,
        [marcusId, marcusDealId, label, description, category, index],
      );
    }

    await db.query(
      `INSERT INTO messages (client_id, deal_id, sender_type, sender_id, body, created_at)
       VALUES ($1, $2, 'client', $1, $3, now() - interval '2 days')`,
      [
        marcusId,
        marcusDealId,
        '**Refinance enquiry**\n\nHi, I’d like to look at refinancing to consolidate some debt. I’m self-employed through my own corporation. What do you need?',
      ],
    );

    // ── Client 3: a couple, two independent logins on one deal ──────────────
    // The co-borrower case is the one most worth seeing on the board and on
    // the deal page: two names, two usernames, and income attributed to each
    // borrower separately rather than pooled into one row.
    const couple: Array<[string, string, string, string]> = [
      ['dana@example.test', 'Dana Okonkwo', 'dokonkwo', 'primary'],
      ['samir@example.test', 'Samir Okonkwo', 'sokonkwo', 'spouse'],
    ];

    const coupleIds: string[] = [];
    for (const [email, fullName, username] of couple) {
      const row = await db.query<{ id: string }>(
        `INSERT INTO clients
           (email, full_name, username, password_hash, status, application_type,
            stage_key, drive_folder_id, broker_id, must_change_password)
         VALUES ($1, $2, $3, $4, 'active', 'purchase', 'conditional_approval',
                 $5, $6, false)
         RETURNING id`,
        [email, fullName, username, passwordHash, `demo-folder-${username}`, brokerId],
      );
      coupleIds.push(row.rows[0]!.id);
    }

    const coupleDeal = await db.query<{ id: string }>(
      `INSERT INTO deals
         (client_id, reference, deal_type, stage_key, status, assigned_to,
          property_address, property_city, property_province, property_type, occupancy,
          purchase_price, property_value, down_payment, mortgage_amount,
          interest_rate, amortization_years, payment_frequency,
          annual_property_tax, monthly_heat, monthly_condo_fees,
          lead_source, referral_code)
       VALUES ($1, next_deal_reference(), 'purchase', 'conditional_approval', 'active', $2,
               '2201–88 Blue Jays Way', 'Toronto', 'ON', 'condo', 'owner_occupied',
               735000, 735000, 74000, 667400,
               4.74, 30, 'accelerated_biweekly',
               4400, 0, 685,
               'intake_form', 'REALTOR-JB')
       RETURNING id`,
      [coupleIds[0], brokerId],
    );
    const coupleDealId = coupleDeal.rows[0]!.id;

    for (const [index, [, , , role]] of couple.entries()) {
      await db.query(
        `INSERT INTO deal_borrowers (deal_id, client_id, role, accepted_at)
         VALUES ($1, $2, $3, now() - interval '30 days')`,
        [coupleDealId, coupleIds[index], role],
      );
    }

    const coupleIncomes: Array<[number, string, string, number]> = [
      [0, 'salaried', 'Toronto District School Board', 96000],
      [1, 'commission', 'Rideau Financial Group', 88000],
    ];
    for (const [index, employmentType, employer, amount] of coupleIncomes) {
      await db.query(
        `INSERT INTO borrower_incomes
           (deal_id, client_id, employment_type, employer_name, years_at_job,
            annual_income, prior_year_income, is_primary)
         VALUES ($1, $2, $3, $4, 4, $5, $6, $7)`,
        [
          coupleDealId,
          coupleIds[index],
          employmentType,
          employer,
          amount,
          // Commission income is averaged over two years; salary is not.
          employmentType === 'commission' ? 79000 : null,
          index === 0,
        ],
      );
    }

    await db.query(
      `INSERT INTO borrower_liabilities
         (deal_id, client_id, liability_type, description, monthly_payment, include_in_tds, source)
       VALUES ($1, $2, 'student_loan', 'Student loan', 280, true, 'client')`,
      [coupleDealId, coupleIds[0]],
    );

    const coupleStages: Array<[string, string, number]> = [
      ['inquiry', 'Submitted through the online application.', 34],
      ['documents_received', 'Everything in on the first pass.', 26],
      ['under_review', 'With the lender.', 15],
      ['conditional_approval', 'Approved subject to appraisal and confirmation of down payment.', 6],
    ];
    for (const [key, note, daysAgo] of coupleStages) {
      await db.query(
        `INSERT INTO client_stage_history (client_id, deal_id, stage_key, note, advanced_by, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval)`,
        [coupleIds[0], coupleDealId, key, note, brokerId, String(daysAgo)],
      );
    }

    await db.query(
      `INSERT INTO document_requests
         (client_id, deal_id, label, description, category, is_required, status, created_by, sort_order)
       VALUES
         ($1, $2, 'Appraisal', 'Ordered by the lender — nothing needed from you.', 'property', true, 'requested', 'broker', 0),
         ($1, $2, 'Confirmation of down payment', '90 days of statements for the account holding the funds.', 'assets', true, 'requested', 'broker', 1)`,
      [coupleIds[0], coupleDealId],
    );

    await db.query(
      `INSERT INTO messages (client_id, deal_id, sender_type, sender_id, body, created_at, read_at)
       VALUES
         ($1, $3, 'broker', $2, 'Good news — conditional approval came through this morning. Two conditions: the appraisal (the lender orders that, nothing for you to do) and confirmation of the down payment.', now() - interval '6 days', now()),
         ($1, $3, 'client', $1, 'That is such a relief, thank you! I will get the statements over tonight.', now() - interval '5 days', NULL)`,
      [coupleIds[0], brokerId, coupleDealId],
    );

    // ── A funded deal, so the board's last column is not permanently empty ──
    const closedClient = await db.query<{ id: string }>(
      `INSERT INTO clients
         (email, full_name, username, password_hash, status, application_type,
          stage_key, drive_folder_id, broker_id, must_change_password)
       VALUES ('elena@example.test', 'Elena Vasquez', 'evasquez', $1, 'active', 'renewal',
               'funded', 'demo-folder-evasquez', $2, false)
       RETURNING id`,
      [passwordHash, brokerId],
    );
    const closedId = closedClient.rows[0]!.id;

    const closedDeal = await db.query<{ id: string }>(
      `INSERT INTO deals
         (client_id, reference, deal_type, stage_key, status, assigned_to,
          property_city, property_province, property_type, occupancy,
          property_value, mortgage_amount, interest_rate, amortization_years,
          annual_property_tax, monthly_heat,
          existing_balance, existing_lender, maturity_date,
          lead_source, funded_at)
       VALUES ($1, next_deal_reference(), 'renewal', 'funded', 'funded', $2,
               'Hamilton', 'ON', 'detached', 'owner_occupied',
               540000, 289000, 4.59, 20,
               3900, 130,
               289000, 'Scotiabank', (current_date + interval '5 years')::date,
               'referral', now() - interval '9 days')
       RETURNING id`,
      [closedId, brokerId],
    );
    const closedDealId = closedDeal.rows[0]!.id;

    await db.query(
      `INSERT INTO deal_borrowers (deal_id, client_id, role, accepted_at)
       VALUES ($1, $2, 'primary', now() - interval '70 days')`,
      [closedDealId, closedId],
    );

    await db.query(
      `INSERT INTO borrower_incomes
         (deal_id, client_id, employment_type, employer_name, years_at_job, annual_income, is_primary)
       VALUES ($1, $2, 'salaried', 'Hamilton Health Sciences', 11, 104000, true)`,
      [closedDealId, closedId],
    );

    await db.query(
      `INSERT INTO client_stage_history (client_id, deal_id, stage_key, note, advanced_by, created_at)
       VALUES ($1, $2, 'funded', 'Renewal completed at 4.59% for a five-year fixed.', $3,
               now() - interval '9 days')`,
      [closedId, closedDealId, brokerId],
    );

    // ── Lender products ──────────────────────────────────────────────────────
    // A small, deliberately varied table so the matching engine has something
    // to rank AND something to reject — a demo where every product fits shows
    // none of the actual behaviour.
    await db.query(`DELETE FROM lenders WHERE name LIKE 'Demo %'`);

    const lenderRows: Array<[string, string]> = [
      ['Demo Trust', 'a_lender'],
      ['Demo Prime Bank', 'a_lender'],
      ['Demo Alternative Capital', 'b_lender'],
    ];

    const lenderIds: Record<string, string> = {};
    for (const [name, type] of lenderRows) {
      const row = await db.query<{ id: string }>(
        `INSERT INTO lenders (name, lender_type, submission_email)
         VALUES ($1, $2, $3) RETURNING id`,
        [name, type, `submissions@${name.toLowerCase().replace(/\s+/g, '')}.test`],
      );
      lenderIds[name] = row.rows[0]!.id;
    }

    const products: Array<[string, string, number, number, number | null, number | null, number | null, boolean, boolean]> = [
      // lender, product, rate, term, minCredit, maxLtv, maxAmort, insured, selfEmployed
      ['Demo Prime Bank', '5-year fixed', 4.69, 5, 680, 80, 30, false, true],
      ['Demo Prime Bank', '5-year fixed (insured)', 4.44, 5, 650, 95, 25, true, true],
      ['Demo Trust', '5-year variable', 4.95, 5, 660, 80, 30, true, true],
      ['Demo Trust', '3-year fixed', 4.79, 3, 600, 80, 30, true, true],
      ['Demo Alternative Capital', 'Alt-A 2-year', 6.49, 2, null, 75, 30, false, true],
    ];

    for (const [lender, name, rate, term, minCredit, maxLtv, maxAmort, insured, selfEmployed] of products) {
      await db.query(
        `INSERT INTO lender_products
           (lender_id, name, rate_type, term_years, posted_rate, min_credit_score,
            max_ltv, max_gds, max_tds, max_amortization, allows_insured, allows_uninsured,
            allows_self_employed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 39, 44, $8, $9, true, $10)`,
        [
          lenderIds[lender],
          name,
          name.includes('variable') ? 'variable' : 'fixed',
          term,
          rate,
          minCredit,
          maxLtv,
          maxAmort,
          insured,
          selfEmployed,
        ],
      );
    }

    await db.query('COMMIT');

    console.info(`
  Demo data seeded — 4 deals across 4 pipeline stages.

    Broker    ${DEMO_BROKER}

    Clients   pramanathan     purchase, under review, documents to check, LOCKED
              mdelacroixwebb  refinance, new enquiry, debts paid out on closing
              dokonkwo        purchase with a co-borrower, conditional approval
              sokonkwo        the co-borrower — their OWN separate login
              evasquez        renewal, funded

    Password for all of them: ${DEMO_PASSWORD}

  Public pages, no login needed:
    /apply         bilingual application — try the FR toggle
    /calculators   payment, affordability, closing costs

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

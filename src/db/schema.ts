/**
 * Drizzle schema — mirrors drizzle/0001_init.sql.
 *
 * The SQL file is the source of truth (it also carries the RLS policies, which
 * Drizzle cannot express). This file exists for type-safe queries; if you
 * change one, change both.
 */

import {
  bigint,
  boolean,
  date,
  integer,
  numeric,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const actorType = pgEnum('actor_type', ['client', 'broker', 'agent', 'system']);
export const clientStatus = pgEnum('client_status', ['invited', 'active', 'suspended', 'archived']);
export const documentStatus = pgEnum('document_status', [
  'requested',
  'in_review',
  'needs_attention',
  'approved',
]);
export const agentRunStatus = pgEnum('agent_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

export const brokerRole = pgEnum('broker_role', ['owner', 'agent', 'assistant', 'compliance']);

export const brokers = pgTable('brokers', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),

  role: brokerRole('role').notNull().default('agent'),
  phone: text('phone'),
  licenceNumber: text('licence_number'),
  brokerageName: text('brokerage_name'),
  brokerageAddress: text('brokerage_address'),
  equifaxMemberNumber: text('equifax_member_number'),
  expertProfileNumber: text('expert_profile_number'),
  commissionSplitPercent: numeric('commission_split_percent').notNull().default('100'),
  invitedBy: uuid('invited_by'),
  inviteAcceptedAt: timestamp('invite_accepted_at', { withTimezone: true }),
});

export const pipelineStages = pgTable('pipeline_stages', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  sortOrder: integer('sort_order').notNull(),
});

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  fullName: text('full_name').notNull(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  status: clientStatus('status').notNull().default('invited'),
  applicationType: text('application_type').notNull().default('purchase'),
  stageKey: text('stage_key').notNull().default('inquiry'),
  driveFolderId: text('drive_folder_id'),
  phone: text('phone'),
  notes: text('notes'),
  brokerId: uuid('broker_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),

  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
});

export const clientStageHistory = pgTable('client_stage_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull(),
  dealId: uuid('deal_id'),
  stageKey: text('stage_key').notNull(),
  note: text('note'),
  advancedBy: uuid('advanced_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentRequests = pgTable('document_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull(),
  dealId: uuid('deal_id'),
  label: text('label').notNull(),
  description: text('description'),
  category: text('category').notNull().default('other'),
  isRequired: boolean('is_required').notNull().default(true),
  status: documentStatus('status').notNull().default('requested'),
  reviewNote: text('review_note'),
  createdBy: actorType('created_by').notNull().default('broker'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull(),
  dealId: uuid('deal_id'),
  requestId: uuid('request_id'),
  driveFileId: text('drive_file_id').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  checksumSha256: text('checksum_sha256'),
  status: documentStatus('status').notNull().default('in_review'),
  reviewNote: text('review_note'),
  classifiedAs: text('classified_as'),
  classificationMeta: jsonb('classification_meta'),
  uploadedBy: actorType('uploaded_by').notNull().default('client'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull(),
  dealId: uuid('deal_id'),
  senderType: actorType('sender_type').notNull(),
  senderId: uuid('sender_id'),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull(),
  userType: actorType('user_type').notNull(),
  userId: uuid('user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  mfaSatisfied: boolean('mfa_satisfied').notNull().default(true),
});

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id'),
  dealId: uuid('deal_id'),
  skillKey: text('skill_key').notNull(),
  trigger: text('trigger').notNull(),
  status: agentRunStatus('status').notNull().default('queued'),
  input: jsonb('input').notNull().default({}),
  output: jsonb('output'),
  error: text('error'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const inboundEmails = pgTable('inbound_emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: text('message_id').notNull(),
  fromEmail: text('from_email').notNull(),
  fromName: text('from_name'),
  subject: text('subject'),
  bodyPreview: text('body_preview'),
  clientId: uuid('client_id'),
  outcome: text('outcome').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorType: actorType('actor_type').notNull(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: uuid('target_id'),
  clientId: uuid('client_id'),
  metadata: jsonb('metadata').notNull().default({}),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Client = typeof clients.$inferSelect;
export type Broker = typeof brokers.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentRequest = typeof documentRequests.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type PipelineStage = typeof pipelineStages.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Deals, intake and compliance — mirrors drizzle/0003_deals_and_intake.sql
// ─────────────────────────────────────────────────────────────────────────────

export const dealStatus = pgEnum('deal_status', ['active', 'archived', 'funded', 'lost']);

export const deals = pgTable('deals', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull(),
  reference: text('reference').notNull(),
  dealType: text('deal_type').notNull().default('purchase'),
  stageKey: text('stage_key').notNull().default('inquiry'),
  status: dealStatus('status').notNull().default('active'),
  assignedTo: uuid('assigned_to'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: uuid('locked_by'),

  propertyAddress: text('property_address'),
  propertyCity: text('property_city'),
  propertyProvince: text('property_province'),
  propertyPostalCode: text('property_postal_code'),
  propertyType: text('property_type'),
  occupancy: text('occupancy'),
  purchasePrice: numeric('purchase_price'),
  propertyValue: numeric('property_value'),

  downPayment: numeric('down_payment'),
  mortgageAmount: numeric('mortgage_amount'),
  interestRate: numeric('interest_rate'),
  amortizationYears: integer('amortization_years'),
  termYears: integer('term_years'),
  paymentFrequency: text('payment_frequency').default('monthly'),

  annualPropertyTax: numeric('annual_property_tax'),
  monthlyHeat: numeric('monthly_heat'),
  monthlyCondoFees: numeric('monthly_condo_fees'),

  existingBalance: numeric('existing_balance'),
  existingLender: text('existing_lender'),
  maturityDate: date('maturity_date'),

  referralCode: text('referral_code'),
  leadSource: text('lead_source'),

  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  fundedAt: timestamp('funded_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

export const dealBorrowers = pgTable('deal_borrowers', {
  id: uuid('id').primaryKey().defaultRandom(),
  dealId: uuid('deal_id').notNull(),
  clientId: uuid('client_id').notNull(),
  role: text('role').notNull().default('co_borrower'),
  invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
});

export const borrowerIncomes = pgTable('borrower_incomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  dealId: uuid('deal_id').notNull(),
  clientId: uuid('client_id').notNull(),
  employmentType: text('employment_type').notNull().default('salaried'),
  employerName: text('employer_name'),
  occupation: text('occupation'),
  yearsAtJob: numeric('years_at_job'),
  annualIncome: numeric('annual_income').notNull().default('0'),
  priorYearIncome: numeric('prior_year_income'),
  isPrimary: boolean('is_primary').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const borrowerLiabilities = pgTable('borrower_liabilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  dealId: uuid('deal_id').notNull(),
  clientId: uuid('client_id'),
  liabilityType: text('liability_type').notNull().default('other'),
  description: text('description'),
  balance: numeric('balance').notNull().default('0'),
  monthlyPayment: numeric('monthly_payment').notNull().default('0'),
  includeInTds: boolean('include_in_tds').notNull().default(true),
  payoutOnClosing: boolean('payout_on_closing').notNull().default(false),
  source: actorType('source').notNull().default('client'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const applications = pgTable('applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  dealId: uuid('deal_id'),
  clientId: uuid('client_id'),
  tier: text('tier').notNull().default('short'),
  locale: text('locale').notNull().default('en'),
  status: text('status').notNull().default('submitted'),
  answers: jsonb('answers').notNull().default({}),
  referralCode: text('referral_code'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
});

export const referralSources = pgTable('referral_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  brokerId: uuid('broker_id'),
  code: text('code').notNull(),
  label: text('label').notNull(),
  medium: text('medium').notNull().default('other'),
  isActive: boolean('is_active').notNull().default(true),
  visits: integer('visits').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const complianceTemplates = pgTable('compliance_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  brokerId: uuid('broker_id'),
  name: text('name').notNull(),
  dealType: text('deal_type'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const complianceTemplateItems = pgTable('compliance_template_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  requiresDocument: boolean('requires_document').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const dealComplianceItems = pgTable('deal_compliance_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  dealId: uuid('deal_id').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  requiresDocument: boolean('requires_document').notNull().default(false),
  status: text('status').notNull().default('pending'),
  documentId: uuid('document_id'),
  note: text('note'),
  completedBy: uuid('completed_by'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recoveryCodes = pgTable('recovery_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userType: actorType('user_type').notNull(),
  userId: uuid('user_id').notNull(),
  codeHash: text('code_hash').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Deal = typeof deals.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type BorrowerIncome = typeof borrowerIncomes.$inferSelect;
export type BorrowerLiability = typeof borrowerLiabilities.$inferSelect;
export type ComplianceItem = typeof dealComplianceItems.$inferSelect;
export type ReferralSource = typeof referralSources.$inferSelect;

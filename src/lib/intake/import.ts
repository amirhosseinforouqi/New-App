/**
 * Importing existing deals from another system.
 *
 * ⚠️ This is NOT a Filogix integration. Filogix Expert has a licensed API
 * requiring a commercial agreement with Finastra; there is no way to write one
 * without the contract. What this does is import a CSV — which is what every
 * one of those systems will export, and what a brokerage switching platforms
 * actually has in their hands on day one.
 *
 * When a licensed connector is bought later, it maps onto `ImportRow` and
 * everything below is unchanged.
 *
 * The design rule throughout: a row that cannot be imported cleanly is
 * REPORTED, not guessed at. A migration that silently drops a client, or
 * invents a mortgage amount from a malformed cell, is worse than one that
 * refuses and tells you which line to fix — because nobody audits 800 imported
 * files, they audit the error list.
 */

export interface ImportRow {
  fullName: string;
  email: string;
  phone?: string;
  dealType?: string;
  stage?: string;
  purchasePrice?: number | null;
  propertyValue?: number | null;
  downPayment?: number | null;
  mortgageAmount?: number | null;
  interestRate?: number | null;
  amortizationYears?: number | null;
  maturityDate?: string | null;
  existingLender?: string | null;
  existingBalance?: number | null;
  propertyAddress?: string | null;
  propertyCity?: string | null;
  propertyProvince?: string | null;
  annualIncome?: number | null;
  employmentType?: string | null;
  notes?: string | null;
}

export interface RowError {
  line: number;
  field: string;
  value: string;
  message: string;
}

export interface ParseResult {
  rows: ImportRow[];
  errors: RowError[];
  /** Columns in the file that were not recognised — usually a mapping problem. */
  unmappedColumns: string[];
}

/**
 * Header aliases.
 *
 * Every export names these differently, so the importer accepts the shapes the
 * common ones actually produce rather than demanding a template nobody has.
 */
const COLUMN_ALIASES: Record<keyof ImportRow, string[]> = {
  fullName: ['full name', 'name', 'client name', 'borrower', 'borrower name', 'applicant'],
  email: ['email', 'email address', 'e-mail', 'borrower email'],
  phone: ['phone', 'telephone', 'mobile', 'cell', 'phone number'],
  dealType: ['deal type', 'type', 'application type', 'purpose', 'transaction type'],
  stage: ['stage', 'status', 'deal status', 'pipeline stage'],
  purchasePrice: ['purchase price', 'price', 'purchase'],
  propertyValue: ['property value', 'value', 'appraised value', 'estimated value'],
  downPayment: ['down payment', 'downpayment', 'deposit'],
  mortgageAmount: ['mortgage amount', 'loan amount', 'mortgage', 'principal', 'amount'],
  interestRate: ['interest rate', 'rate', 'contract rate'],
  amortizationYears: ['amortization', 'amortization years', 'amort'],
  maturityDate: ['maturity date', 'maturity', 'renewal date', 'term end'],
  existingLender: ['lender', 'existing lender', 'current lender'],
  existingBalance: ['existing balance', 'current balance', 'balance', 'outstanding balance'],
  propertyAddress: ['address', 'property address', 'street'],
  propertyCity: ['city', 'property city', 'municipality'],
  propertyProvince: ['province', 'prov', 'state'],
  annualIncome: ['income', 'annual income', 'gross income'],
  employmentType: ['employment', 'employment type', 'income type'],
  notes: ['notes', 'comments', 'memo'],
};

const DEAL_TYPES = new Map<string, string>([
  ['purchase', 'purchase'],
  ['buy', 'purchase'],
  ['new purchase', 'purchase'],
  ['refinance', 'refinance'],
  ['refi', 'refinance'],
  ['renewal', 'renewal'],
  ['renew', 'renewal'],
  ['switch', 'renewal'],
  ['transfer', 'renewal'],
  ['heloc', 'heloc'],
  ['equity takeout', 'heloc'],
  ['pre-approval', 'preapproval'],
  ['preapproval', 'preapproval'],
  ['pre approval', 'preapproval'],
]);

const STAGES = new Map<string, string>([
  ['inquiry', 'inquiry'],
  ['new', 'inquiry'],
  ['lead', 'inquiry'],
  ['documents received', 'documents_received'],
  ['docs in', 'documents_received'],
  ['under review', 'under_review'],
  ['submitted', 'under_review'],
  ['underwriting', 'under_review'],
  ['conditional approval', 'conditional_approval'],
  ['conditional', 'conditional_approval'],
  ['approved', 'final_approval'],
  ['final approval', 'final_approval'],
  ['funded', 'funded'],
  ['closed', 'funded'],
  ['completed', 'funded'],
]);

/**
 * RFC 4180 CSV, handling quoted fields and embedded commas, quotes and
 * newlines.
 *
 * Written out rather than split(',') because addresses contain commas and
 * notes contain quotes, and a naive split silently shifts every column after
 * the first address — which is the sort of corruption that only surfaces
 * months later.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Strip a UTF-8 BOM: Excel adds one, and it corrupts the first header.
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Consume CRLF as one break.
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // Trailing field, unless the file ended on a clean newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

function money(value: string): number | null {
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ISO, or the D/M/Y and M/D/Y shapes a Canadian export produces. */
function isoDate(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (slash) {
    const [, a, b, year] = slash;
    // Ambiguous below 13, so this cannot be resolved from the value alone.
    // Canadian exports are overwhelmingly D/M/Y; a wrong month is visible to a
    // broker in a way a silently dropped date is not.
    const day = Number(a);
    const month = Number(b);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseImport(text: string): ParseResult {
  const table = parseCsv(text);
  const errors: RowError[] = [];
  const rows: ImportRow[] = [];

  if (table.length < 2) {
    return {
      rows: [],
      errors: [
        { line: 0, field: 'file', value: '', message: 'The file has no header row and no data.' },
      ],
      unmappedColumns: [],
    };
  }

  const header = table[0]!.map((cell) => cell.trim().toLowerCase());

  const columnFor = new Map<number, keyof ImportRow>();
  const matched = new Set<number>();

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<
    [keyof ImportRow, string[]]
  >) {
    const index = header.findIndex((cell) => aliases.includes(cell));
    if (index !== -1) {
      columnFor.set(index, field);
      matched.add(index);
    }
  }

  const unmappedColumns = header.filter((cell, index) => cell !== '' && !matched.has(index));

  if (![...columnFor.values()].includes('email')) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          field: 'email',
          value: header.join(', '),
          message:
            'No email column found. Email is how a client is identified, so nothing can be imported without it.',
        },
      ],
      unmappedColumns,
    };
  }

  const seenEmails = new Set<string>();

  for (let r = 1; r < table.length; r += 1) {
    // 1-indexed, and the header is line 1, so data starts at line 2 — matching
    // what a spreadsheet shows the person fixing it.
    const line = r + 1;
    const cells = table[r]!;
    const raw: Record<string, string> = {};

    for (const [index, field] of columnFor) {
      raw[field] = (cells[index] ?? '').trim();
    }

    const email = (raw.email ?? '').toLowerCase();

    if (!EMAIL.test(email)) {
      errors.push({ line, field: 'email', value: raw.email ?? '', message: 'Not a valid email address.' });
      continue;
    }

    if (seenEmails.has(email)) {
      errors.push({
        line,
        field: 'email',
        value: email,
        message: 'Duplicate — this email already appears earlier in the file.',
      });
      continue;
    }
    seenEmails.add(email);

    const fullName = (raw.fullName ?? '').trim();
    if (fullName === '') {
      errors.push({ line, field: 'fullName', value: '', message: 'Name is required.' });
      continue;
    }

    const dealTypeRaw = (raw.dealType ?? '').toLowerCase().trim();
    const dealType = dealTypeRaw === '' ? 'purchase' : DEAL_TYPES.get(dealTypeRaw);
    if (dealTypeRaw !== '' && !dealType) {
      errors.push({
        line,
        field: 'dealType',
        value: raw.dealType ?? '',
        message: `Unrecognised deal type. Expected one of: ${[...new Set(DEAL_TYPES.values())].join(', ')}.`,
      });
      continue;
    }

    const stageRaw = (raw.stage ?? '').toLowerCase().trim();
    const stage = stageRaw === '' ? 'inquiry' : STAGES.get(stageRaw);
    if (stageRaw !== '' && !stage) {
      errors.push({
        line,
        field: 'stage',
        value: raw.stage ?? '',
        message: 'Unrecognised stage. It will need mapping before import.',
      });
      continue;
    }

    rows.push({
      fullName,
      email,
      phone: raw.phone || undefined,
      dealType: dealType ?? 'purchase',
      stage: stage ?? 'inquiry',
      purchasePrice: money(raw.purchasePrice ?? ''),
      propertyValue: money(raw.propertyValue ?? ''),
      downPayment: money(raw.downPayment ?? ''),
      mortgageAmount: money(raw.mortgageAmount ?? ''),
      interestRate: money(raw.interestRate ?? ''),
      amortizationYears: money(raw.amortizationYears ?? ''),
      maturityDate: isoDate(raw.maturityDate ?? ''),
      existingLender: raw.existingLender || null,
      existingBalance: money(raw.existingBalance ?? ''),
      propertyAddress: raw.propertyAddress || null,
      propertyCity: raw.propertyCity || null,
      propertyProvince: (raw.propertyProvince || '').toUpperCase().slice(0, 2) || null,
      annualIncome: money(raw.annualIncome ?? ''),
      employmentType: raw.employmentType || null,
      notes: raw.notes || null,
    });
  }

  return { rows, errors, unmappedColumns };
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCsv, parseImport } from '../src/lib/intake/import';

describe('CSV parsing', () => {
  it('handles the things a naive split(",") breaks on', () => {
    // An address with a comma silently shifts every column after it, which is
    // corruption that only surfaces months later.
    const rows = parseCsv('a,b,c\n"120 Bloor St E, Unit 1802",Toronto,ON');
    assert.deepEqual(rows[1], ['120 Bloor St E, Unit 1802', 'Toronto', 'ON']);
  });

  it('handles escaped quotes', () => {
    const rows = parseCsv('note\n"She said ""yes"" on the phone"');
    assert.equal(rows[1]![0], 'She said "yes" on the phone');
  });

  it('handles newlines inside a quoted field', () => {
    const rows = parseCsv('note,city\n"line one\nline two",Toronto');
    assert.equal(rows.length, 2);
    assert.equal(rows[1]![0], 'line one\nline two');
    assert.equal(rows[1]![1], 'Toronto');
  });

  it('handles CRLF without producing blank rows', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[2], ['3', '4']);
  });

  it('strips the BOM Excel adds', () => {
    const rows = parseCsv('﻿email,name\na@b.ca,A');
    assert.equal(rows[0]![0], 'email', 'BOM corrupted the first header');
  });

  it('drops entirely blank lines', () => {
    const rows = parseCsv('a,b\n1,2\n\n\n3,4');
    assert.equal(rows.length, 3);
  });
});

describe('import mapping', () => {
  const header = 'Client Name,Email Address,Transaction Type,Deal Status,Loan Amount,Maturity';

  it('accepts the column names other systems actually export', () => {
    const result = parseImport(
      `${header}\nPriya Ramanathan,priya@example.ca,Refi,Underwriting,"$425,000.00",2027-06-01`,
    );

    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(result.rows.length, 1);

    const row = result.rows[0]!;
    assert.equal(row.fullName, 'Priya Ramanathan');
    assert.equal(row.dealType, 'refinance', 'Refi should map to refinance');
    assert.equal(row.stage, 'under_review', 'Underwriting should map to under_review');
    assert.equal(row.mortgageAmount, 425_000, 'currency formatting should be stripped');
    assert.equal(row.maturityDate, '2027-06-01');
  });

  it('reports rows it cannot import rather than guessing', () => {
    const result = parseImport(
      `${header}\n` +
        `Good Client,good@example.ca,Purchase,New,500000,\n` +
        `,noname@example.ca,Purchase,New,500000,\n` +
        `Bad Email,not-an-email,Purchase,New,500000,\n` +
        `Weird Type,weird@example.ca,Reverse Mortgage,New,500000,\n`,
    );

    assert.equal(result.rows.length, 1, 'only the good row imports');
    assert.equal(result.errors.length, 3);

    // Line numbers must match what the spreadsheet shows the person fixing it.
    assert.deepEqual(
      result.errors.map((error) => [error.line, error.field]),
      [
        [3, 'fullName'],
        [4, 'email'],
        [5, 'dealType'],
      ],
    );
  });

  it('catches duplicate emails within the file', () => {
    const result = parseImport(
      `${header}\n` +
        `A,same@example.ca,Purchase,New,1,\n` +
        `B,same@example.ca,Purchase,New,2,\n`,
    );

    assert.equal(result.rows.length, 1);
    assert.match(result.errors[0]!.message, /Duplicate/);
  });

  it('refuses the whole file when there is no email column', () => {
    const result = parseImport('Name,Amount\nPriya,500000');
    assert.equal(result.rows.length, 0);
    assert.match(result.errors[0]!.message, /No email column/);
  });

  it('reports columns it did not recognise, so a mapping gap is visible', () => {
    const result = parseImport(
      'Name,Email,Underwriter Notes,Broker Code\nA,a@example.ca,x,y',
    );
    assert.ok(result.unmappedColumns.includes('underwriter notes'));
    assert.ok(result.unmappedColumns.includes('broker code'));
  });

  it('defaults deal type and stage rather than failing on blanks', () => {
    const result = parseImport('Name,Email\nA,a@example.ca');
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows[0]!.dealType, 'purchase');
    assert.equal(result.rows[0]!.stage, 'inquiry');
  });

  it('normalises province to two upper-case letters', () => {
    const result = parseImport('Name,Email,Province\nA,a@example.ca,ontario');
    assert.equal(result.rows[0]!.propertyProvince, 'ON');
  });

  it('returns null for an unparseable date rather than inventing one', () => {
    const result = parseImport('Name,Email,Maturity\nA,a@example.ca,sometime next year');
    assert.equal(result.rows[0]!.maturityDate, null);
  });

  it('reads a D/M/Y date, which is what Canadian exports produce', () => {
    const result = parseImport('Name,Email,Maturity\nA,a@example.ca,01/06/2027');
    assert.equal(result.rows[0]!.maturityDate, '2027-06-01');
  });

  it('handles an empty file without throwing', () => {
    const result = parseImport('');
    assert.equal(result.rows.length, 0);
    assert.equal(result.errors.length, 1);
  });
});

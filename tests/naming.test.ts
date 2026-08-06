import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { baseUsername } from '../src/lib/auth/username';
import { clientFolderName, sanitiseFileName } from '../src/lib/drive/service';

describe('username generation', () => {
  it('uses first initial + last name', () => {
    assert.equal(baseUsername('Priya Ramanathan'), 'pramanathan');
    assert.equal(baseUsername('John Smith'), 'jsmith');
  });

  it('handles middle names by using the last token as the surname', () => {
    assert.equal(baseUsername('Mary Jane Watson'), 'mwatson');
  });

  it('strips diacritics and punctuation', () => {
    assert.equal(baseUsername("Zoë O'Brien"), 'zobrien');
    assert.equal(baseUsername('Jean-Luc Picard'), 'jpicard');
    assert.equal(baseUsername('Renée Fleming'), 'rfleming');
  });

  it('handles a single name', () => {
    assert.equal(baseUsername('Prince'), 'prince');
  });

  it('falls back rather than producing an empty username', () => {
    assert.equal(baseUsername(''), 'client');
    assert.equal(baseUsername('   '), 'client');
    // Non-Latin scripts reduce to nothing after slugification; the fallback
    // keeps onboarding working instead of throwing.
    assert.equal(baseUsername('李 明'), 'client');
  });

  it('caps length so the username stays typable', () => {
    assert.ok(baseUsername('A Verylongsurnamethatkeepsgoingandgoing').length <= 20);
  });

  it('never emits characters that need escaping', () => {
    const samples = ["O'Neill Smith", 'de la Cruz', 'Ann-Marie Fitzgerald', '<script> Tag'];
    for (const sample of samples) {
      assert.match(baseUsername(sample), /^[a-z0-9]+$/, `${sample} produced unsafe output`);
    }
  });
});

describe('filename sanitisation', () => {
  it('strips path separators', () => {
    assert.equal(sanitiseFileName('../../etc/passwd').includes('/'), false);
    assert.equal(sanitiseFileName('folder\\file.pdf').includes('\\'), false);
  });

  it('collapses traversal sequences', () => {
    assert.equal(sanitiseFileName('../../file.pdf').includes('..'), false);
  });

  it('keeps ordinary names intact', () => {
    assert.equal(sanitiseFileName('2024 Notice of Assessment.pdf'), '2024 Notice of Assessment.pdf');
  });

  it('never returns an empty name', () => {
    assert.equal(sanitiseFileName(''), 'upload');
    assert.equal(sanitiseFileName('   '), 'upload');
  });

  it('caps length', () => {
    assert.ok(sanitiseFileName('a'.repeat(500)).length <= 200);
  });
});

describe('client folder naming', () => {
  const id = 'b3f1c2d4-0000-4000-8000-000000000000';

  it('formats as "Last, First — shortid"', () => {
    assert.equal(clientFolderName('Priya Ramanathan', id), 'Ramanathan, Priya — b3f1c2d4');
  });

  it('keeps middle names with the first name', () => {
    assert.equal(clientFolderName('Mary Jane Watson', id), 'Watson, Mary Jane — b3f1c2d4');
  });

  it('handles a single name', () => {
    assert.equal(clientFolderName('Prince', id), 'Prince — b3f1c2d4');
  });

  it('disambiguates identical names by id', () => {
    const other = 'ffffffff-0000-4000-8000-000000000000';
    assert.notEqual(clientFolderName('John Smith', id), clientFolderName('John Smith', other));
  });
});

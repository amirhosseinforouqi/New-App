import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { documentReminderSms, toE164 } from '../src/lib/notify/sms';
import { REMINDER_SCHEDULE_DAYS, MAX_REMINDERS, defaultDueDate } from '../src/lib/notify/reminders';
import { documentReminderEmail, renewalOutreachEmail } from '../src/lib/mail/templates';

describe('phone number normalisation', () => {
  it('reads the shapes a Canadian client actually types', () => {
    for (const input of [
      '(416) 555-0142',
      '416-555-0142',
      '416.555.0142',
      '4165550142',
      '416 555 0142',
      '1 416 555 0142',
      '1-416-555-0142',
      '+1 (416) 555-0142',
    ]) {
      assert.equal(toE164(input), '+14165550142', `failed on ${input}`);
    }
  });

  it('refuses anything it cannot read, rather than guessing', () => {
    // Sending a client's document reminder to a wrong number is a privacy
    // incident, so a bad number must fail loudly rather than be repaired.
    for (const bad of ['', '  ', '555-0142', '12345', 'call me', null, undefined, '416555014']) {
      assert.equal(toE164(bad), null, `should have refused ${JSON.stringify(bad)}`);
    }
  });

  it('passes through an international number already in E.164', () => {
    assert.equal(toE164('+442071234567'), '+442071234567');
  });
});

describe('reminder cadence', () => {
  it('is finite — three attempts and then it stops', () => {
    assert.equal(MAX_REMINDERS, 3);
    assert.equal(REMINDER_SCHEDULE_DAYS.length, 3);
  });

  it('spaces the attempts further apart each time', () => {
    const gaps = REMINDER_SCHEDULE_DAYS.map((day, index) =>
      index === 0 ? day : day - REMINDER_SCHEDULE_DAYS[index - 1]!,
    );
    for (let i = 1; i < gaps.length; i += 1) {
      assert.ok(gaps[i]! > gaps[i - 1]!, `gap ${i} should exceed gap ${i - 1}`);
    }
  });

  it('sets a due date a week out, at the end of the day', () => {
    const from = new Date('2026-03-02T10:00:00');
    const due = defaultDueDate(from);

    assert.equal(due.getDate(), 9);
    assert.equal(due.getHours(), 17);
  });
});

describe('reminder SMS', () => {
  const message = documentReminderSms({
    firstName: 'Priya',
    outstandingCount: 3,
    brokerName: 'Amir Foroughi',
    portalUrl: 'https://portal.example.ca/dashboard',
  });

  it('fits in a single segment', () => {
    // Longer bodies get split by the carrier and can arrive out of order.
    assert.ok(message.length <= 160, `${message.length} characters: ${message}`);
  });

  it('says who it is from, what is needed, and where to go', () => {
    assert.match(message, /Priya/);
    assert.match(message, /Amir Foroughi/);
    assert.match(message, /3 documents/);
    assert.match(message, /portal\.example\.ca/);
  });

  it('gets the singular right', () => {
    const one = documentReminderSms({
      firstName: 'Marc',
      outstandingCount: 1,
      brokerName: 'A',
      portalUrl: 'https://x.ca',
    });
    assert.match(one, /1 document\b/);
    assert.ok(!one.includes('1 documents'));
  });
});

describe('reminder email', () => {
  const labels = ['2024 Notice of Assessment', 'Recent pay stubs'];

  it('escalates in tone without becoming a threat', () => {
    const first = documentReminderEmail({
      fullName: 'Priya Ramanathan',
      labels,
      attempt: 1,
      brokerName: 'Amir',
      portalUrl: 'https://x.ca',
    });
    const last = documentReminderEmail({
      fullName: 'Priya Ramanathan',
      labels,
      attempt: 3,
      brokerName: 'Amir',
      portalUrl: 'https://x.ca',
    });

    assert.match(first.text, /nudge/i);
    assert.match(last.subject, /Final/i);
    // The last one must say it is the last, so silence afterwards is not read
    // as the file having died.
    assert.match(last.text, /Last automated reminder/i);
    assert.match(last.text, /follow up personally/i);
  });

  it('lists every outstanding item in both text and html', () => {
    const email = documentReminderEmail({
      fullName: 'Priya Ramanathan',
      labels,
      attempt: 1,
      brokerName: 'Amir',
      portalUrl: 'https://x.ca',
    });

    for (const label of labels) {
      assert.ok(email.text.includes(label));
      assert.ok(email.html.includes(label));
    }
  });

  it('addresses the client by first name only', () => {
    const email = documentReminderEmail({
      fullName: 'Élise Tremblay-Nguyen',
      labels,
      attempt: 1,
      brokerName: 'Amir',
      portalUrl: 'https://x.ca',
    });
    assert.match(email.text, /Hi Élise,/);
  });
});

describe('renewal outreach', () => {
  it('speaks differently before and after maturity', () => {
    const upcoming = renewalOutreachEmail({
      fullName: 'Marcus Delacroix-Webb',
      maturityDate: 'June 1, 2026',
      daysAway: 90,
      brokerName: 'Amir',
    });
    const lapsed = renewalOutreachEmail({
      fullName: 'Marcus Delacroix-Webb',
      maturityDate: 'January 1, 2026',
      daysAway: -20,
      brokerName: 'Amir',
    });

    assert.match(upcoming.text, /matures on June 1, 2026/);
    assert.match(upcoming.text, /lock a new rate/i);

    assert.match(lapsed.text, /matured on January 1, 2026/);
    assert.match(lapsed.text, /posted rate/i);
    assert.match(lapsed.subject, /has matured/i);
  });

  it('offers a conversation rather than advertising a rate', () => {
    const email = renewalOutreachEmail({
      fullName: 'A B',
      maturityDate: 'June 1, 2026',
      daysAway: 90,
      brokerName: 'Amir',
    });

    assert.match(email.text, /No obligation/i);
    // A borrower who feels sold to at renewal goes back to their bank.
    assert.ok(!/%/.test(email.text), 'should not quote a rate it cannot honour');
  });
});

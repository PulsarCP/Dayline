import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd } from '../src/lib/parser.js';
import { normalizeRecurrence } from '../src/lib/recurrence.js';

// Wednesday 30 Sep 2026, 10:00 local
const NOW = new Date(2026, 8, 30, 10, 0, 0);
const p = (s) => parseQuickAdd(s, NOW);
const pick = ({ title, date, time }) => ({ title, date, time });

test('plain text stays a title', () => {
  assert.deepEqual(pick(p('call mom')), { title: 'call mom', date: null, time: null });
  assert.equal(p('').title, '');
  assert.equal(p(undefined).title, '');
});

test('tomorrow with 24h time', () => {
  assert.deepEqual(pick(p('dentist tomorrow 15:00')), { title: 'dentist', date: '2026-10-01', time: '15:00' });
});

test('am/pm forms', () => {
  assert.equal(p('lunch tomorrow 12pm').time, '12:00');
  assert.equal(p('run tomorrow 12am').time, '00:00');
  assert.equal(p('call tomorrow 3:30 pm').time, '15:30');
  assert.equal(p('sync tomorrow at noon').time, '12:00');
});

test('weekday names mean the next such day, strictly after today', () => {
  assert.deepEqual(pick(p('meeting friday 3pm')), { title: 'meeting', date: '2026-10-02', time: '15:00' });
  assert.equal(p('standup wednesday').date, '2026-10-07'); // today is Wednesday
  assert.equal(p('gym next monday').date, '2026-10-05');
  assert.equal(p('sat exam').date, null); // bare abbreviation stays in the title
  assert.equal(p('sat exam').title, 'sat exam');
  assert.equal(p('exam on sat').date, '2026-10-03');
});

test('explicit dates', () => {
  assert.equal(p('pay rent on 5 oct').date, '2026-10-05');
  assert.equal(p('pay rent on 5 oct').title, 'pay rent');
  assert.equal(p('thesis 15/12').date, '2026-12-15');
  assert.equal(p('exam 2027-01-20 09:30').date, '2027-01-20');
  assert.equal(p('exam 2027-01-20 09:30').time, '09:30');
  assert.equal(p('trip oct 12 2027').date, '2027-10-12');
  assert.equal(p('1st of november party').date, '2026-11-01');
});

test('dates already past this year roll to next year', () => {
  assert.equal(p('call jan 5').date, '2027-01-05');
  assert.equal(p('call 5/1').date, '2027-01-05');
  assert.equal(p('call 30 sep').date, '2026-09-30'); // today is not past
});

test('invalid calendar dates are left alone', () => {
  const r = p('party 31 feb');
  assert.equal(r.date, null);
  assert.equal(r.title, 'party 31 feb');
});

test('relative offsets', () => {
  assert.deepEqual(pick(p('stretch in 30 minutes')), { title: 'stretch', date: '2026-09-30', time: '10:30' });
  assert.deepEqual(pick(p('call in 2 hours')), { title: 'call', date: '2026-09-30', time: '12:00' });
  assert.equal(p('renew in 3 days').date, '2026-10-03');
  assert.equal(p('renew in 2 weeks').date, '2026-10-14');
  assert.equal(p('renew in 1 month').date, '2026-10-30');
});

test('relative hours can cross midnight', () => {
  const late = parseQuickAdd('ping in 3 hours', new Date(2026, 8, 30, 23, 0));
  assert.equal(late.date, '2026-10-01');
  assert.equal(late.time, '02:00');
});

test('a time with no date means today, or tomorrow if already passed', () => {
  assert.equal(p('call at 15:00').date, '2026-09-30');
  assert.equal(p('dinner at 9am').date, '2026-10-01');
  assert.equal(p('dinner at 9am').time, '09:00');
});

test('keywords: day after tomorrow, tonight, today', () => {
  assert.equal(p('trip day after tomorrow').date, '2026-10-02');
  assert.deepEqual(pick(p('movie tonight')), { title: 'movie', date: '2026-09-30', time: '20:00' });
  assert.equal(p('submit today').date, '2026-09-30');
});

test('recurrence phrases', () => {
  const mon = p('gym every monday at 7am');
  assert.deepEqual(pick(mon), { title: 'gym', date: '2026-10-05', time: '07:00' });
  assert.deepEqual(mon.recurrence, { freq: 'weekly', interval: 1, weekdays: [1] });

  const daily = p('meds every day 8:00');
  assert.deepEqual(daily.recurrence, { freq: 'daily', interval: 1 });
  assert.equal(daily.date, '2026-10-01'); // 08:00 already passed today

  assert.deepEqual(p('review every 2 weeks').recurrence, { freq: 'weekly', interval: 2 });
  assert.deepEqual(p('rent monthly').recurrence, { freq: 'monthly', interval: 1 });
  assert.deepEqual(p('team lunch every other friday').recurrence, { freq: 'weekly', interval: 2, weekdays: [5] });
  assert.deepEqual(p('standup every weekday 9:30').recurrence.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(p('standup every weekday 9:30').date, '2026-10-01'); // 09:30 passed; Thursday is a weekday
  assert.equal(p('yoga every wednesday').date, '2026-09-30'); // series may start today
  assert.equal(p('rent monthly').date, '2026-09-30');
});

test('parsed recurrences always satisfy the model validator', () => {
  for (const s of ['x daily', 'x weekly', 'x every 400 days', 'x every 3 months', 'x every other tue', 'x every weekday']) {
    const { recurrence } = p(s);
    if (recurrence) assert.doesNotThrow(() => normalizeRecurrence(recurrence), s);
  }
  assert.equal(p('x every 400 days').recurrence, null); // interval out of range: ignored, not thrown
});

test('invalid times are ignored', () => {
  const r = p('meet at 25:00');
  assert.equal(r.time, null);
  assert.equal(r.title, 'meet at 25:00');
  assert.equal(p('call 13pm').time, null);
});

test('title cleanup', () => {
  assert.equal(p('remind me to send report tomorrow').title, 'send report');
  assert.equal(p('  Buy   milk   tomorrow  ').title, 'Buy milk');
  assert.equal(p('tomorrow').title, '');
});

test('matched fragments are reported for UI highlighting', () => {
  const kinds = p('gym every monday at 7am').matched.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['repeat', 'time']);
});

// ---------- multi-day ranges ----------

const span = (s) => { const r = p(s); return [r.title, r.date, r.endDate]; };

test('date ranges (the "7-8 october Job Fair 2026" case)', () => {
  assert.deepEqual(span('7-8 october Job Fair 2026'), ['Job Fair 2026', '2026-10-07', '2026-10-08']);
  assert.deepEqual(span('Job Fair 7-8 oct'), ['Job Fair', '2026-10-07', '2026-10-08']);
  assert.deepEqual(span('oct 7-9 conference'), ['conference', '2026-10-07', '2026-10-09']);
  assert.deepEqual(span('conference from 7 to 9 oct'), ['conference', '2026-10-07', '2026-10-09']);
  assert.deepEqual(span('retreat 12th-14th of october'), ['retreat', '2026-10-12', '2026-10-14']);
  assert.deepEqual(span('exams 3 until 6 nov'), ['exams', '2026-11-03', '2026-11-06']);
});

test('ranges across months, years and ISO dates', () => {
  assert.deepEqual(span('30 oct - 2 nov trip'), ['trip', '2026-10-30', '2026-11-02']);
  assert.deepEqual(span('trip oct 30 - nov 2'), ['trip', '2026-10-30', '2026-11-02']);
  assert.deepEqual(span('trip dec 30 - jan 2'), ['trip', '2026-12-30', '2027-01-02']);
  assert.deepEqual(span('trip 2026-10-07 to 2026-10-09'), ['trip', '2026-10-07', '2026-10-09']);
  assert.deepEqual(span('trip 10-12 march 2027'), ['trip', '2027-03-10', '2027-03-12']);
  assert.deepEqual(span('trip 5-7 jan'), ['trip', '2027-01-05', '2027-01-07']); // already past this year
});

test('a range keeps its start time', () => {
  const r = p('conference 7-9 oct 9:00');
  assert.deepEqual([r.title, r.date, r.endDate, r.time], ['conference', '2026-10-07', '2026-10-09', '09:00']);
});

test('reversed or impossible ranges are not ranges', () => {
  assert.equal(p('8-7 oct').endDate, null);
  assert.equal(p('8-8 oct').endDate, null);
  assert.equal(p('5-31 feb').endDate, null);
  assert.equal(p('trip 2026-10-09 to 2026-10-07').endDate, null);
  assert.equal(p('trip oct 1 - oct 1').endDate, null);
});

test('single dates still work and have no end', () => {
  assert.equal(p('pay rent on 5 oct').endDate, null);
  assert.equal(p('dentist tomorrow 15:00').endDate, null);
  assert.equal(p('thesis 15/12').endDate, null);
});

test('"for N days" extends a date', () => {
  assert.deepEqual(span('camp tomorrow for 3 days'), ['camp', '2026-10-01', '2026-10-03']);
  assert.deepEqual(span('trip 12 oct for 2 days'), ['trip', '2026-10-12', '2026-10-13']);
  assert.equal(p('camp tomorrow for 1 day').endDate, null);
  assert.equal(p('camp tomorrow for 90 days').endDate, null);
  assert.equal(p('camp for 3 days').endDate, null); // no date to extend
});

test('repeating items never get an end date', () => {
  assert.equal(p('gym every monday for 3 days').endDate, null);
});

// ---------- section tags ----------

test('#section tags', () => {
  const r = p('finish report tomorrow #work');
  assert.deepEqual([r.title, r.date, r.categoryTag], ['finish report', '2026-10-01', 'work']);
  assert.equal(p('#study read chapter 3').categoryTag, 'study');
  assert.equal(p('#study read chapter 3').title, 'read chapter 3');
  assert.equal(p('lab report #Uni-2nd_year friday').categoryTag, 'Uni-2nd_year');
  assert.equal(p('#work').title, '');
});

test('things that look like tags but are not', () => {
  assert.equal(p('fix bug #12').categoryTag, null);
  assert.equal(p('fix bug #12').title, 'fix bug #12');
  assert.equal(p('learn C# tomorrow').categoryTag, null);
  assert.equal(p('learn C# tomorrow').title, 'learn C#');
  assert.equal(p('plain text').categoryTag, null);
});

test('the first tag wins and all tags are removed from the title', () => {
  const r = p('call mom #personal #family');
  assert.equal(r.categoryTag, 'personal');
  assert.equal(r.title, 'call mom');
});

test('unicode tags', () => {
  assert.equal(p('esame #università domani').categoryTag, 'università');
});

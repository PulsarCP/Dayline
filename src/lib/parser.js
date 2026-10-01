// Quick-add parser: "dentist tomorrow 3pm" -> { title, date, time, recurrence }.
//
// Pure and forgiving: anything it does not recognise stays in the title. Formats:
//   dates      today, tomorrow, day after tomorrow, tonight, monday / next friday,
//              5 oct, oct 5 2027, 15/12 (DD/MM, optional year), 2026-12-15
//   times      15:00, 3pm, 3:30 pm, noon, midnight (a bare "at 5" is NOT parsed: ambiguous)
//   relative   in 30 minutes, in 2 hours, in 3 days, in 2 weeks, in 1 month
//   repeat     daily, weekly, monthly, every day, every 2 weeks, every weekday,
//              every monday, every other friday
// Multi-day:  7-8 october, oct 7-9, from 7 to 9 oct, 30 oct - 2 nov, dec 30 - jan 2,
//             2026-10-07 to 2026-10-09, and "for 3 days" after any date (tomorrow for 3 days)
// Sections:   #work, #study (first one wins; the caller maps it onto a real section)
// Weekday names always mean the next such day strictly after today.
// 3-letter weekday abbreviations only count after on/next/this/every (so "sat exam"
// stays a title). A time with no date means today, or tomorrow if it already passed.

import {
  addDays, addMonths, combine, diffDays, isValidDateStr, pad, timeStrOf, toDateStr, weekdayOf,
} from './dates.js';
import { normalizeRecurrence } from './recurrence.js';

const WEEKDAY_FULL = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const WEEKDAY_ABBR = {
  sun: 0, mon: 1, tues: 2, tue: 2, wed: 3, thurs: 4, thur: 4, thu: 4, fri: 5, sat: 6,
};
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_RE =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WD_RE = `(${Object.keys(WEEKDAY_FULL).join('|')}|${Object.keys(WEEKDAY_ABBR).join('|')})`;

function lookupWeekday(token) {
  const t = token.toLowerCase();
  if (t in WEEKDAY_FULL) return { idx: WEEKDAY_FULL[t], abbr: false };
  return { idx: WEEKDAY_ABBR[t], abbr: true };
}

/** Find the first regex match that `accept` approves; remove it from the text. */
function consume(text, re, accept) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    const value = accept(m);
    if (value !== undefined) {
      return {
        text: `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`,
        value,
        matched: m[0].trim(),
      };
    }
  }
  return null;
}

const to24 = (h, ap) => {
  if (ap === 'am') return h === 12 ? 0 : h;
  if (ap === 'pm') return h === 12 ? 12 : h + 12;
  return h;
};

const safeRecurrence = (rule) => {
  try {
    return normalizeRecurrence(rule);
  } catch {
    return undefined;
  }
};

function buildDate(y, month0, d) {
  const s = `${y}-${pad(month0 + 1)}-${pad(d)}`;
  return isValidDateStr(s) ? s : null;
}

function resolveDate(year, month0, day, today) {
  const explicit = year != null;
  const y = explicit ? (year < 100 ? 2000 + year : year) : Number(today.slice(0, 4));
  let s = buildDate(y, month0, day);
  if (s && !explicit && s < today) s = buildDate(y + 1, month0, day);
  return s ?? undefined;
}

export function parseQuickAdd(input, now = new Date()) {
  let text = String(input ?? '');
  const matched = [];
  const today = toDateStr(now);
  let date = null;
  let time = null;
  let recurrence = null;
  let endDate = null;
  let categoryTag = null;

  const take = (res, kind) => {
    text = res.text;
    matched.push({ kind, text: res.matched });
    return res.value;
  };

  // 0. Section tags: "#work". Must start with a letter, so "#12" and "C#" stay in the title.
  for (let guard = 0; guard < 5; guard++) {
    const tag = consume(
      text,
      /(?:^|\s)#([\p{L}][\p{L}\p{N}_-]{0,29})(?![\p{L}\p{N}_#-])/u,
      (m) => m[1],
    );
    if (!tag) break;
    const name = take(tag, 'section');
    categoryTag ??= name;
  }

  // 1. Recurrence
  let r = consume(text, /\bevery\s+weekdays?\b/i, () => ({
    freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5],
  }));
  if (!r) {
    // "every thursday", "every other friday", "every thursday and friday", "every mon, wed & fri"
    const WD_ONE = WD_RE.replace(/^\(/, '(?:');
    const list = `${WD_ONE}s?(?:\\s*(?:,|&|\\+|\\band\\b)\\s*(?:and\\s+)?${WD_ONE}s?)*`;
    r = consume(text, new RegExp(`\\bevery\\s+(?:(other|on)\\s+)?(${list})\\b`, 'i'), (m) => {
      const days = [];
      for (const w of m[2].matchAll(new RegExp(`\\b${WD_RE}`, 'gi'))) {
        const { idx } = lookupWeekday(w[1]);
        if (idx === undefined) return undefined;
        days.push(idx);
      }
      if (!days.length) return undefined;
      return safeRecurrence({
        freq: 'weekly', interval: m[1]?.toLowerCase() === 'other' ? 2 : 1, weekdays: days,
      });
    });
  }
  if (!r) {
    r = consume(text, /\bevery\s+(?:(\d{1,2}|other)\s+)?hours?\b/i, (m) => {
      const n = m[1] ? (m[1].toLowerCase() === 'other' ? 2 : Number(m[1])) : 1;
      return safeRecurrence({ freq: 'hourly', interval: n });
    });
  }
  if (!r) r = consume(text, /\bhourly\b/i, () => ({ freq: 'hourly', interval: 1 }));
  if (!r) {
    r = consume(text, /\bevery\s+(?:(\d{1,3}|other)\s+)?(day|week|month)s?\b/i, (m) => {
      const n = m[1] ? (m[1].toLowerCase() === 'other' ? 2 : Number(m[1])) : 1;
      const freq = { day: 'daily', week: 'weekly', month: 'monthly' }[m[2].toLowerCase()];
      return safeRecurrence({ freq, interval: n });
    });
  }
  if (!r) {
    r = consume(text, /\b(daily|weekly|monthly)\b/i, (m) =>
      safeRecurrence({ freq: m[1].toLowerCase(), interval: 1 }));
  }
  if (r) recurrence = take(r, 'repeat');

  // 2. Time of day
  let t = consume(text, /\b(?:at\s+)?(\d{1,2}):(\d{2})(?:\s*(am|pm))?\b/i, (m) => {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ap = m[3]?.toLowerCase();
    if (min > 59) return undefined;
    if (ap) {
      if (h < 1 || h > 12) return undefined;
      h = to24(h, ap);
    } else if (h > 23) {
      return undefined;
    }
    return `${pad(h)}:${pad(min)}`;
  });
  if (!t) {
    t = consume(text, /\b(?:at\s+)?(\d{1,2})\s*(am|pm)\b/i, (m) => {
      const h = Number(m[1]);
      return h >= 1 && h <= 12 ? `${pad(to24(h, m[2].toLowerCase()))}:00` : undefined;
    });
  }
  if (!t) {
    t = consume(text, /\b(?:at\s+)?(noon|midnight)\b/i, (m) =>
      (m[1].toLowerCase() === 'noon' ? '12:00' : '00:00'));
  }
  if (t) time = take(t, 'time');

  // 3. Relative: "in 30 minutes", "in 2 days"
  const rel = consume(
    text,
    /\bin\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\b/i,
    (m) => ({ n: Number(m[1]), unit: m[2].toLowerCase() }),
  );
  if (rel) {
    const { n, unit } = take(rel, 'relative');
    if (unit.startsWith('min') || unit.startsWith('h')) {
      const ms = n * (unit.startsWith('min') ? 60000 : 3600000);
      const at = new Date(now.getTime() + ms);
      date = toDateStr(at);
      time = timeStrOf(at);
    } else if (unit.startsWith('d')) {
      date = addDays(today, n);
    } else if (unit.startsWith('w')) {
      date = addDays(today, n * 7);
    } else {
      date = addMonths(today, n);
    }
  }

  // 4. Keywords
  if (!date) {
    const k = consume(
      text,
      /\b(day after tomorrow|tomorrow|tmrw|tmr|tonight|today)\b/i,
      (m) => m[1].toLowerCase(),
    );
    if (k) {
      const word = take(k, 'date');
      if (word === 'day after tomorrow') date = addDays(today, 2);
      else if (word === 'today') date = today;
      else if (word === 'tonight') {
        date = today;
        time ??= '20:00';
      } else date = addDays(today, 1);
    }
  }

  // 5. Explicit dates
  if (!date) {
    const SEP = '\\s*(?:-|\u2013|\u2014|to|until|till)\\s*';
    const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
    const OF = '(?:of\\s+)?';
    const YEAR = '(?:,?\\s+(\\d{4}))?';
    const mon = (name) => MONTHS[name.slice(0, 3).toLowerCase()];
    const range = (m1, d1, m2, d2, year) => {
      if (m1 === m2 && Number(d2) <= Number(d1)) return undefined; // "8-7 oct" is not a range
      const start = resolveDate(year ? Number(year) : null, m1, Number(d1), today);
      if (!start) return undefined;
      const y = Number(start.slice(0, 4));
      let end = buildDate(y, m2, Number(d2));
      if (end && end < start) end = buildDate(y + 1, m2, Number(d2));
      if (!end || end <= start || diffDays(start, end) > 366) return undefined;
      return { date: start, endDate: end };
    };
    const patterns = [
      // ranges first, so "7-8 october" is not read as the single date "8 october"
      [new RegExp(`\\b(?:from\\s+)?${DAY}${SEP}${DAY}\\s+${OF}${MONTH_RE}${YEAR}\\b`, 'i'),
        (m) => range(mon(m[3]), m[1], mon(m[3]), m[2], m[4])],
      [new RegExp(`\\b(?:from\\s+)?${MONTH_RE}\\s+${DAY}${SEP}${DAY}${YEAR}\\b`, 'i'),
        (m) => range(mon(m[1]), m[2], mon(m[1]), m[3], m[4])],
      [new RegExp(`\\b(?:from\\s+)?${DAY}\\s+${OF}${MONTH_RE}${SEP}${DAY}\\s+${OF}${MONTH_RE}${YEAR}\\b`, 'i'),
        (m) => range(mon(m[2]), m[1], mon(m[4]), m[3], m[5])],
      [new RegExp(`\\b(?:from\\s+)?${MONTH_RE}\\s+${DAY}${SEP}${MONTH_RE}\\s+${DAY}${YEAR}\\b`, 'i'),
        (m) => range(mon(m[1]), m[2], mon(m[3]), m[4], m[5])],
      [/\b(?:from\s+)?(\d{4}-\d{2}-\d{2})\s*(?:-|\u2013|\u2014|to|until|till)\s*(\d{4}-\d{2}-\d{2})\b/i,
        (m) => (isValidDateStr(m[1]) && isValidDateStr(m[2]) && m[2] > m[1] && diffDays(m[1], m[2]) <= 366
          ? { date: m[1], endDate: m[2] } : undefined)],
      [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => (isValidDateStr(m[0]) ? m[0] : undefined)],
      [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/,
        (m) => resolveDate(m[3] ? Number(m[3]) : null, Number(m[2]) - 1, Number(m[1]), today)],
      [new RegExp(`\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, 'i'),
        (m) => resolveDate(m[3] ? Number(m[3]) : null, MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]), today)],
      [new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i'),
        (m) => resolveDate(m[3] ? Number(m[3]) : null, MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]), today)],
    ];
    for (const [re, accept] of patterns) {
      const d = consume(text, re, accept);
      if (d) {
        const v = take(d, 'date');
        if (typeof v === 'object') {
          date = v.date;
          endDate = v.endDate;
        } else {
          date = v;
        }
        break;
      }
    }
  }

  // 6. Weekday name (next such day strictly after today)
  if (!date) {
    const w = consume(text, new RegExp(`\\b(?:(on|next|this)\\s+)?${WD_RE}s?\\b`, 'i'), (m) => {
      const { idx, abbr } = lookupWeekday(m[2]);
      if (idx === undefined || (abbr && !m[1])) return undefined;
      return idx;
    });
    if (w) {
      const idx = take(w, 'date');
      date = addDays(today, ((idx - weekdayOf(today) + 6) % 7) + 1);
    }
  }

  // 7. Defaults for series and bare times
  if (!date && recurrence?.weekdays) {
    // Start today only if the time (when given) has not already passed.
    const first = time && combine(today, time) <= now ? 1 : 0;
    for (let i = first; i < 8 && !date; i++) {
      const d = addDays(today, i);
      if (recurrence.weekdays.includes(weekdayOf(d))) date = d;
    }
  }
  if (recurrence?.freq === 'hourly' && !time) {
    // No start given: begin at the next 5-minute mark, so "every 2 hours" starts right away.
    const start = new Date(Math.ceil((now.getTime() + 1) / 300000) * 300000);
    if (!date) date = toDateStr(start);
    time = date === toDateStr(start) ? timeStrOf(start) : '09:00';
  }
  if (!date && (time || recurrence)) {
    date = time && combine(today, time) <= now ? addDays(today, 1) : today;
  }

  // 8. Duration: "tomorrow for 3 days" (not for repeating items)
  if (date && !endDate && !recurrence) {
    const dur = consume(text, /\bfor\s+(\d{1,2})\s+days?\b/i, (m) => {
      const n = Number(m[1]);
      return n >= 2 && n <= 60 ? n : undefined;
    });
    if (dur) endDate = addDays(date, take(dur, 'duration') - 1);
  }
  if (recurrence) endDate = null;

  // 9. Title
  let title = text.replace(/\s+/g, ' ').trim();
  title = title.replace(/^(?:remind me (?:to|about)|reminder:?|todo:?)\s+/i, '');
  for (let i = 0; i < 3; i++) {
    title = title
      .replace(/^(?:on|at|by|for|to|in|from)\s+/i, '')
      .replace(/\s+(?:on|at|by|for|in|from|every)$/i, '')
      .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '');
  }

  return { title, date, endDate, time, recurrence, categoryTag, matched };
}

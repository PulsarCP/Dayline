// Date helpers. Dates are plain local "YYYY-MM-DD" strings and times are
// "HH:MM" strings, so nothing depends on UTC offsets or gets shifted by DST.

export const pad = (n) => String(n).padStart(2, '0');

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Returns a local Date at midnight, or null if the string is not a real calendar date. */
export function parseDateStr(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 2999) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

export const isValidDateStr = (s) => parseDateStr(s) !== null;

export const isValidTimeStr = (s) =>
  typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function timeToMinutes(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export function timeStrOf(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function addDays(s, n) {
  const d = parseDateStr(s);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

export function daysInMonth(year, month0) {
  return new Date(year, month0 + 1, 0).getDate();
}

/** Adds months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(s, n) {
  const d = parseDateStr(s);
  const dom = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  t.setDate(Math.min(dom, daysInMonth(t.getFullYear(), t.getMonth())));
  return toDateStr(t);
}

/** Whole days from a to b (b - a). Computed in UTC so DST changes cannot skew it. */
export function diffDays(a, b) {
  const da = parseDateStr(a);
  const db = parseDateStr(b);
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / 86400000);
}

/** 0 = Sunday ... 6 = Saturday */
export const weekdayOf = (s) => parseDateStr(s).getDay();

/** Local Date for a date string plus "HH:MM". */
export function combine(dateStr, timeStr) {
  const d = parseDateStr(dateStr);
  const [h, m] = timeStr.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

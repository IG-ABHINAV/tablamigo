// A trip's dates the way a person writes them, for text the API sends ready to show (a profile's journey timeline).
// QA 1 Nov 2026: the timeline said "2026-11-07 - 2026-11-15".

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** YYYY-MM-DD (a `date` column, as a string or a Date at UTC midnight) to [year, month 0-11, day]. */
function parts(d: string | Date): [number, number, number] {
  const iso = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  const [y, m, day] = iso.split('-').map(Number);
  return [y, m - 1, day];
}

/** "7 – 15 Nov 2026", "28 Nov – 3 Dec 2026", "28 Dec 2026 – 3 Jan 2027", or "7 Nov 2026" for a one-day trip. */
export function tripDateRange(start: string | Date, end: string | Date): string {
  const [y1, m1, d1] = parts(start), [y2, m2, d2] = parts(end);
  if (y1 === y2 && m1 === m2 && d1 === d2) return `${d1} ${MONTHS[m1]} ${y1}`;
  if (y1 !== y2) return `${d1} ${MONTHS[m1]} ${y1} – ${d2} ${MONTHS[m2]} ${y2}`;
  if (m1 !== m2) return `${d1} ${MONTHS[m1]} – ${d2} ${MONTHS[m2]} ${y2}`;
  return `${d1} – ${d2} ${MONTHS[m2]} ${y2}`;
}

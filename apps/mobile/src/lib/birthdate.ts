// The birthday step takes day, month and year in three boxes. People used to month-first dates type the month into the
// day box; "24" then lands in the month box and the date 1977-24-03 does not exist. One US sign-up in Oct 2026 did exactly
// that: the phone's Date rolled month 24 over to a real date, the step let them through, and the save four steps later
// failed 18 times with "Could not save". So the step itself now checks the calendar, and says what to fix.

/** True only for a date that exists, given as YYYY-MM-DD. */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Full years from a YYYY-MM-DD date to today; 0 when the date does not exist. */
export function ageOn(birthdate: string, today = new Date()): number {
  if (!isCalendarDate(birthdate)) return 0;
  const [y, mo, d] = birthdate.split('-').map(Number);
  let a = today.getFullYear() - y;
  if (today < new Date(today.getFullYear(), mo - 1, d)) a--;
  return a;
}

/**
 * What is wrong with the boxes so far, or '' while they are fine or still being typed. Only speaks up once a box is
 * filled, so nobody is told off mid-keystroke. A whole date under 18 (or 100 and over) says so too: the step's Continue
 * button stays off for it, and before 1 Nov 2026 nothing on screen said why.
 */
export function birthdateHint(dob: { d: string; m: string; y: string }, today = new Date()): string {
  const m = +dob.m, d = +dob.d;
  if (dob.m.length === 2 && (m < 1 || m > 12)) return d >= 1 && d <= 12 ? 'Day goes first, then the month (01-12).' : 'The month goes 01-12.';
  if (dob.d.length === 2 && (d < 1 || d > 31)) return 'The day goes 01-31.';
  if (dob.y.length === 4 && dob.m.length === 2 && dob.d.length === 2 && !isCalendarDate(`${dob.y}-${dob.m}-${dob.d}`)) return "That month doesn't have that day.";
  const iso = `${dob.y}-${dob.m.padStart(2, '0')}-${dob.d.padStart(2, '0')}`;
  if (dob.y.length === 4 && dob.m && dob.d && isCalendarDate(iso)) {
    const age = ageOn(iso, today);
    if (age < 18) return 'You must be 18 or older to use Tablamigo.';
    if (age >= 100) return 'Check the year.';
  }
  return '';
}

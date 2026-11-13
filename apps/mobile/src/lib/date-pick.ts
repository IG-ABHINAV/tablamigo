// Date and time picking (components/DateField.tsx), the parts that are plain arithmetic, so they are unit-tested.
//
// Android's Material date picker works in UTC days: it shows the UTC day of the millis it is given and answers with UTC
// midnight of the day tapped (expo-ui DatePickerView.kt). A phone's local midnight is the previous UTC day east of
// Greenwich (India: 18:30 the day before) and a tapped day comes back as the day before west of it, so dates cross the
// boundary as "the same calendar day at UTC midnight" both ways.

/** Local midnight of `d`'s calendar day. */
export const localDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** The local calendar day of `d` as UTC midnight of that same day: what the Android date picker expects. */
export const toPickerDay = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));

/** A UTC-midnight day from the Android date picker back to local midnight of that same calendar day. */
export const fromPickerDay = (d: Date) => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Whole calendar days from `a` to `b` (local), DST-safe. */
export const daysBetween = (a: Date, b: Date) =>
  Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);

const pad = (n: number) => String(n).padStart(2, '0');

/** The value of a browser <input type="date|time|datetime-local"> for `d` (local time). */
export function webInputValue(mode: 'date' | 'time' | 'datetime', d: Date): string {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return mode === 'date' ? day : mode === 'time' ? time : `${day}T${time}`;
}

/** A browser input's value back to a local Date (time-only keeps `base`'s day); null for an empty or bad value. */
export function fromWebInput(mode: 'date' | 'time' | 'datetime', v: string, base = new Date()): Date | null {
  const m = mode === 'date' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
    : mode === 'time' ? /^(\d{2}):(\d{2})/.exec(v)
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  const d = mode === 'date' ? new Date(n[0], n[1] - 1, n[2])
    : mode === 'time' ? new Date(base.getFullYear(), base.getMonth(), base.getDate(), n[0], n[1])
    : new Date(n[0], n[1] - 1, n[2], n[3], n[4]);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `d`'s day with `time`'s hours and minutes. */
export const withTime = (d: Date, time: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), time.getHours(), time.getMinutes());

/** Keep a picked moment inside [min, max]; a day picker's min/max compare by day only. */
export function clampDate(d: Date, min?: Date, max?: Date): Date {
  if (min && d.getTime() < min.getTime()) return new Date(min);
  if (max && d.getTime() > max.getTime()) return new Date(max);
  return d;
}

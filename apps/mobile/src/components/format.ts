export function when(iso: string) {
  const d = new Date(iso); const now = new Date();
  const mins = Math.round((d.getTime() - now.getTime()) / 60000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (mins < -30) return 'Started';
  if (mins <= 15) return 'Happening now';
  if (mins < 60) return `In ${mins} min`;
  const sameDay = d.toDateString() === now.toDateString();
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  if (sameDay) return `Today · ${time}`;
  if (d.toDateString() === tmr.toDateString()) return `Tomorrow · ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${time}`;
}
export const km = (m?: number | null) => (m == null ? '' : m < 950 ? `${Math.max(100, Math.round(m / 100) * 100)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
export const range = (a: string, b: string) => {
  const f = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${f(a)} – ${f(b)}`;
};
export const daysUntil = (d: string) => Math.ceil((new Date(d + 'T00:00:00').getTime() - Date.now()) / 86400000);
export const dayLabel = (iso: string) => {
  const d = new Date(iso), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
};
/** Section a plan list by start day: "Today" (also for plans already under way), "Tomorrow", then "Sat 4 Oct". */
export const planDay = (iso: string) => {
  const d = new Date(iso), now = new Date(), t = new Date(now); t.setDate(now.getDate() + 1);
  if (d.getTime() <= now.getTime() || d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === t.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
};

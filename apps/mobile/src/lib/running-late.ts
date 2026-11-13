// When "running late" makes sense (the API's RUNNING_LATE_WINDOW in routes/activities.ts): from an hour before a plan starts
// until an hour after. The chat's "Late?" chip and the plan screen's buttons show only then; 3 of 7 real hosts tapped it right
// after creating plans that started hours or days later. Pure, so e2e-web/running-late.test.mjs runs it under node --test.
export const RUNNING_LATE = { beforeMins: 60, afterMins: 60 };

export function runningLateOpen(startsAt: string | null | undefined, now = Date.now()): boolean {
  const start = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(start)) return false;
  return now >= start - RUNNING_LATE.beforeMins * 60_000 && now <= start + RUNNING_LATE.afterMins * 60_000;
}

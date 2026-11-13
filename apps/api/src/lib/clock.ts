/**
 * The server's idea of "now" for logic that is computed in JavaScript rather than in SQL (the weekend window of the plan
 * list, when a recurring plan is next due). Code reads the time through `clock.now()`, so a test can pin it
 * (`vi.spyOn(clock, 'now').mockReturnValue(...)`) instead of depending on the day it happens to run.
 */
export const clock = { now: (): Date => new Date() };

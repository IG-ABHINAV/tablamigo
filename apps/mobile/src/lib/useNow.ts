import { useEffect, useState } from 'react';

/**
 * The current time in milliseconds, refreshed every `everyMs` (30 seconds by default), for a screen whose look depends on
 * "now": has this plan started, has this live location ended. Reading Date.now() while rendering is not allowed (a render
 * has to give the same answer every time it runs), so the time lives in state and a timer moves it forward.
 */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

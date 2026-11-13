import { useCallback, useEffect, useRef } from 'react';

/**
 * A function with a stable identity that always calls the latest `fn`. For a long-lived listener, such as the
 * PanResponder in a chat bubble, that is created once but must call whatever the parent passed most recently, without
 * the listener being rebuilt on every render (a rebuild in the middle of a swipe loses the swipe).
 * The ref is only written in an effect and only read when the returned function is called, never during render.
 */
export function useLatest<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  return useCallback((...args: A) => ref.current(...args), []);
}

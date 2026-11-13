// Is something modal on screen right now: a sheet or dialog (components/Modal.tsx counts every open one) or a screen presented
// as a modal (paywall, new plan, new trip, pick a city; the root layout reports the route). The store rating ask
// (lib/review-trigger.ts) waits while either is open, so it never lands on top of something the person is doing.
import { useEffect } from 'react';

let open = 0;
let modalRoute = false;

export const MODAL_ROUTES = ['/paywall', '/activity/new', '/trip/new', '/pick-city'];
export const overlayOpen = () => open > 0 || modalRoute;
export const setModalRoute = (pathname: string | null | undefined) => { modalRoute = !!pathname && MODAL_ROUTES.includes(pathname); };

/** Counts this modal as open while `visible` is true. */
export function useOverlay(visible: boolean) {
  useEffect(() => {
    if (!visible) return;
    open++;
    return () => { open = Math.max(0, open - 1); };
  }, [visible]);
}

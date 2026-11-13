// Where the welcome screen's "Example plan" bubbles go in the space above the headline. They used to sit at fixed
// percentages of that space, which on a short screen (iPhone Safari with its toolbars, iPhone SE, Android with a nav bar)
// stacked them on top of each other and on the headline. Now: only as many as fit without touching (including the 8px
// float animation), spaced evenly, centred, alternating left and right. No DOM or React so it can be unit-tested.

export const BUBBLE_H = 50;   // 34px icon + 2 x 8px padding
export const FLOAT = 8;       // the bob animation's travel (welcome.tsx)
export const MIN_GAP = FLOAT + 6;
export const MAX_STEP = BUBBLE_H + 34; // on tall screens, keep them a group rather than spread to the corners

export type BubbleSlot = { top: number; side: 'left' | 'right' };

export function bubbleLayout(areaHeight: number, count: number): BubbleSlot[] {
  if (!(areaHeight > 0) || count <= 0) return [];
  // The animation moves a bubble up by FLOAT, so the first needs that much room above it.
  const usable = areaHeight - FLOAT;
  const n = Math.min(count, Math.floor((usable + MIN_GAP) / (BUBBLE_H + MIN_GAP)));
  if (n <= 0) return [];
  const step = n > 1 ? Math.min(MAX_STEP, (usable - BUBBLE_H) / (n - 1)) : 0;
  const total = step * (n - 1) + BUBBLE_H;
  const offset = FLOAT + Math.max(0, (usable - total) / 2);
  return Array.from({ length: n }, (_, i) => ({ top: Math.round(offset + i * step), side: i % 2 ? 'right' : 'left' }));
}

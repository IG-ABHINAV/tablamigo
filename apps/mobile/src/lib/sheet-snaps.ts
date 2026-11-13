// Where the Explore bottom sheet (components/Sheet.tsx) stops, from the window's height at the moment. Plain numbers, so the
// unit tests can check them without a renderer.

/** Fully open, the sheet covers this share of the window. */
export const SHEET_FULL = 0.86;

/** The sheet is window-tall and, fully open, starts (1 - full) of the window down, so that much of its content sits below the screen. */
export const sheetHiddenBelow = (windowHeight: number, full = SHEET_FULL) => Math.round(windowHeight * (1 - full));

/** The sheet's top edge at peek, half and full, in that order (y from the top of the window). */
export function sheetSnaps(windowHeight: number, { peek = 170, half = 0.5, full = SHEET_FULL } = {}): [number, number, number] {
  return [windowHeight - peek, windowHeight * (1 - half), windowHeight * (1 - full)];
}

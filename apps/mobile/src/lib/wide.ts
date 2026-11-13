// The web app on a tablet or desktop: screens are built for a phone, and stretched to 1440px a plan page had a 1400px
// "Join chat" button and lines too long to read. On wide web windows every screen except the Explore map is a centred
// column of phone-to-tablet width; phones (and the native apps) are untouched. No React here so it can be unit-tested.

/** Widest a screen's content gets on the web. Wide enough for the iPad portrait layout (768) to stay full width. */
export const COLUMN_MAX = 760;
/** Below this window width the column is the whole window anyway. */
export const WIDE_FROM = COLUMN_MAX + 64;

export type ColumnStyle = { width: '100%'; maxWidth: number; alignSelf: 'center'; borderLeftWidth: number; borderRightWidth: number; borderColor: string };

export const isWide = (platform: string, windowWidth: number) => platform === 'web' && windowWidth >= WIDE_FROM;

/** Style for a screen container: a centred column with hairline sides on wide web windows, nothing otherwise. */
export function columnStyle(platform: string, windowWidth: number, line = '#EEEBE7'): ColumnStyle | undefined {
  return isWide(platform, windowWidth) ? { width: '100%', maxWidth: COLUMN_MAX, alignSelf: 'center', borderLeftWidth: 1, borderRightWidth: 1, borderColor: line } : undefined;
}

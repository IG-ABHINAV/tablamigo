// Design tokens. Warm, minimal, generous whitespace; one accent colour.
// ink3 and go were #9C9CAD and #10B39F until 2 Nov 2026: 2.7:1 and 2.6:1 on white (the inactive tab labels, hints, "2/6 going",
// white "Join chat"). Both are now at least 4.5:1 on bg, bgSoft and card (tests/unit/contrast.test.mjs); go is the teal the
// emails and the admin already use for text (#0A7C6E). The website keeps #10B39F as a fill.
export const C = {
  primary: '#FF5A36', primaryDark: '#E0421F', primarySoft: '#FFEDE7',
  ink: '#16161D', ink2: '#55556A', ink3: '#6E6E82',
  line: '#EEEBE7', bg: '#FFFFFF', bgSoft: '#FAF7F4', card: '#FFFFFF',
  go: '#0A7C6E', goSoft: '#E3F7F4', women: '#8E5CF7', womenSoft: '#F1EAFF',
  danger: '#E5484D', overlay: 'rgba(22,22,29,0.45)',
};

export const DARK_THEME_MIDNIGHT = {
  primary: '#FF5A36', primaryDark: '#FF7354', primarySoft: '#2E1812',
  ink: '#F5F5F7', ink2: '#A1A1B2', ink3: '#6C6C7E',
  line: '#282834', bg: '#121217', bgSoft: '#1A1A22', card: '#1D1D27',
  go: '#10B39F', goSoft: '#0F2B27', women: '#A379F7', womenSoft: '#241938',
  danger: '#FF6369', overlay: 'rgba(0,0,0,0.7)',
};

export const DARK_THEME_OLED = {
  primary: '#FF5A36', primaryDark: '#FF7354', primarySoft: '#24120D',
  ink: '#FFFFFF', ink2: '#A8A8BD', ink3: '#6B6B7F',
  line: '#22222C', bg: '#000000', bgSoft: '#0C0C10', card: '#14141A',
  go: '#10B39F', goSoft: '#0C2420', women: '#A379F7', womenSoft: '#201633',
  danger: '#FF6369', overlay: 'rgba(0,0,0,0.85)',
};

export function getThemeColors(theme?: 'system' | 'light' | 'dark', oledDark = false, highContrast = false) {
  if (theme === 'dark') {
    const base = oledDark ? DARK_THEME_OLED : DARK_THEME_MIDNIGHT;
    return highContrast ? { ...base, line: '#424254', ink2: '#C0C0D4' } : base;
  }
  return highContrast ? { ...C, line: '#D0CDC8', ink2: '#3A3A4A' } : C;
}

export const F = {
  xb: 'PlusJakartaSans_800ExtraBold', b: 'PlusJakartaSans_700Bold', sb: 'PlusJakartaSans_600SemiBold',
  m: 'PlusJakartaSans_500Medium', r: 'PlusJakartaSans_400Regular',
};
export const R = { sm: 10, md: 16, lg: 22, xl: 28, pill: 999 };
/** The bottom tab bar's height ((tabs)/_layout.tsx). Screens that lay content out behind it (the Explore sheet) pad for it. */
export const TAB_BAR_HEIGHT = 72;
/** The tab bar's real height: its 72 px plus the system navigation bar or home indicator under it (safe-area bottom inset). */
export const tabBarHeight = (bottomInset: number) => TAB_BAR_HEIGHT + Math.max(0, bottomInset || 0);
export const shadow = {
  shadowColor: '#16161D', shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6,
};
export const CATEGORIES = [
  { id: 'all', label: 'All', emoji: '✨' },
  { id: 'food', label: 'Food', emoji: '🍜' },
  { id: 'drinks', label: 'Drinks', emoji: '🍸' },
  { id: 'nightlife', label: 'Nightlife', emoji: '🪩' },
  { id: 'explore', label: 'Explore', emoji: '🧭' },
  { id: 'outdoors', label: 'Outdoors', emoji: '🏝️' },
  { id: 'culture', label: 'Culture', emoji: '🎨' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'work', label: 'Cowork', emoji: '💻' },
] as const;
export const flag = (cc?: string | null) =>
  cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌍';

// Interest ids are stored lowercase; this is how they're shown.
const INTEREST_EMOJI: Record<string, string> = {
  food: '🍜', drinks: '🍸', nightlife: '🪩', coffee: '☕', hiking: '🥾', beach: '🏖️', museums: '🏛️', art: '🎨',
  music: '🎵', 'live music': '🎸', sports: '⚽', gym: '🏋️', yoga: '🧘', photography: '📸', coworking: '💻',
  startups: '🚀', 'language exchange': '🗣️', dancing: '💃', markets: '🛍️', 'street food': '🌮', surfing: '🏄',
  diving: '🤿', cycling: '🚴', gaming: '🎮', books: '📚', film: '🎬', wine: '🍷', vegan: '🥗',
};
export const interestLabel = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
export const interestEmoji = (id: string) => INTEREST_EMOJI[id];

export const TRAVEL_STYLES = [
  { id: 'budget', label: 'Budget', emoji: '🪙' },
  { id: 'luxury', label: 'Luxury', emoji: '✨' },
  { id: 'early bird', label: 'Early bird', emoji: '🌅' },
  { id: 'night owl', label: 'Night owl', emoji: '🦉' },
  { id: 'planner', label: 'Planner', emoji: '📋' },
  { id: 'spontaneous', label: 'Spontaneous', emoji: '⚡' },
  { id: 'foodie', label: 'Foodie', emoji: '🍜' },
  { id: 'hiker', label: 'Hiker', emoji: '🥾' },
  { id: 'party', label: 'Party', emoji: '🪩' },
  { id: 'culture', label: 'Culture', emoji: '🏛️' },
] as const;

export const travelStyleLabel = (id: string) => TRAVEL_STYLES.find(s => s.id === id)?.label ?? id;
export const travelStyleEmoji = (id: string) => TRAVEL_STYLES.find(s => s.id === id)?.emoji ?? '✈️';

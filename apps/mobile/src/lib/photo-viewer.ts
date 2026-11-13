// The full-screen photo viewer's rules (components/PhotoViewer.tsx), kept free of React so they are unit tested
// (tests/unit/photo-viewer.test.mjs). One viewer for every photo a person can tap: feed moments, a moment page,
// meetup photos on a plan, profile photos and chat images.

/** One photo in the viewer, with what it says about itself. Everything but the url is optional. */
export type ViewerPhoto = {
  id?: string;
  url: string;
  caption?: string | null;
  authorId?: string | null;
  authorName?: string | null;
  authorPhoto?: string | null;
  authorCountry?: string | null;
  /** ISO time it was posted. */
  at?: string | null;
  /** Where it was taken ('Mapusa'), with the country code that makes its city page link. */
  place?: string | null;
  placeCountry?: string | null;
};

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** A double tap zooms to this, and a second double tap back to 1. */
export const DOUBLE_TAP_ZOOM = 2.5;

// clampZoom, panBounds and tapOutside run inside gesture callbacks on the UI thread (Reanimated worklets), hence 'worklet'.
// Under node (the unit tests) the directive is a plain string and changes nothing.
export function clampZoom(s: number) {
  'worklet';
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(s) ? s : MIN_ZOOM));
}

/** The next photo's index, never past either end. */
export const stepIndex = (i: number, delta: number, count: number) => Math.min(Math.max(0, count - 1), Math.max(0, i + delta));

/** The page index a horizontal pager rests on at offset x, for pages `width` wide. */
export const pageAt = (x: number, width: number, count: number) => (width > 0 ? stepIndex(Math.round(x / width), 0, count) : 0);

/** What a key does in the viewer on the web: Escape closes, the arrows move one photo. */
export function viewerKey(key: string): 'close' | -1 | 1 | null {
  if (key === 'Escape' || key === 'Esc') return 'close';
  if (key === 'ArrowLeft') return -1;
  if (key === 'ArrowRight') return 1;
  return null;
}

/**
 * How far a photo zoomed by `scale` may be dragged before its edge leaves the screen edge: half of what the zoomed
 * photo overhangs on each axis (0 when it doesn't overhang).
 */
export function panBounds(scale: number, shown: { width: number; height: number }, box: { width: number; height: number }) {
  'worklet';
  return {
    x: Math.max(0, (shown.width * scale - box.width) / 2),
    y: Math.max(0, (shown.height * scale - box.height) / 2),
  };
}

/** The size a photo of `natural` size is drawn at, fitted inside `box` without cropping (contentFit contain). */
export function fitted(natural: { width: number; height: number } | null, box: { width: number; height: number }) {
  if (!natural || natural.width <= 0 || natural.height <= 0) return { width: box.width, height: box.height };
  const k = Math.min(box.width / natural.width, box.height / natural.height);
  return { width: natural.width * k, height: natural.height * k };
}

/** True when a tap at (x, y) in `box` lands outside the fitted photo, i.e. on the dark backdrop: that closes the viewer. */
export function tapOutside(x: number, y: number, shown: { width: number; height: number }, box: { width: number; height: number }) {
  'worklet';
  const left = (box.width - shown.width) / 2, top = (box.height - shown.height) / 2;
  return x < left || x > left + shown.width || y < top || y > top + shown.height;
}

const MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;
const PLAIN: Record<string, string> = { 'đ': 'd', 'ð': 'd', 'ø': 'o', 'ł': 'l', 'ı': 'i', 'þ': 'th', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss' };

/**
 * The city page for a place ('Mapusa', 'IN' -> '/city/mapusa-in'), the same key the API builds (apps/api/src/lib/geo.ts
 * cityKey). Without a country it is the bare slug, which the API also resolves. Null for no place or 'Worldwide' (the
 * moment fallback when nobody said where).
 */
export function placeRoute(place?: string | null, country?: string | null): string | null {
  const name = (place ?? '').trim();
  if (!name || /^worldwide$/i.test(name)) return null;
  const slug = name.toLowerCase().normalize('NFKD').replace(MARKS, '').replace(/[đðøłıþæœß]/g, c => PLAIN[c]).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (slug.length < 2) return null;
  const cc = (country ?? '').trim().toLowerCase();
  return `/city/${/^[a-z]{2}$/.test(cc) ? `${slug}-${cc}` : slug}`;
}

/** A feed or moment-page moment as a viewer photo. */
export const momentPhoto = (m: any): ViewerPhoto => ({
  id: m.id, url: m.imageUrl, caption: m.caption ?? null,
  authorId: m.userId ?? null, authorName: m.userName ?? null, authorPhoto: m.userPhoto ?? null, authorCountry: m.userCountry ?? null,
  at: m.createdAt ?? null, place: m.city ?? null, placeCountry: m.countryCode ?? null,
});

/** The feed's moments that have a photo, and where the tapped one sits among them, so a swipe moves to the next post's photo. */
export function feedPhotos(moments: any[], tappedId: string): { photos: ViewerPhoto[]; index: number } {
  const photos = (moments ?? []).filter(m => !!m?.imageUrl).map(momentPhoto);
  return { photos, index: Math.max(0, photos.findIndex(p => p.id === tappedId)) };
}

/** A plan's meetup photos (GET /activities/:id/photos) as viewer photos. */
export const planPhotos = (photos: any[]): ViewerPhoto[] => (photos ?? []).filter(p => !!p?.url).map(p => ({
  id: p.id, url: p.url, caption: p.caption ?? null,
  authorId: p.user?.id ?? null, authorName: p.user?.name ?? null, authorPhoto: p.user?.photoUrl ?? null, at: p.createdAt ?? null,
}));

/** The image messages loaded in a chat, oldest first, and where the tapped one sits. */
export function chatPhotos(msgs: any[], tappedId: string): { photos: ViewerPhoto[]; index: number } {
  const photos = (msgs ?? []).filter(m => m?.kind === 'image' && !!m.body && !m.deletedAt)
    .map(m => ({ id: m.id, url: m.body, authorId: m.senderId ?? null, authorName: m.senderName ?? null, authorPhoto: m.senderPhoto ?? null, at: m.createdAt ?? null }) as ViewerPhoto)
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  return { photos, index: Math.max(0, photos.findIndex(p => p.id === tappedId)) };
}

// The full-screen photo viewer's rules (src/lib/photo-viewer.ts, used by src/components/PhotoViewer.tsx): which photos it
// swipes through, where it opens, zoom and drag limits, what closes it, and the place link ('📍 Mapusa' -> /city/mapusa-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, stepIndex, pageAt, viewerKey, panBounds, fitted, tapOutside, placeRoute, feedPhotos, planPhotos, chatPhotos, momentPhoto, MAX_ZOOM } from '../../src/lib/photo-viewer.ts';

test('the place link is the same city key the API builds', () => {
  assert.equal(placeRoute('Mapusa', 'IN'), '/city/mapusa-in');
  assert.equal(placeRoute('Mapusa', 'in'), '/city/mapusa-in');
  assert.equal(placeRoute('Ho Chi Minh City', 'VN'), '/city/ho-chi-minh-city-vn');
  assert.equal(placeRoute('Medellín', 'CO'), '/city/medellin-co');          // accents dropped, not dashed (geo.ts cityKey)
  assert.equal(placeRoute('Üsküdar', 'TR'), '/city/uskudar-tr');
  assert.equal(placeRoute('Goa'), '/city/goa');                             // no country: the bare slug, which the API resolves too
  assert.equal(placeRoute('Goa', 'India'), '/city/goa');                     // not a 2-letter code: ignored
});

test('no place link for no place, the Worldwide fallback, or a name with no letters', () => {
  for (const p of [null, undefined, '', '   ', 'Worldwide', 'worldwide', '!!', 'x']) assert.equal(placeRoute(p, 'IN'), null, String(p));
});

test('a feed photo opens on the tapped post and swipes through the other posts that have a photo', () => {
  const moments = [
    { id: 'a', imageUrl: 'https://x/a.jpg', caption: 'one', userId: 'u1', userName: 'Asha', city: 'Mapusa', countryCode: 'IN' },
    { id: 'b', imageUrl: null, caption: 'text only' },
    { id: 'c', imageUrl: 'https://x/c.jpg', caption: 'three', userId: 'u2', userName: 'Ben' },
  ];
  const r = feedPhotos(moments, 'c');
  assert.deepEqual(r.photos.map(p => p.id), ['a', 'c']);
  assert.equal(r.index, 1);
  assert.deepEqual({ ...r.photos[0] }, { ...momentPhoto(moments[0]) });
  assert.equal(r.photos[0].authorName, 'Asha');
  assert.equal(r.photos[0].place, 'Mapusa');
  assert.equal(r.photos[0].placeCountry, 'IN');
  assert.equal(r.photos[0].caption, 'one');
  // A post that left the list (deleted while open) opens on the first photo, not -1.
  assert.equal(feedPhotos(moments, 'gone').index, 0);
  assert.deepEqual(feedPhotos(null, 'x'), { photos: [], index: 0 });
});

test('plan photos keep their caption and author', () => {
  const r = planPhotos([{ id: 'p1', url: 'https://x/1.jpg', caption: 'sunset', user: { id: 'u', name: 'Cara', photoUrl: 'https://x/c.jpg' }, createdAt: '2026-11-01T10:00:00Z' }, { id: 'p2' }]);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { id: 'p1', url: 'https://x/1.jpg', caption: 'sunset', authorId: 'u', authorName: 'Cara', authorPhoto: 'https://x/c.jpg', at: '2026-11-01T10:00:00Z' });
});

test('chat photos: only image messages, oldest first, deleted ones left out', () => {
  const msgs = [
    { id: '3', kind: 'image', body: 'https://x/3.jpg', createdAt: '2026-11-01T03:00:00Z', senderId: 's', senderName: 'Dev' },
    { id: '1', kind: 'image', body: 'https://x/1.jpg', createdAt: '2026-11-01T01:00:00Z' },
    { id: '2', kind: 'text', body: 'hi', createdAt: '2026-11-01T02:00:00Z' },
    { id: '4', kind: 'image', body: '', deletedAt: '2026-11-01T04:00:00Z', createdAt: '2026-11-01T04:00:00Z' },
  ];
  const r = chatPhotos(msgs, '3');
  assert.deepEqual(r.photos.map(p => p.id), ['1', '3']);
  assert.equal(r.index, 1);
  assert.equal(r.photos[1].authorName, 'Dev');
});

test('swiping and the arrows never go past either end', () => {
  assert.equal(stepIndex(0, -1, 3), 0);
  assert.equal(stepIndex(2, 1, 3), 2);
  assert.equal(stepIndex(1, 1, 3), 2);
  assert.equal(stepIndex(5, 0, 3), 2);
  assert.equal(stepIndex(0, 1, 0), 0);
  assert.equal(pageAt(780, 390, 3), 2);
  assert.equal(pageAt(560, 390, 3), 1);          // past half a page rounds to the next one
  assert.equal(pageAt(9999, 390, 3), 2);
  assert.equal(pageAt(100, 0, 3), 0);
});

test('keys on the web: Escape closes, arrows move, anything else does nothing', () => {
  assert.equal(viewerKey('Escape'), 'close');
  assert.equal(viewerKey('Esc'), 'close');
  assert.equal(viewerKey('ArrowLeft'), -1);
  assert.equal(viewerKey('ArrowRight'), 1);
  for (const k of ['Enter', ' ', 'a', 'ArrowUp']) assert.equal(viewerKey(k), null);
});

test('zoom stays between 1x and the maximum', () => {
  assert.equal(clampZoom(0.3), 1);
  assert.equal(clampZoom(2), 2);
  assert.equal(clampZoom(40), MAX_ZOOM);
  assert.equal(clampZoom(NaN), 1);
});

test('a photo is fitted without cropping, and a zoomed one drags only as far as it overhangs', () => {
  const box = { width: 400, height: 800 };
  assert.deepEqual(fitted({ width: 2000, height: 1000 }, box), { width: 400, height: 200 });   // landscape: full width
  assert.deepEqual(fitted({ width: 1000, height: 4000 }, box), { width: 200, height: 800 });   // tall: full height
  assert.deepEqual(fitted(null, box), box);                                                     // before it loads: the box
  assert.deepEqual(panBounds(1, { width: 400, height: 200 }, box), { x: 0, y: 0 });
  assert.deepEqual(panBounds(2, { width: 400, height: 200 }, box), { x: 200, y: 0 });           // 800 wide in a 400 box
  assert.deepEqual(panBounds(4, { width: 400, height: 200 }, box), { x: 600, y: 0 });
});

test('a tap beside the photo (on the dark backdrop) closes; a tap on the photo does not', () => {
  const box = { width: 400, height: 800 }, shown = { width: 400, height: 200 };   // the photo spans y 300..500
  assert.equal(tapOutside(200, 100, shown, box), true);
  assert.equal(tapOutside(200, 700, shown, box), true);
  assert.equal(tapOutside(200, 400, shown, box), false);
  assert.equal(tapOutside(10, 310, shown, box), false);
});

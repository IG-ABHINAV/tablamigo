// searchPlaces (lib/geo.ts): the Photon lookup behind the admin "Create plan as Tablamigo team" place search. Real results only,
// cleaned city names, and an empty list (never a guess) when Photon fails.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { searchPlaces } from '../../lib/geo.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
const photon = (features: unknown[], status = 200) => vi.fn(async () => new Response(JSON.stringify({ features }), { status }));
const feat = (props: Record<string, unknown>, coordinates: unknown = [115.26, -8.5]) => ({ geometry: { coordinates }, properties: props });

describe('searchPlaces', () => {
  it('maps Photon features: [lng, lat] to lat/lng, country upper-cased, detail joined', async () => {
    const f = photon([feat({ name: 'Clear Cafe', city: 'Ubud', countrycode: 'id', street: 'Jalan Hanoman', district: 'Padangtegal', state: 'Bali' })]);
    globalThis.fetch = f as any;
    const r = await searchPlaces('Clear Cafe Ubud', { lat: -8.5, lng: 115.26 });
    expect(r).toEqual([{ name: 'Clear Cafe', city: 'Ubud', country: 'ID', lat: -8.5, lng: 115.26, detail: 'Jalan Hanoman, Padangtegal, Bali' }]);
    const url = String((f.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('q=Clear%20Cafe%20Ubud');
    expect(url).toContain('lat=-8.5&lon=115.26');
  });
  it('drops features without a name or a point', async () => {
    globalThis.fetch = photon([feat({ city: 'No name' }), feat({ name: 'No point' }, []), feat({ name: 'Ok', city: 'Riga' }, [24.1, 56.9])]) as any;
    expect((await searchPlaces('x')).map(p => p.name)).toEqual(['Ok']);
  });
  it('returns [] on an HTTP error, a thrown fetch and bad JSON', async () => {
    globalThis.fetch = photon([], 503) as any;
    expect(await searchPlaces('x')).toEqual([]);
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); }) as any;
    expect(await searchPlaces('x')).toEqual([]);
    globalThis.fetch = vi.fn(async () => new Response('<html>', { status: 200 })) as any;
    expect(await searchPlaces('x')).toEqual([]);
  });
});

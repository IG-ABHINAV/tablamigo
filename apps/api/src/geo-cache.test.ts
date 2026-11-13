// lib/geo.ts: a reverse-geocode that finds a country but no city is cached, so an SOS there can use the country.
import { describe, it, expect, afterAll, vi } from 'vitest';

const { cityFor, cachedCountry } = await import('./lib/geo.js');
const { sql } = await import('./lib/db.js');

const SPOT = { lat: 24.6502, lng: 46.7101 };   // geo cell '24.65,46.7'
const CELL = '24.65,46.7';
const reply = (address: object) => vi.fn(async () => new Response(JSON.stringify({ address }), { status: 200, headers: { 'content-type': 'application/json' } }));

afterAll(async () => { vi.unstubAllGlobals(); await sql`delete from geo_cache where cell = ${CELL}`; await sql.end(); });

describe('geo cache', () => {
  it('exploit: a cell with a country but no city was never cached, so every SOS there fell back to 112', async () => {
    await sql`delete from geo_cache where cell = ${CELL}`;
    vi.stubGlobal('fetch', reply({ country_code: 'sa' }));   // Nominatim: a country, no city/town/village/county
    expect(await cityFor(SPOT.lat, SPOT.lng)).toEqual({ city: null, country: 'SA' });
    const [row] = await sql`select city, country from geo_cache where cell = ${CELL}`;
    expect(row).toEqual({ city: null, country: 'SA' });

    // The next read is answered from the cache alone, with no lookup.
    const f = vi.fn(async () => { throw new Error('no network expected'); });
    vi.stubGlobal('fetch', f);
    expect(await cachedCountry(SPOT.lat, SPOT.lng)).toBe('SA');
    expect(f).not.toHaveBeenCalled();
  });

  it('still caches nothing when the lookup finds neither a city nor a country', async () => {
    await sql`delete from geo_cache where cell = ${CELL}`;
    vi.stubGlobal('fetch', reply({}));
    expect(await cityFor(SPOT.lat, SPOT.lng)).toEqual({ city: null, country: null });
    expect((await sql`select 1 from geo_cache where cell = ${CELL}`).length).toBe(0);
  });
});

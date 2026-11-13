// tests/network-guard.ts, installed by both setup files: the suites never reach the internet, and the geocoder answers the
// same way on every run.
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import https from 'node:https';
import { fakeNominatim, isLocalHost } from '../network-guard.js';

const reverse = (lat: number, lng: number) => `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=en&lat=${lat}&lon=${lng}`;

describe('network guard', () => {
  it('answers Nominatim from the fixed table: nearest city within 50 km, else "Unable to geocode"', async () => {
    expect(await (await fetch(reverse(13.7466, 100.5346))).json()).toEqual({ address: { city: 'Bangkok', country_code: 'th' } });
    expect(await (await fetch(reverse(38.85, -9.15))).json()).toEqual({ address: { city: 'Lisbon', country_code: 'pt' } });
    expect(await (await fetch(reverse(0, 0))).json()).toEqual({ error: 'Unable to geocode' });
    expect(fakeNominatim(new URL(reverse(18.95, 72.8))).status).toBe(200);
  });

  it('answers Photon with no places', async () => {
    expect(await (await fetch('https://photon.komoot.io/api/?q=Wat%20Arun&lat=13.7&lon=100.5')).json()).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('refuses fetch to any other outside host', async () => {
    await expect(fetch('https://api.openai.com/v1/moderations')).rejects.toThrow(/no outside requests \(tried api\.openai\.com\)/);
    await expect(fetch(new URL('https://example.com/'))).rejects.toThrow(/example\.com/);
  });

  it('refuses raw TCP/TLS to a non-local host (what node-fetch, web-push and the S3 SDK use)', async () => {
    const tcp = await new Promise<Error>(ok => net.connect({ host: '203.0.113.7', port: 443 }).on('error', ok));
    expect(tcp.message).toMatch(/no outside connections \(tried 203\.0\.113\.7\)/);
    const tls = await new Promise<Error>(ok => https.get('https://www.googleapis.com/oauth2/v1/certs').on('error', ok));
    expect(tls.message).toMatch(/www\.googleapis\.com/);
  });

  it('lets loopback through', async () => {
    expect(['localhost', '127.0.0.1', '::1', '[::1]', '127.0.0.53', 'app.localhost'].every(isLocalHost)).toBe(true);
    expect(['example.com', '10.0.0.5', 'localhost.example.com'].some(isLocalHost)).toBe(false);
    const refused = await new Promise<Error>(ok => net.connect({ host: '127.0.0.1', port: 1 }).on('error', ok));
    expect(refused.message).toMatch(/ECONNREFUSED/);
    expect(refused.message).not.toMatch(/outside/);
  });
});

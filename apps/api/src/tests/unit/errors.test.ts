// The helpers every route raises (lib/errors.ts): each one fixes the status and the code the app maps to its own copy
// (apps/mobile/src/lib/api.ts FRIENDLY), so a regression here changes what every client shows for every 4xx. They had no
// direct test (issue #17). Pure values, so this belongs in the unit project, not the integration one.
import { describe, it, expect } from 'vitest';
import { HttpError, bad, forbidden, notFound, needsPlus, voiceNotesOff } from '../../lib/errors.js';

describe('HttpError', () => {
  it('is an Error whose message is the detail, falling back to the code', () => {
    const withDetail = new HttpError(418, 'teapot', 'I am a teapot');
    expect(withDetail).toBeInstanceOf(Error);
    expect(withDetail.message).toBe('I am a teapot');
    expect(new HttpError(418, 'teapot').message).toBe('teapot');
  });

  it('keeps the status, code and extra it was constructed with', () => {
    const e = new HttpError(409, 'seat_taken', 'Someone took that seat.', { plan_id: 'p1' });
    expect(e.status).toBe(409);
    expect(e.code).toBe('seat_taken');
    expect(e.extra).toEqual({ plan_id: 'p1' });
    expect(new HttpError(500, 'server_error').extra).toBeUndefined();
  });
});

describe('bad', () => {
  it('is a 400 carrying the caller’s code and message', () => {
    const e = bad('plan_full', 'That plan is full.');
    expect(e.status).toBe(400);
    expect(e.code).toBe('plan_full');
    expect(e.message).toBe('That plan is full.');
    expect(e.extra).toBeUndefined();
  });

  it('falls back to the code when no message is given (the app supplies its own copy)', () => {
    const e = bad('plan_full');
    expect(e.status).toBe(400);
    expect(e.code).toBe('plan_full');
    expect(e.message).toBe('plan_full');
  });
});

describe('forbidden', () => {
  it('is a 403 and defaults to the code forbidden', () => {
    const e = forbidden();
    expect(e.status).toBe(403);
    expect(e.code).toBe('forbidden');
    expect(e.message).toBe('forbidden');
  });

  it('takes its own code and message', () => {
    const e = forbidden('host_only', 'Only the host can edit that.');
    expect(e.status).toBe(403);
    expect(e.code).toBe('host_only');
    expect(e.message).toBe('Only the host can edit that.');
  });
});

describe('notFound', () => {
  it('is a 404 and defaults to the code not_found', () => {
    const e = notFound();
    expect(e.status).toBe(404);
    expect(e.code).toBe('not_found');
    expect(e.message).toBe('not_found');
  });

  it('takes its own code', () => {
    const e = notFound('plan_not_found');
    expect(e.status).toBe(404);
    expect(e.code).toBe('plan_not_found');
    expect(e.message).toBe('plan_not_found');
  });
});

describe('needsPlus', () => {
  it('is a 402 plus_required that names the feature behind it', () => {
    const e = needsPlus('city_chats');
    expect(e.status).toBe(402);
    expect(e.code).toBe('plus_required');
    expect(e.extra).toEqual({ feature: 'city_chats' });
    expect(e.message).toBe('plus_required');
  });
});

describe('voiceNotesOff', () => {
  it('is a 404 with the sentence the app shows instead of a code fallback', () => {
    const e = voiceNotesOff();
    expect(e.status).toBe(404);
    expect(e.code).toBe('voice_notes_unavailable');
    expect(e.message).toBe('Voice notes are not available yet.');
    expect(e.extra).toBeUndefined();
  });
});

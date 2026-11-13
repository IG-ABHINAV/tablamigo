// REVIEW_ASK (lib/config.ts reviewAskEnabled): the store rating ask's kill switch. Off unless exactly "on" (any case, spaces).
import { describe, it, expect } from 'vitest';
import { reviewAskEnabled } from '../../lib/config.js';

describe('REVIEW_ASK', () => {
  it('unset, empty, off or anything but "on": off', () => {
    for (const v of [undefined, '', 'off', 'OFF', 'true', '1', 'yes', 'onn']) expect(reviewAskEnabled(v), String(v)).toBe(false);
  });
  it('"on" in any case, with spaces: on', () => {
    for (const v of ['on', 'ON', ' On ']) expect(reviewAskEnabled(v), v).toBe(true);
  });
});

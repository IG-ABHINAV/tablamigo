// lib/security-headers.ts, pure parts: which headers for which response, and how a CSP report is reduced to a log line.
import { describe, it, expect } from 'vitest';
import { securityHeaders, cspOrigin, cspPage, cspReportLines, API_CSP, HTML_CSP } from '../../lib/security-headers.js';

describe('securityHeaders', () => {
  it('JSON, media and unknown types get the strict policy; HTML its own; HSTS only in production', () => {
    for (const t of ['application/json; charset=utf-8', 'image/webp', '', undefined]) expect(securityHeaders(t, false)['content-security-policy']).toBe(API_CSP);
    expect(securityHeaders('text/html; charset=utf-8', false)['content-security-policy']).toBe(HTML_CSP);
    expect(securityHeaders('application/json', false)).not.toHaveProperty('strict-transport-security');
    expect(securityHeaders('application/json', true)['strict-transport-security']).toBe('max-age=31536000');
    expect(securityHeaders('application/json', false)).toMatchObject({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
  });
});

describe('CSP reports', () => {
  it('keeps only the origin of what was blocked and the path of the page', () => {
    expect(cspOrigin('https://evil.example/x.js?s=1')).toBe('https://evil.example');
    expect(cspOrigin('wss://tablamigo-api.hookstep.in/rt/?EIO=4')).toBe('wss://tablamigo-api.hookstep.in');
    expect(cspOrigin('inline')).toBe('inline');
    expect(cspOrigin('data:image/png;base64,AAAA')).toBe('data');
    expect(cspOrigin('blob:https://x.example/uuid')).toBe('blob');
    expect(cspOrigin('')).toBe('-');
    expect(cspOrigin('not a url at all')).toBe('invalid');
    expect(cspPage('https://tablamigo.hookstep.in/app/chat/1?token=abc#frag')).toBe('tablamigo.hookstep.in/app/chat/1');
    expect(cspPage(undefined)).toBe('-');
  });

  it('reads both formats, at most 10 reports a request, and strips odd characters from the directive', () => {
    expect(cspReportLines({ 'csp-report': { 'violated-directive': "img-src 'self'", 'blocked-uri': 'https://a.example/i.png', 'document-uri': 'https://tablamigo.hookstep.in/' } }))
      .toEqual(['csp report-only: img-srcself blocked https://a.example on tablamigo.hookstep.in/']);
    const many = Array.from({ length: 15 }, () => ({ type: 'csp-violation', body: { effectiveDirective: 'script-src\nInjected', blockedURL: 'eval', documentURL: 'https://tablamigo.hookstep.in/x' } }));
    const lines = cspReportLines(many);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('csp report-only: script-srcInjected blocked eval on tablamigo.hookstep.in/x');
    for (const junk of [null, 'x', 42, {}, [], [{ type: 'other' }]]) expect(cspReportLines(junk)).toEqual([]);
  });
});

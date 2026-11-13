// reportDetails (lib/report-targets.ts): the text a moderator sees in the admin queue — the reporter's own words, then
// what was reported, by whom and in which words (400 characters of it). Pure: no database, no network.
import { describe, it, expect } from 'vitest';
import { REPORT_TARGET_TYPES, reportDetails, type CheckedTarget, type ReportTargetType } from '../../lib/report-targets.js';

const ID = '3f1c9a52-1c6b-4a4e-9d0e-2b7a6f0c1111';
const target = (over: Partial<CheckedTarget> = {}): CheckedTarget => ({ authorId: ID, authorName: 'Maya', text: 'come to my place tonight', ...over });
const line = (label: string, author = 'Maya', text = 'come to my place tonight') => `Reported ${label} by ${author} (user ${ID}): "${text}"`;

describe('reportDetails', () => {
  it('returns the reporter\'s words unchanged when nothing was checked (found is null)', () => {
    expect(reportDetails('spam, DM me', 'user', null)).toBe('spam, DM me');
  });

  it('returns undefined when the reporter wrote nothing and nothing was checked', () => {
    expect(reportDetails(undefined, 'message', null)).toBeUndefined();
  });

  it('cuts reported text over 400 characters and ends it with an ellipsis', () => {
    expect(reportDetails(undefined, 'moment', target({ text: 'x'.repeat(401) }))).toBe(line('moment', 'Maya', `${'x'.repeat(400)}…`));
  });

  it('does not cut text of exactly 400 characters', () => {
    expect(reportDetails(undefined, 'moment', target({ text: 'x'.repeat(400) }))).toBe(line('moment', 'Maya', 'x'.repeat(400)));
  });

  it('says "a traveler" when the author has no name', () => {
    expect(reportDetails(undefined, 'moment', target({ authorName: null }))).toBe(line('moment', 'a traveler'));
  });

  it.each([undefined, '', '   ', '\n\t '])('with no reporter words (%j) shows only the Reported line, with no blank lines', details => {
    expect(reportDetails(details, 'moment', target())).toBe(line('moment'));
  });

  it('trims the reporter\'s words and separates them from the Reported line with one blank line', () => {
    expect(reportDetails('  spam link  ', 'moment', target())).toBe(`spam link\n\n${line('moment')}`);
  });

  // The five checked kinds each read their own way in the queue. 'user', 'activity' and 'message' are never checked
  // (checkReportTarget returns null for them), so found is always null for those and the words pass through untouched.
  const LABEL: Record<ReportTargetType, string | null> = {
    user: null, activity: null, message: null,
    moment: 'moment', moment_comment: 'comment on a moment', plan_comment: 'comment on a plan', city_tip: 'city tip', circle_proposal: 'circle meetup idea',
  };
  it.each(REPORT_TARGET_TYPES)('%s: uses the label the queue shows', type => {
    const label = LABEL[type];
    if (label === null) return expect(reportDetails('words', type, null)).toBe('words');
    expect(reportDetails('words', type, target())).toBe(`words\n\n${line(label)}`);
  });
});

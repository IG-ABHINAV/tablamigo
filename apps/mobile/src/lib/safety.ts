import { create } from 'zustand';

// Values must match the API's report target enum (routes/safety.ts, lib/report-targets.ts).
export type ReportKind = 'user' | 'activity' | 'message' | 'moment' | 'moment_comment' | 'plan_comment' | 'city_tip' | 'circle_proposal';
export type ReportTarget = { type: ReportKind; id: string; userId?: string; userName?: string };

/** What the report sheet calls the thing being reported ("What's wrong with this moment?"). */
export const REPORT_WHAT: Record<ReportKind, string> = {
  user: 'this profile', activity: 'this plan', message: 'this message', moment: 'this moment', moment_comment: 'this comment',
  plan_comment: 'this comment', city_tip: 'this tip', circle_proposal: 'this meetup idea',
};

// Values must match the API's report reason enum (routes/safety.ts).
export const REASONS = [
  { id: 'harassment', label: 'Harassment or threats', emoji: '😠' },
  { id: 'inappropriate', label: 'Sexual or inappropriate content', emoji: '🔞' },
  { id: 'underage', label: 'Looks under 18', emoji: '🧒' },
  { id: 'spam', label: 'Spam, scam or selling', emoji: '💸' },
  { id: 'fake_profile', label: 'Fake profile', emoji: '🎭' },
  { id: 'unsafe', label: 'Made me feel unsafe', emoji: '⚠️' },
] as const;

export const useReport = create<{ target: ReportTarget | null; close: () => void }>(set => ({ target: null, close: () => set({ target: null }) }));

/** Opens the report / block sheet (rendered once by ReportHost in the root layout).
 *  Google Play requires both for apps with user-generated content. */
export function reportSheet(t: ReportTarget) {
  useReport.setState({ target: t });
}

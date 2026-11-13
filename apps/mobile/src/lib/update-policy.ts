// When the app offers the person a Google Play update, and which kind. Plain TypeScript with no Expo or React Native imports,
// so tests/unit/update-policy.test.mjs runs it with fakes; lib/update-prompt.ts applies it on a phone.
//
// The rule (owner, 29 Oct 2026): on app open, at most once every 24 hours, ask Play whether it has a newer versionCode.
// Normally that is a FLEXIBLE update: Play downloads it in the background, the app stays usable, and a small
// "Update ready - Restart" banner appears when it is done. The blocking IMMEDIATE flow is only for an update the app must
// not run without: the API's ANDROID_MIN_VERSION_CODE (GET /app/min-version), or an update the Play Console itself marked
// priority 4 or 5.
//
// Android only. The web app updates itself on reload and there is no iOS build; both are no-ops here, not alerts.

/** At most one question to Play per day. */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** A check Play could not answer (offline, no Play Store) does not cost the whole day. */
export const RETRY_AFTER_MS = 60 * 60_000;
/** After someone closes Play's update dialog, that versionCode is left alone for a week -- unless it becomes mandatory. */
export const DISMISS_BACKOFF_MS = 7 * 24 * 60 * 60_000;
/** The Play Console update priority from which Google itself expects a blocking update. */
export const IMMEDIATE_PRIORITY = 4;

/** What Play says about this package right now (modules/in-app-updates). */
export type UpdateStatus = {
  available: boolean;
  inProgress: boolean;
  versionCode: number;
  flexibleAllowed: boolean;
  immediateAllowed: boolean;
  priority: number;
  stalenessDays: number | null;
  downloaded: boolean;
  inFlight: boolean;
};

/** What this phone remembers between app starts (the secure store, like lib/review-policy.ts). One per install, not per account. */
export type UpdateState = {
  checkedAt: number | null;    // the last time Play answered
  triedAt: number | null;      // the last time Play was asked, answer or not
  dismissedCode: number | null;
  dismissedAt: number | null;
  pendingCode: number | null;  // a flexible update finished downloading and is waiting for a restart
  /** Whether the last flow this app started was the blocking one. null: this install has started none, or forgot. */
  startedImmediate: boolean | null;
};
export const EMPTY: UpdateState = { checkedAt: null, triedAt: null, dismissedCode: null, dismissedAt: null, pendingCode: null, startedImmediate: null };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const code = (v: unknown) => {
  const n = num(v);
  return n === null || n <= 0 ? null : Math.floor(n);
};

/** What was saved, or the empty state for anything missing or damaged (which can only ask later, never sooner). */
export function parseState(raw: string | null | undefined): UpdateState {
  try {
    const j = JSON.parse(raw ?? 'null');
    if (!j || typeof j !== 'object' || Array.isArray(j)) return EMPTY;
    return {
      checkedAt: num(j.checkedAt), triedAt: num(j.triedAt),
      dismissedCode: code(j.dismissedCode), dismissedAt: num(j.dismissedAt),
      pendingCode: code(j.pendingCode),
      startedImmediate: typeof j.startedImmediate === 'boolean' ? j.startedImmediate : null,
    };
  } catch { return EMPTY; }
}

export type Context = {
  now: number;
  /** 'android' | 'ios' | 'web'. Only Android has Play In-App Updates. */
  platform: string;
  /** Whether the native module is linked into this build at all. */
  supported: boolean;
  /** This build's android.versionCode. */
  currentCode: number;
  /** ANDROID_MIN_VERSION_CODE from GET /app/min-version. null (unset, or the call failed) means never force. */
  minCode: number | null;
};

/** An elapsed time that survives a clock set backwards: a moved clock means "long ago", never "just now". */
const since = (then: number | null, now: number) => (then === null || now < then ? Infinity : now - then);

/**
 * May the app ask Play at all right now? Keeps the daily limit, and does not burn the day on a question Play never answered.
 */
export function shouldCheck(s: UpdateState, c: Context): boolean {
  if (!c.supported || c.platform !== 'android') return false;
  return since(s.checkedAt, c.now) >= CHECK_EVERY_MS && since(s.triedAt, c.now) >= RETRY_AFTER_MS;
}

export type Why = 'unsupported' | 'none' | 'dismissed' | 'not_allowed';
export type Plan =
  | { do: 'nothing'; why: Why }
  /** A downloaded flexible update: show the "Update ready - Restart" banner. */
  | { do: 'install'; versionCode: number }
  | { do: 'start'; immediate: boolean; versionCode: number; forced: boolean };

/**
 * A flexible update that already downloaded, remembered from an earlier run. Checked before anything else and without
 * asking Play again, so the banner survives a restart even inside the 24 hours.
 */
export function pendingInstall(s: UpdateState, c: Context): number | null {
  if (!c.supported || c.platform !== 'android') return null;
  if (s.pendingCode === null) return null;
  // The update happened (by this banner, by Play on its own, or by the person in the Play Store): forget it.
  return s.pendingCode > c.currentCode ? s.pendingCode : null;
}

/**
 * Whether this version must be installed before the app may be used: the API's floor, or Play's own high priority.
 * The floor only forces an update that actually clears it -- blocking someone to install a version still below the
 * minimum would lock them out for nothing.
 */
export function mustUpdate(status: UpdateStatus, c: Context): boolean {
  if (c.minCode !== null && c.currentCode < c.minCode && status.versionCode >= c.minCode) return true;
  return status.priority >= IMMEDIATE_PRIORITY;
}

/** What to do with what Play just said. */
export function plan(s: UpdateState, status: UpdateStatus, c: Context): Plan {
  if (!c.supported || c.platform !== 'android') return { do: 'nothing', why: 'unsupported' };
  // Already downloaded: never start a second flow, just offer the restart.
  if (status.downloaded) return { do: 'install', versionCode: status.versionCode };
  // Play is already fetching or installing something. This has to be read before `inProgress`: Play reports a flexible
  // update it is still downloading as a developer-triggered update in progress too, and resuming that as the blocking
  // flow would put a full-screen Play dialog over an update that was deliberately quiet.
  if (status.inFlight) return { do: 'nothing', why: 'none' };
  // A blocking update the person started and then killed the app during: Google asks for it to be resumed. Only when
  // this install's last flow was the blocking one (or it no longer remembers, e.g. a wiped keystore).
  if (status.inProgress) {
    if (s.startedImmediate === false) return { do: 'nothing', why: 'none' };
    return status.immediateAllowed
      ? { do: 'start', immediate: true, versionCode: status.versionCode, forced: true }
      : { do: 'nothing', why: 'not_allowed' };
  }
  if (!status.available) return { do: 'nothing', why: 'none' };

  const forced = mustUpdate(status, c);
  if (forced) {
    // A blocking flow Play will not allow is no reason to lock someone out, so fall back to the flexible one.
    if (status.immediateAllowed) return { do: 'start', immediate: true, versionCode: status.versionCode, forced: true };
    if (status.flexibleAllowed) return { do: 'start', immediate: false, versionCode: status.versionCode, forced: true };
    return { do: 'nothing', why: 'not_allowed' };
  }
  // Someone who closed Play's dialog for this version is not asked again for a week.
  if (s.dismissedCode === status.versionCode && since(s.dismissedAt, c.now) < DISMISS_BACKOFF_MS) return { do: 'nothing', why: 'dismissed' };
  if (!status.flexibleAllowed) return { do: 'nothing', why: 'not_allowed' };
  return { do: 'start', immediate: false, versionCode: status.versionCode, forced: false };
}

/** ANDROID_MIN_VERSION_CODE as the app should read it: anything but a positive whole number means "no floor". */
export function parseMinCode(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

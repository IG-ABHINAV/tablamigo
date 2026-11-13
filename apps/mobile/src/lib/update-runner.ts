// The in-app update run, wired to one moment: the app coming to the foreground (app/_layout.tsx -> lib/update-prompt.ts).
// Platform-free, everything it touches is passed in, so tests/unit/update-policy.test.mjs drives it with fakes.
//
// One pass: remember a flexible update that already downloaded (banner, no question to Play), else -- at most once a day --
// ask Play what it has, ask the API whether this version is still allowed to run, and do what update-policy.ts says.
// Nothing here ever throws at the caller, and nothing in the app waits on it: Play offline, Play missing (a sideloaded
// build), or the API down all end the same way, with no prompt.
import { CHECK_EVERY_MS, RETRY_AFTER_MS, parseState, pendingInstall, plan, shouldCheck, type Context, type UpdateState, type UpdateStatus } from './update-policy';

export type Deps = {
  /** 'android' | 'ios' | 'web'. */
  platform: string;
  /** Whether the native module is in this build. */
  supported: () => boolean;
  /** This build's android.versionCode. */
  currentCode: () => number;
  load: () => Promise<string | null>;
  save: (raw: string) => Promise<void>;
  /** GET /app/min-version. Null when it fails or is unset: a server we cannot reach never forces anything. */
  minCode: () => Promise<number | null>;
  check: () => Promise<UpdateStatus>;
  start: (immediate: boolean) => Promise<boolean>;
  install: () => Promise<boolean>;
  /** The "Update ready - Restart" banner. */
  showBanner: (versionCode: number) => void;
  hideBanner: () => void;
  /** The first-party analytics (lib/api.ts `n`). */
  track: (event: string, properties?: Record<string, unknown>) => void;
  now: () => number;
  log: (line: string) => void;
  /** Tests shorten it; the app uses CALL_TIMEOUT_MS. */
  timeoutMs?: number;
};

/** Play and the API both go through this: fetch has no timeout on Android, and a half-open socket must not hang the run. */
export const CALL_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, no) => { t = setTimeout(() => no(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

export function createUpdateRunner(d: Deps) {
  let cache: UpdateState | null = null;
  let running: Promise<string> | null = null;
  /** The version the person was last offered, so Play's "cancelled" can be tied to it. */
  let offered: number | null = null;
  /** The downloaded version whose banner the person closed: not shown again until the next app start (a new process). */
  let closedThisSession: number | null = null;

  const read = async (): Promise<UpdateState> => cache ?? parseState(await d.load().catch(() => null));
  const write = async (s: UpdateState) => { cache = s; await d.save(JSON.stringify(s)).catch(() => {}); };
  const ms = () => d.timeoutMs ?? CALL_TIMEOUT_MS;

  async function pass(): Promise<string> {
    const base = { now: d.now(), platform: d.platform, supported: d.supported(), currentCode: d.currentCode() };
    if (!base.supported || base.platform !== 'android') return 'unsupported';

    const state = await read();
    // A download that finished in an earlier run: offer the restart without spending the day's question.
    const waiting = pendingInstall(state, { ...base, minCode: null });
    if (waiting !== null) {
      offered = waiting;
      // Closed with "Not now" in this session: every return to the foreground runs a pass, and must not bring it back.
      if (waiting === closedThisSession) return 'banner_closed';
      d.showBanner(waiting); return 'pending_install';
    }
    if (state.pendingCode !== null) await write({ ...state, pendingCode: null });

    if (!shouldCheck(state, { ...base, minCode: null })) return 'throttled';
    // Written before the call: a Play check that never answers costs an hour, not a day (update-policy RETRY_AFTER_MS).
    await write({ ...(await read()), triedAt: base.now });

    let status: UpdateStatus;
    try { status = await withTimeout(d.check(), ms()); }
    catch (e) { d.log(`[update] Play could not be asked: ${(e as Error)?.message ?? e}`); return 'check_failed'; }
    await write({ ...(await read()), checkedAt: d.now() });

    // Only the floor comes from the API, and only to make an update mandatory. If it cannot be read, nothing is forced.
    let minCode: number | null = null;
    if (status.available || status.inProgress) {
      try { minCode = await withTimeout(d.minCode(), ms()); }
      catch { minCode = null; }
    }

    const ctx: Context = { ...base, minCode };
    const what = plan(await read(), status, ctx);
    if (what.do === 'nothing') return what.why;
    if (what.do === 'install') { await noteDownloaded(what.versionCode); return 'pending_install'; }

    d.track('update_available', {
      versionCode: what.versionCode, currentCode: base.currentCode, immediate: what.immediate,
      forced: what.forced, priority: status.priority, stalenessDays: status.stalenessDays,
    });
    offered = what.versionCode;
    let started = false;
    try { started = await withTimeout(d.start(what.immediate), ms()); }
    catch (e) {
      d.track('update_failed', { versionCode: what.versionCode, stage: 'start', message: String((e as Error)?.message ?? e) });
      d.log(`[update] Play refused to start: ${(e as Error)?.message ?? e}`);
      return 'start_failed';
    }
    if (!started) { d.log('[update] Play had nothing to start'); return 'not_started'; }
    // Remembered so a flow Play later reports as "in progress" is resumed as the kind it actually was.
    await write({ ...(await read()), startedImmediate: what.immediate });
    d.track('update_started', { versionCode: what.versionCode, immediate: what.immediate, forced: what.forced });
    return what.immediate ? 'immediate' : 'flexible';
  }

  async function noteDownloaded(versionCode: number) {
    const s = await read();
    if (s.pendingCode !== versionCode) await write({ ...s, pendingCode: versionCode });
    d.showBanner(versionCode);
  }

  return {
    /** One pass, on app start and whenever the app comes back to the foreground. Never throws; resolves to what happened. */
    run(): Promise<string> {
      if (running) return running;
      const p = pass().catch(e => { d.log(`[update] ${(e as Error)?.message ?? e}`); return 'error'; }).finally(() => { running = null; });
      running = p;
      return p;
    },

    /** Play finished downloading a flexible update (this run, or one that carried on after the app was closed). */
    async downloaded() {
      let versionCode = offered ?? (await read()).pendingCode;
      if (versionCode === null) {
        // A download that carried on past an app restart: this process never offered it, so ask Play which version it is.
        // If Play will not say, the banner is still right -- something newer is ready -- so stand in for the number.
        versionCode = await withTimeout(d.check(), ms()).then(s => s.versionCode).catch(() => d.currentCode() + 1);
      }
      offered = versionCode;
      d.track('update_downloaded', { versionCode });
      await noteDownloaded(versionCode);
    },

    /** Play installed the update. The app is about to be restarted by Play, so this is the last thing it may do. */
    async installed() {
      d.track('update_installed', { versionCode: offered ?? (await read()).pendingCode ?? null });
      d.hideBanner();
      await write({ ...(await read()), pendingCode: null });
    },

    async failed(where: string, code?: unknown) {
      d.track('update_failed', { versionCode: offered, stage: where, code: code ?? null });
      d.hideBanner();
      await write({ ...(await read()), pendingCode: null });
    },

    /** The person closed Play's dialog, or stopped the download. That version is left alone for a week. */
    async cancelled(where: string) {
      const s = await read();
      d.track('update_failed', { versionCode: offered, stage: `cancelled_${where}` });
      d.hideBanner();
      await write({ ...s, dismissedCode: offered ?? s.dismissedCode, dismissedAt: d.now(), pendingCode: null });
    },

    /** The banner's button: Play installs the downloaded update and restarts the app. */
    async install(): Promise<boolean> {
      let ok = false;
      try { ok = await withTimeout(d.install(), ms()); }
      catch (e) {
        d.track('update_failed', { versionCode: offered, stage: 'install', message: String((e as Error)?.message ?? e) });
        ok = false;
      }
      // Play had nothing to install after all (it was installed elsewhere, or the download was cleared): drop the banner.
      if (!ok) { d.hideBanner(); await write({ ...(await read()), pendingCode: null }); }
      return ok;
    },

    /** The person closed the banner. It comes back on the next app start (not on the next resume), since the update is still downloaded. */
    dismissBanner() { closedThisSession = offered; d.hideBanner(); },
  };
}

export { CHECK_EVERY_MS, RETRY_AFTER_MS };

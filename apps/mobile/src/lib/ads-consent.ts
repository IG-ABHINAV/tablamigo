// The consent gate in front of Google AdMob, as plain TypeScript with no React Native imports, so tests/unit/ads-consent.test.mjs can
// drive it with a fake consent SDK. lib/ads.ts wires it to the real Google Mobile Ads module and to the useAds store.
//
// Google's order (developers.google.com/admob/android/privacy): refresh the user's consent information on every launch, show the
// consent form if their region needs one (the EEA, the UK and Switzerland, as set by the consent message published in AdMob, Privacy &
// messaging), and start the SDK and load ads only once `canRequestAds` is true. Nothing here ever starts the SDK before that.

/** The part of react-native-google-mobile-ads this gate uses. The real module satisfies it. */
export type AdsSdk = {
  AdsConsent: {
    gatherConsent(): Promise<unknown>;
    getConsentInfo(): Promise<{ canRequestAds: boolean; privacyOptionsRequirementStatus: string }>;
    showPrivacyOptionsForm(): Promise<unknown>;
  };
  AdsConsentPrivacyOptionsRequirementStatus: { REQUIRED: string };
  default(): { initialize(): Promise<unknown> };
};

/**
 * `ready`: consent is settled and the SDK has started, so the banner may load. `privacyOptions`: Google's consent message for this
 * user's region requires a way to change the choice at any time, so Profile shows "Ad privacy choices".
 */
export type AdsState = { ready: boolean; privacyOptions: boolean };

export function createAdsGate(sdk: AdsSdk | null, set: (s: Partial<AdsState>) => void, get: () => AdsState) {
  let starting: Promise<void> | null = null;
  let started = false;

  async function apply(g: AdsSdk) {
    const info = await g.AdsConsent.getConsentInfo();
    set({ privacyOptions: info.privacyOptionsRequirementStatus === g.AdsConsentPrivacyOptionsRequirementStatus.REQUIRED });
    if (!info.canRequestAds) return set({ ready: false });
    if (!started) { await g.default().initialize(); started = true; }
    set({ ready: true });
  }

  /**
   * Called once a signed-in, onboarded free account is known (Plus members never get the form), and again when the app comes back
   * to the foreground: once ads are ready it does nothing; until then (offline, no answer yet, an error) it tries again. Calls that
   * overlap share one attempt, so the form never opens twice.
   */
  function start(): Promise<void> {
    if (!sdk) return Promise.resolve();
    const g = sdk;
    starting ??= (async () => {
      // Offline or a consent-SDK error: canRequestAds then holds the previous session's answer, which Google says to go by.
      await g.AdsConsent.gatherConsent().catch(() => undefined);
      await apply(g);
    })().catch(() => undefined).finally(() => { if (!get().ready) starting = null; });
    return starting;
  }

  /** Profile's "Ad privacy choices": Google's privacy options form, then the same check as at launch. */
  async function openPrivacyOptions(): Promise<void> {
    if (!sdk) return;
    await sdk.AdsConsent.showPrivacyOptionsForm();
    await apply(sdk);
  }

  return { start, openPrivacyOptions };
}

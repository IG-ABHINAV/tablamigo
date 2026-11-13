// The JavaScript face of the local Android module in ./android (Google Play In-App Updates). Nothing here decides anything:
// src/lib/update-policy.ts does that and src/lib/update-prompt.ts wires it to the app.
//
// requireOptionalNativeModule returns null wherever the module is not linked (the web app, a dev client built before this
// module existed, iOS), so every call below is a safe no-op there instead of a crash.
import { requireOptionalNativeModule } from 'expo-modules-core';

export type UpdateStatus = {
  /** Play has a newer versionCode for this package. */
  available: boolean;
  /** An immediate update was started and interrupted; Play wants it resumed. */
  inProgress: boolean;
  /** The versionCode Play would install. Only meaningful when `available`. */
  versionCode: number;
  flexibleAllowed: boolean;
  immediateAllowed: boolean;
  /** The update priority set in the Play Console for that release, 0-5. */
  priority: number;
  /** Days since the Play Store app on this phone learnt about the update, or null when Play does not say. */
  stalenessDays: number | null;
  /** A flexible update has already finished downloading and is waiting to be installed. */
  downloaded: boolean;
  /** Play is fetching or installing an update right now. */
  inFlight: boolean;
};

export type UpdateEvent = 'downloaded' | 'installed' | 'failed' | 'cancelled';

type Native = {
  check(): Promise<UpdateStatus>;
  start(immediate: boolean): Promise<boolean>;
  install(): Promise<boolean>;
  addListener(event: UpdateEvent, listener: (payload: Record<string, unknown>) => void): { remove: () => void };
};

const native = requireOptionalNativeModule<Native>('TablamigoInAppUpdates');

/** Whether Play In-App Updates exists in this build at all (Android release and dev builds that include the module). */
export const inAppUpdatesAvailable = () => native !== null;

/** Asks Play what it has. Rejects when Play cannot answer (offline, no Play Store on the device, a sideloaded build). */
export async function check(): Promise<UpdateStatus> {
  if (!native) throw new Error('in-app updates are not available here');
  return native.check();
}

/** Starts Play's own flow. False means Play refused this type of update or there is nothing to update. */
export async function start(immediate: boolean): Promise<boolean> {
  if (!native) return false;
  return native.start(immediate);
}

/** Installs a downloaded flexible update: Play restarts the app. Only from a button the person pressed. */
export async function install(): Promise<boolean> {
  if (!native) return false;
  return native.install();
}

export function addUpdateListener(event: UpdateEvent, listener: (payload: Record<string, unknown>) => void): () => void {
  if (!native) return () => {};
  const sub = native.addListener(event, listener);
  return () => sub.remove();
}

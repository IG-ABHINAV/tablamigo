/**
 * Child process that runs the face checks for the API (started by lib/verification.ts with fork + IPC).
 * One message at a time: { id, profile, selfie, pose } in, { id, out } or { id, error } back.
 * Exits when the API disconnects or stops it after a few idle minutes, which returns the model memory to the OS.
 */
import { checkSelfie, type Pose } from './face-check.js';

type Job = { id: number; profile: Uint8Array; selfie: Uint8Array; pose: Pose };

process.on('message', async (m: Job) => {
  try {
    const out = await checkSelfie(Buffer.from(m.profile), Buffer.from(m.selfie), m.pose);
    process.send!({ id: m.id, out });
  } catch (e) {
    process.send!({ id: m.id, error: (e as Error).message });
  }
});
process.on('disconnect', () => process.exit(0));

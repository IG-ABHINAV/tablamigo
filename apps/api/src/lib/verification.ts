/**
 * Automatic selfie verification: nobody reviews selfies by hand. POST /verify stores a 'pending' request and
 * queues it here; the check runs a moment later on our own CPU and approves or rejects it with a reason the
 * app and the email can show. Admins can see the outcomes and override one, but never have to.
 *
 * The face work (lib/face-check.ts, lib/face.ts) runs in a child process started on the first check and stopped
 * after WORKER_IDLE_MS without work: the models (~150-250 MB while loaded) never count against the API's
 * PM2 memory limit, and the box (shared with Hookpost) gets the memory back when the worker exits.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql } from './db.js';
import { readImage } from './storage.js';
import { addNotice } from './inbox.js';
import { emailVerification } from './emails/events.js';
import { modelsPresent } from './face.js';
import { POSES, LEGACY_POSES, THRESHOLDS, type Pose, type Reason, type Scores, type Outcome } from './face-check.js';

export { POSES, LEGACY_POSES, THRESHOLDS, type Pose, type Reason, type Scores, type Outcome };

/** Short sentence for the app, the inbox notice and the email. */
export const REASON_TEXT: Record<Reason, string> = {
  no_face: "We couldn't find a clear face in your selfie. Use good light and hold the phone at arm's length.",
  several_faces: 'We found more than one face in your selfie. Take it on your own.',
  profile_photo: "We couldn't find exactly one clear face in your profile photo. Change your profile photo to a clear one of you, then try again.",
  same_photo: 'That looks like your profile photo again. Take a new selfie with the camera.',
  no_match: "Your selfie didn't match your profile photo closely enough. Try better light, no sunglasses or mask, or use a clearer profile photo.",
  wrong_pose: "Your head wasn't in the pose we asked for. Turn your head about a third of the way (both eyes still showing) or tilt your chin up, as the screen says.",
  check_failed: "We couldn't check your photo just now. Try again in a minute; this try doesn't count.",
};

const WORKER_IDLE_MS = 2 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
type Waiter = { resolve: (o: Outcome) => void; reject: (e: Error) => void };
let child: ChildProcess | null = null;
let idle: NodeJS.Timeout | undefined;
let seq = 0;
const waiting = new Map<number, Waiter>();

function worker(): ChildProcess {
  if (child?.connected) return child;
  // Under tsx/vitest this file is .ts and so is the worker; the built API runs dist/lib/face-worker.js.
  const ts = import.meta.url.endsWith('.ts');
  const file = fileURLToPath(new URL(`./face-worker.${ts ? 'ts' : 'js'}`, import.meta.url));
  const c = fork(file, [], { serialization: 'advanced', execArgv: ts ? ['--import', 'tsx'] : [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, ORT_DISABLE_TELEMETRY: '1' } });
  c.on('message', (m: { id: number; out?: Outcome; error?: string }) => {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.out) w.resolve(m.out); else w.reject(new Error(m.error ?? 'face worker error'));
  });
  c.on('exit', code => {
    if (child === c) child = null;
    for (const w of waiting.values()) w.reject(new Error(`face worker exited (${code})`));
    waiting.clear();
  });
  // Never keeps the API (or a test run) alive on its own.
  c.unref(); c.channel?.unref();
  child = c;
  return c;
}

/** Stops the face worker now (it restarts on the next check). */
export function stopFaceWorker() {
  clearTimeout(idle); idle = undefined;
  child?.kill(); child = null;
}

/** Checks one selfie against one profile photo in the face worker. */
export function checkSelfie(profile: Buffer, selfie: Buffer, pose: Pose): Promise<Outcome> {
  clearTimeout(idle);
  const c = worker();
  const id = ++seq;
  return new Promise<Outcome>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); c.kill(); reject(new Error('face check timed out')); }, CHECK_TIMEOUT_MS);
    waiting.set(id, { resolve: o => { clearTimeout(timer); resolve(o); }, reject: e => { clearTimeout(timer); reject(e); } });
    c.send({ id, profile, selfie, pose });
  }).finally(() => {
    clearTimeout(idle);
    idle = setTimeout(stopFaceWorker, WORKER_IDLE_MS);
    idle.unref();
  });
}

/** Attempts per user in a rolling 24 hours. Failed checks on our side (check_failed) don't count. */
export const DAILY_TRIES = 5;
export const triesUsed = async (userId: string) =>
  (await sql`select count(*)::int as n from verification_requests
    where user_id = ${userId} and created_at > now() - interval '1 day' and coalesce(reason, '') <> 'check_failed'`)[0].n as number;

/** Runs the check for one pending request and records the outcome. Safe to call twice: only a pending row is decided. */
export async function runVerification(requestId: string): Promise<Outcome | null> {
  const [r] = await sql`select r.id, r.user_id, r.photo_key, r.pose, u.photo_url from verification_requests r join users u on u.id = r.user_id
    where r.id = ${requestId} and r.status = 'pending' and u.deleted_at is null`;
  if (!r) return null;
  let outcome: Outcome;
  try {
    if (!modelsPresent()) throw new Error('face models missing: run npm run models');
    const [profile, selfie] = await Promise.all([r.photoUrl ? readImage(r.photoUrl) : null, readImage(r.photoKey)]);
    if (!profile) outcome = { pass: false, reason: 'profile_photo', scores: emptyScores() };
    else if (!selfie) outcome = { pass: false, reason: 'no_face', scores: emptyScores() };
    else outcome = await checkSelfie(profile, selfie, r.pose);
  } catch (e) {
    console.error('verification check failed', requestId, (e as Error).message);
    outcome = { pass: false, reason: 'check_failed', scores: emptyScores() };
  }
  const status = outcome.pass ? 'approved' : 'rejected';
  const decided = await sql.begin(async tx => {
    const [row] = await tx`update verification_requests set status = ${status}, reason = ${outcome.reason}, scores = ${sql.json(outcome.scores)},
      checked_at = now() where id = ${requestId} and status = 'pending' returning user_id`;
    if (row && outcome.pass) await tx`update users set verified = true where id = ${row.userId}`;
    return !!row;
  });
  if (!decided) return null;
  await notify(r.userId, requestId, outcome.pass, outcome.reason);
  return outcome;
}

export async function notify(userId: string, requestId: string, approved: boolean, reason: Reason | null) {
  await addNotice([userId], approved ? { kind: 'verified', body: "You're verified ✅" }
    : { kind: 'verify_rejected', body: `Your verification photo didn't pass. ${reason ? REASON_TEXT[reason] : 'You can try again.'}` });
  // A check that failed on our side is not the user's fault: the notice is enough, no email.
  if (reason !== 'check_failed') void emailVerification(userId, requestId, approved, reason);
}

const emptyScores = (): Scores => ({ similarity: null, selfieFaces: 0, profileFaces: 0, hashDistance: null, yaw: null, pitch: null, roll: null, poseChecked: false, ms: 0 });

// In-process queue: one check at a time (face.ts serialises the model work too), started right after upload.
const queued = new Set<string>();
let tail: Promise<unknown> = Promise.resolve();
export function enqueue(requestId: string): Promise<unknown> {
  if (queued.has(requestId)) return tail;
  queued.add(requestId);
  tail = tail.then(() => runVerification(requestId)).catch(e => console.error('verification failed', requestId, (e as Error).message))
    .finally(() => queued.delete(requestId));
  return tail;
}

/** Picks up requests left pending by a restart. Called once at startup. */
export async function resumePending() {
  const rows = await sql`select id from verification_requests where status = 'pending' order by created_at limit 500`;
  for (const r of rows) void enqueue(r.id);
  return rows.length;
}

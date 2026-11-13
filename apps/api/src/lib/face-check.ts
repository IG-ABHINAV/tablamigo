/**
 * The face checks themselves: pure, no database. Runs inside the face worker process (face-worker.ts), so the
 * models' memory never lands in the API process and is handed back to the OS when the worker exits.
 *
 * Checks, in order (the first failure is the reason):
 *   1. exactly one face in the selfie                         no_face / several_faces
 *   2. exactly one face in the profile photo                  profile_photo
 *   3. the selfie is not the profile photo again              same_photo   (embedding or crop hash nearly identical)
 *   4. the requested head pose                                wrong_pose   (cheap liveness: an old photo rarely has it)
 *   5. same person as the profile photo                       no_match     (cosine similarity >= match)
 */
import { analyse, cosine, hamming, type Analysis } from './face.js';

/** Head poses the app asks for. Each is side-agnostic, because some Android cameras save selfies mirrored. */
export const POSES = ['turn_head', 'look_up'] as const;
/** Hand poses from before automatic checks. Old app builds still send them; the pose is then not checked. */
export const LEGACY_POSES = ['two_fingers', 'touch_ear', 'thumbs_up'] as const;
export type Pose = typeof POSES[number] | typeof LEGACY_POSES[number];

export type Reason = 'no_face' | 'several_faces' | 'profile_photo' | 'same_photo' | 'no_match' | 'wrong_pose' | 'check_failed';
/**
 * Calibrated on public-domain photos (src/scripts/face-calibrate.ts); numbers in the commit message.
 * Chosen to prefer a false reject (the user retries) over a false accept (a stranger gets the tick).
 */
export const THRESHOLDS = {
  /** SFace cosine similarity for "same person". OpenCV's LFW figure is 0.363; we sit higher. */
  match: 0.45,
  /** At or above this the selfie is the profile photo again (re-saved, resized, screenshotted). */
  nearCopy: 0.93,
  /** Or: aligned-face difference hashes this close (of 64 bits). */
  copyHash: 6,
  /** turn_head: nose offset from the eye midpoint >= this share of the eye distance (~25 degrees)... */
  turn: 0.18,
  /** ...and at most this (~55 degrees): further round, the landmarks and the match stop being reliable. */
  turnMax: 0.6,
  /** look_up: nose at most this far down between eye line and mouth (facing the camera: median 0.58, 5th percentile 0.51). */
  lookUp: 0.47,
  /** A face narrower than this (px, image scaled to fit 640) is too far away or too blurry to judge. */
  minFace: 60,
  /** A second face counts when it is at least this share of the main face's width (ignores far-off passers-by). */
  otherFace: 0.35,
} as const;

export type Scores = {
  similarity: number | null;
  selfieFaces: number;
  profileFaces: number;
  hashDistance: number | null;
  yaw: number | null; pitch: number | null; roll: number | null;
  poseChecked: boolean;
  ms: number;
};
export type Outcome = { pass: boolean; reason: Reason | null; scores: Scores };

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const faceCount = (a: Analysis) => {
  const main = a.faces[0];
  if (!main) return 0;
  return a.faces.filter(f => f.box[2] >= Math.max(40, THRESHOLDS.otherFace * main.box[2])).length;
};

/** Checks one selfie against one profile photo, in this process. The API runs it in face-worker.ts. */
export async function checkSelfie(profile: Buffer, selfie: Buffer, pose: Pose): Promise<Outcome> {
  const t0 = Date.now();
  const s = await analyse(selfie);
  const p = await analyse(profile);
  const sm = s.main, pm = p.main;
  const scores: Scores = {
    similarity: sm && pm ? r3(cosine(sm.embedding, pm.embedding)) : null,
    selfieFaces: faceCount(s), profileFaces: faceCount(p),
    hashDistance: sm && pm ? hamming(sm.hash, pm.hash) : null,
    yaw: sm ? r3(sm.pose.yaw) : null, pitch: sm ? r3(sm.pose.pitch) : null, roll: sm ? Math.round(sm.pose.roll) : null,
    poseChecked: (POSES as readonly string[]).includes(pose),
    ms: 0,
  };
  const done = (reason: Reason | null): Outcome => ({ pass: !reason, reason, scores: { ...scores, ms: Date.now() - t0 } });

  if (!sm || sm.face.box[2] < THRESHOLDS.minFace) return done('no_face');
  if (scores.selfieFaces > 1) return done('several_faces');
  if (!pm || pm.face.box[2] < THRESHOLDS.minFace || scores.profileFaces !== 1) return done('profile_photo');
  if (scores.similarity! >= THRESHOLDS.nearCopy || scores.hashDistance! <= THRESHOLDS.copyHash) return done('same_photo');
  // Pose before match: a head turned too far lowers the similarity, and "wrong pose" is the useful thing to say then.
  const yaw = Math.abs(sm.pose.yaw);
  if (pose === 'turn_head' && (yaw < THRESHOLDS.turn || yaw > THRESHOLDS.turnMax)) return done('wrong_pose');
  if (pose === 'look_up' && sm.pose.pitch > THRESHOLDS.lookUp) return done('wrong_pose');
  if (scores.similarity! < THRESHOLDS.match) return done('no_match');
  return done(null);
}


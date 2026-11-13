/**
 * Face detection + face embeddings on our own CPU, for automatic selfie verification.
 *
 *   detector:   YuNet 2023mar (OpenCV Zoo, MIT)        ~230 KB, faces + 5 landmarks
 *   recognizer: SFace 2021dec (OpenCV Zoo, Apache-2.0)  ~39 MB, 128-d embedding of a 112x112 aligned face
 *
 * Both run through onnxruntime-node; sharp decodes the image (EXIF rotation included). The model files are
 * fetched at build time by scripts/fetch-face-models.mjs into apps/api/models and shipped by infra/deploy.sh.
 *
 * The box also runs Hookpost, so memory is kept low: nothing loads until the first check, jobs run one at a
 * time on one thread, and the sessions are released after IDLE_MS without work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Ort from 'onnxruntime-node';
import type SharpNs from 'sharp';

export const MODELS_DIR = process.env.FACE_MODELS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../models');
export const MODEL_FILES = { detector: 'face_detection_yunet_2023mar.onnx', recognizer: 'face_recognition_sface_2021dec.onnx' } as const;
export const modelsPresent = () => Object.values(MODEL_FILES).every(f => fs.existsSync(path.join(MODELS_DIR, f)));

const IDLE_MS = 5 * 60_000;
const DET_SIZE = 640;            // YuNet 2023mar has a fixed 640x640 input
const DET_SCORE = 0.8;           // YuNet's own demo uses 0.9; 0.8 also catches a second, less clear face
const NMS_IOU = 0.3;

type Point = [number, number];
export type Face = {
  box: [number, number, number, number]; // x, y, w, h in the decoded image
  score: number;
  /** subject's right eye, left eye, nose tip, right mouth corner, left mouth corner */
  landmarks: [Point, Point, Point, Point, Point];
};
export type HeadPose = {
  /** degrees of head tilt towards a shoulder (eye line vs horizontal) */
  roll: number;
  /** nose offset from the eye midpoint, as a share of the eye distance; 0 = facing the camera, sign = side */
  yaw: number;
  /** where the nose sits between the eye line (0) and the mouth line (1); ~0.5 facing the camera, lower = chin up */
  pitch: number;
};
export type Analysis = {
  width: number; height: number;
  faces: Face[];
  /** the largest face: its embedding (unit length), pose and a 64-bit difference hash of the aligned crop */
  main?: { face: Face; embedding: Float32Array; pose: HeadPose; hash: bigint };
};

type Engine = { ort: typeof Ort; det: Ort.InferenceSession; rec: Ort.InferenceSession; sharp: typeof SharpNs };
let engine: Promise<Engine> | null = null;
let idle: NodeJS.Timeout | undefined;

async function load(): Promise<Engine> {
  // onnxruntime 1.30 tries to upload usage telemetry on Linux unless this is set; nothing leaves the box.
  process.env.ORT_DISABLE_TELEMETRY ??= '1';
  const ort = (await import('onnxruntime-node')) as typeof Ort;
  const sharp = (await import('sharp')).default;
  sharp.cache(false); sharp.concurrency(1);
  const opts: Ort.InferenceSession.SessionOptions = {
    logSeverityLevel: 3, intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
    graphOptimizationLevel: 'all', enableCpuMemArena: false,
  };
  const det = await ort.InferenceSession.create(path.join(MODELS_DIR, MODEL_FILES.detector), opts);
  const rec = await ort.InferenceSession.create(path.join(MODELS_DIR, MODEL_FILES.recognizer), opts);
  return { ort, det, rec, sharp };
}

/** Frees the model sessions (the next check loads them again). */
export async function releaseModels() {
  clearTimeout(idle); idle = undefined;
  const e = engine; engine = null;
  if (!e) return;
  const loaded = await e.catch(() => null);
  if (loaded) { await loaded.det.release(); await loaded.rec.release(); }
}

// One job at a time: a second upload waits for the first instead of doubling memory and CPU.
let chain: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function withEngine<T>(fn: (e: Engine) => Promise<T>): Promise<T> {
  clearTimeout(idle);
  engine ??= load();
  try {
    return await fn(await engine.catch(err => { engine = null; throw err; }));
  } finally {
    idle = setTimeout(() => void releaseModels(), IDLE_MS);
    idle.unref();
  }
}

/** Detects faces in an image and embeds the largest one. Runs exclusively (see `exclusive`). */
export function analyse(image: Buffer): Promise<Analysis> {
  return exclusive(() => withEngine(async e => {
    const { data, info } = await e.sharp(image, { failOn: 'error', limitInputPixels: 60_000_000 })
      .rotate().resize(DET_SIZE, DET_SIZE, { fit: 'inside' }).removeAlpha().toColourspace('srgb').raw()
      .toBuffer({ resolveWithObject: true });
    const img = { data, width: info.width, height: info.height };
    const faces = await detect(e, img);
    const out: Analysis = { width: img.width, height: img.height, faces };
    const face = faces[0];
    if (face) {
      const crop = alignCrop(img, face.landmarks);
      out.main = { face, embedding: await embed(e, crop), pose: headPose(face.landmarks), hash: dhash(crop) };
    }
    return out;
  }));
}

type Rgb = { data: Buffer | Uint8Array; width: number; height: number };

async function detect(e: Engine, img: Rgb): Promise<Face[]> {
  // Top-left letterbox into 640x640, BGR, 0-255, CHW: what OpenCV's FaceDetectorYN feeds the model.
  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 3, d = y * DET_SIZE + x;
      input[d] = img.data[s + 2]; input[plane + d] = img.data[s + 1]; input[2 * plane + d] = img.data[s];
    }
  }
  const res = await e.det.run({ input: new e.ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]) });
  const found: Face[] = [];
  for (const stride of [8, 16, 32]) {
    const cls = res[`cls_${stride}`].data as Float32Array, obj = res[`obj_${stride}`].data as Float32Array;
    const bbox = res[`bbox_${stride}`].data as Float32Array, kps = res[`kps_${stride}`].data as Float32Array;
    const cols = DET_SIZE / stride, rows = DET_SIZE / stride;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
        if (score < DET_SCORE) continue;
        const cx = (c + bbox[i * 4]) * stride, cy = (r + bbox[i * 4 + 1]) * stride;
        const w = Math.exp(bbox[i * 4 + 2]) * stride, h = Math.exp(bbox[i * 4 + 3]) * stride;
        const lm = [0, 1, 2, 3, 4].map(n => [(kps[i * 10 + 2 * n] + c) * stride, (kps[i * 10 + 2 * n + 1] + r) * stride] as Point);
        found.push({ box: [cx - w / 2, cy - h / 2, w, h], score, landmarks: lm as Face['landmarks'] });
      }
    }
  }
  // Non-maximum suppression, then keep faces whose centre is inside the real image (not the padding).
  found.sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const f of found) if (kept.every(k => iou(k.box, f.box) < NMS_IOU)) kept.push(f);
  return kept
    .filter(f => f.box[0] + f.box[2] / 2 < img.width && f.box[1] + f.box[3] / 2 < img.height)
    .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
}

// ArcFace/SFace 112x112 template for the 5 landmarks.
const TEMPLATE: Point[] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
const CROP = 112;

/** Least-squares similarity transform (scale, rotation, shift) mapping the landmarks onto the template, then bilinear warp. */
function alignCrop(img: Rgb, lm: Face['landmarks']): Rgb {
  const n = lm.length;
  const [mx, my] = lm.reduce(([a, b], [x, y]) => [a + x / n, b + y / n], [0, 0]);
  const [tx, ty] = TEMPLATE.reduce(([a, b], [x, y]) => [a + x / n, b + y / n], [0, 0]);
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const sx = lm[i][0] - mx, sy = lm[i][1] - my, dx = TEMPLATE[i][0] - tx, dy = TEMPLATE[i][1] - ty;
    num1 += sx * dx + sy * dy; num2 += sx * dy - sy * dx; den += sx * sx + sy * sy;
  }
  const a = num1 / den, b = num2 / den; // dst = [a -b; b a] * (src - m) + t
  // Inverse: src = [a b; -b a] / (a^2 + b^2) * (dst - t) + m
  const k = a * a + b * b;
  const out = new Uint8Array(CROP * CROP * 3);
  for (let y = 0; y < CROP; y++) {
    for (let x = 0; x < CROP; x++) {
      const dx = x - tx, dy = y - ty;
      const sx = (a * dx + b * dy) / k + mx, sy = (-b * dx + a * dy) / k + my;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const p = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) ? 0 : img.data[(yy * img.width + xx) * 3 + ch];
        const v = p(x0, y0) * (1 - fx) * (1 - fy) + p(x0 + 1, y0) * fx * (1 - fy) + p(x0, y0 + 1) * (1 - fx) * fy + p(x0 + 1, y0 + 1) * fx * fy;
        out[(y * CROP + x) * 3 + ch] = Math.round(v);
      }
    }
  }
  return { data: out, width: CROP, height: CROP };
}

async function embed(e: Engine, crop: Rgb): Promise<Float32Array> {
  // RGB, 0-255, CHW: OpenCV's FaceRecognizerSF (blobFromImage with swapRB, no scaling or mean).
  const plane = CROP * CROP, input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) { input[i] = crop.data[i * 3]; input[plane + i] = crop.data[i * 3 + 1]; input[2 * plane + i] = crop.data[i * 3 + 2]; }
  const res = await e.rec.run({ data: new e.ort.Tensor('float32', input, [1, 3, CROP, CROP]) });
  const v = Float32Array.from(res.fc1.data as Float32Array);
  const norm = Math.hypot(...v) || 1;
  return v.map(x => x / norm);
}

export const cosine = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Rough head pose from the 5 landmarks: good enough to tell "turned" or "chin up" from "facing the camera". */
export function headPose(lm: Face['landmarks']): HeadPose {
  const [re, le, nose, rm, lm2] = lm;
  const roll = Math.atan2(le[1] - re[1], le[0] - re[0]);
  // Undo the roll around the eye midpoint so yaw and pitch are measured in the face's own axes.
  const ex = (re[0] + le[0]) / 2, ey = (re[1] + le[1]) / 2;
  const rot = ([x, y]: Point): Point => {
    const c = Math.cos(-roll), s = Math.sin(-roll), dx = x - ex, dy = y - ey;
    return [dx * c - dy * s, dx * s + dy * c];
  };
  const [r, l, n, m1, m2] = [re, le, nose, rm, lm2].map(rot);
  const eyeDist = Math.hypot(l[0] - r[0], l[1] - r[1]) || 1;
  const mouthY = (m1[1] + m2[1]) / 2;
  return { roll: roll * 180 / Math.PI, yaw: n[0] / eyeDist, pitch: mouthY > 0 ? n[1] / mouthY : 0.5 };
}

/** 64-bit difference hash of a crop (9x8 greyscale, adjacent-pixel comparisons). */
function dhash(img: Rgb): bigint {
  const W = 9, H = 8, g = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * img.width / W), x1 = Math.floor((x + 1) * img.width / W);
      const y0 = Math.floor(y * img.height / H), y1 = Math.floor((y + 1) * img.height / H);
      let s = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const p = (yy * img.width + xx) * 3; s += 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2]; c++;
      }
      g[y * W + x] = s / (c || 1);
    }
  }
  let h = 0n;
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) h = (h << 1n) | (g[y * W + x] > g[y * W + x + 1] ? 1n : 0n);
  return h;
}

export const hamming = (a: bigint, b: bigint) => { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
function iou(a: Face['box'], b: Face['box']) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

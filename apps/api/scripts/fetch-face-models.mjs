#!/usr/bin/env node
// Downloads the face-verification models into apps/api/models (or $FACE_MODELS_DIR) and checks their SHA-256.
// Runs as part of `npm run build` (so infra/deploy.sh ships them) and before the tests. Skips files already present
// with the right hash, so it only hits the network once per machine. Never called at request time.
//
//   YuNet 2023mar  (face detection, MIT)          https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
//   SFace 2021dec  (face recognition, Apache-2.0) https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.FACE_MODELS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models');
const BASE = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models';
const MODELS = [
  { file: 'face_detection_yunet_2023mar.onnx', url: `${BASE}/face_detection_yunet/face_detection_yunet_2023mar.onnx`,
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' },
  { file: 'face_recognition_sface_2021dec.onnx', url: `${BASE}/face_recognition_sface/face_recognition_sface_2021dec.onnx`,
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79' },
];

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
fs.mkdirSync(dir, { recursive: true });
for (const m of MODELS) {
  const target = path.join(dir, m.file);
  if (fs.existsSync(target) && sha(fs.readFileSync(target)) === m.sha256) continue;
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== m.sha256) throw new Error(`${m.file}: checksum mismatch (got ${sha(buf)})`);
  fs.writeFileSync(target + '.part', buf);
  fs.renameSync(target + '.part', target);
  console.log(`face model: ${m.file} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

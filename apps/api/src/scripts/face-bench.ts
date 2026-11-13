// Latency and memory of the selfie check: `npx tsx src/scripts/face-bench.ts [runs]`.
// Runs the checks in this process, as the face worker does, so RSS here is the worker's footprint.
// Prints the cold first check (model load included), warm checks, and RSS before, at peak and after release.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSelfie } from '../lib/face-check.js';
import { releaseModels } from '../lib/face.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../test-fixtures/faces');
const img = (f: string) => fs.readFileSync(path.join(dir, f));
const mb = () => Math.round(process.memoryUsage().rss / 1e6);
const runs = Number(process.argv[2] ?? 20);
const profile = img('profile.jpg');
const cases = [['same-person-turned.jpg', 'turn_head'], ['other-person-turned.jpg', 'turn_head'], ['two-faces.jpg', 'turn_head'], ['same-person-frontal.jpg', 'look_up']] as const;

const before = mb();
let peak = before;
let t = Date.now();
const first = await checkSelfie(profile, img(cases[0][0]), cases[0][1]);
const cold = Date.now() - t;
peak = Math.max(peak, mb());
const times: number[] = [];
for (let i = 0; i < runs; i++) {
  const [f, pose] = cases[i % cases.length];
  t = Date.now();
  const r = await checkSelfie(profile, img(f), pose);
  times.push(Date.now() - t);
  peak = Math.max(peak, mb());
  if (i < cases.length) console.log(f, pose, r.pass ? 'pass' : r.reason, JSON.stringify(r.scores));
}
await releaseModels();
(globalThis as any).gc?.();
await new Promise(r => setTimeout(r, 500));
times.sort((a, b) => a - b);
console.log(`first check (loads models): ${cold} ms -> ${first.pass ? 'pass' : first.reason}`);
console.log(`warm checks x${runs}: median ${times[Math.floor(times.length / 2)]} ms, max ${times[times.length - 1]} ms`);
console.log(`RSS: ${before} MB before, ${peak} MB peak, ${mb()} MB after releasing the models`);

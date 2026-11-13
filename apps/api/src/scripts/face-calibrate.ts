// Threshold calibration for lib/face-check.ts: genuine vs impostor similarity, natural head-pose range, and how
// well the near-copy rule catches re-saved copies of the same photo.
//   npm run face:calibrate -- <dir>     <dir>/<person>/*.jpg (one folder per person), optional <dir>/impostors/*.jpg
//   EXCLUDE=person/file.jpg,...          drop mislabelled photos
// The 29 Sep 2026 run used public-domain photos from Wikimedia Commons (13 named people + 117th Congress portraits);
// the photos are not in the repo, only the five test fixtures.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { analyse, cosine, hamming } from '../lib/face.js';

const ROOT = process.argv[2];
type Item = { person: string; file: string; emb: Float32Array; hash: bigint; pose: any; w: number; box: number[] };
const items: Item[] = [];
const t0 = Date.now(); let n = 0;
for (const person of fs.readdirSync(ROOT).filter(d => fs.statSync(path.join(ROOT, d)).isDirectory())) {
  for (const file of fs.readdirSync(path.join(ROOT, person)).filter(f => f.endsWith('.jpg'))) {
    const buf = fs.readFileSync(path.join(ROOT, person, file));
    let a;
    try { a = await analyse(buf); n++; } catch (e: any) { console.log('decode fail', person, file, e.message); continue; }
    const big = a.faces.filter((f: any) => f.box[2] >= Math.max(40, 0.35 * a.faces[0].box[2]));
    if (big.length !== 1 || !a.main || a.main.face.box[2] < 60) continue;
    items.push({ person: person === 'impostors' ? `imp_${file}` : person, file, emb: a.main.embedding, hash: a.main.hash, pose: a.main.pose, w: a.main.face.box[2], box: a.main.face.box });
  }
}
console.log(`analysed ${n} images in ${Date.now() - t0} ms (${((Date.now() - t0) / n).toFixed(0)} ms each); ${items.length} single-face`);
const exclude = new Set((process.env.EXCLUDE ?? '').split(',').filter(Boolean));
const use0 = items.filter(i => !exclude.has(`${i.person}/${i.file}`));
// The congressional category holds several files for some members (re-uploads, crops). Scores between these files
// show a clean gap: print them, then keep one file per cluster at cos >= 0.6.
const imps = use0.filter(i => i.person.startsWith('imp_'));
const ii: number[] = [];
for (let a = 0; a < imps.length; a++) for (let b = a + 1; b < imps.length; b++) ii.push(cosine(imps[a].emb, imps[b].emb));
console.log('congress file pairs by cosine band', [[0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].map(([lo, hi]) => `${lo}-${hi}: ${ii.filter(x => x >= lo && x < hi).length}`).join(', '));
const keptImps: Item[] = [];
for (const i of imps) if (keptImps.every(k => cosine(k.emb, i.emb) < 0.6)) keptImps.push(i);
const use = [...use0.filter(i => !i.person.startsWith('imp_')), ...keptImps];
console.log(`congress portraits: ${imps.length} files, ${keptImps.length} distinct people kept`);
fs.writeFileSync(path.join(ROOT, 'kept.json'), JSON.stringify(use.map(i => ({ person: i.person, file: i.file, box: i.box, pose: i.pose })), null, 0));

// Pairs from the same source photo (Commons keeps crops of one picture) are near-copies, not genuine pairs.
const SAME_SOURCE = (c: number, h: number) => c >= 0.93 || h <= 12;
const genHashes: [number, number][] = [];
const gen: number[] = [], imp: number[] = [], genPairs: [number, string, string][] = [], impPairs: [number, string, string][] = [];
for (let i = 0; i < use.length; i++) for (let j = i + 1; j < use.length; j++) {
  const s = cosine(use[i].emb, use[j].emb);
  const tag = [`${use[i].person}/${use[i].file}`, `${use[j].person}/${use[j].file}`] as const;
  if (use[i].person === use[j].person) {
    const h = hamming(use[i].hash, use[j].hash);
    genHashes.push([s, h]);
    if (!SAME_SOURCE(s, h)) { gen.push(s); genPairs.push([s, ...tag]); }
  } else { imp.push(s); impPairs.push([s, ...tag]); }
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x: number) => x.toFixed(3);
console.log(`people ${new Set(use.map(i => i.person)).size}, photos ${use.length}, genuine pairs ${gen.length}, impostor pairs ${imp.length}`);
console.log(`genuine  min ${f(Math.min(...gen))} p5 ${f(pct(gen, .05))} p50 ${f(pct(gen, .5))} max ${f(Math.max(...gen))}`);
console.log(`impostor min ${f(Math.min(...imp))} p50 ${f(pct(imp, .5))} p99 ${f(pct(imp, .99))} p99.9 ${f(pct(imp, .999))} max ${f(Math.max(...imp))}`);
for (const t of [0.30, 0.363, 0.40, 0.42, 0.45, 0.48, 0.50, 0.55, 0.60]) {
  const fr = gen.filter(s => s < t).length, fa = imp.filter(s => s >= t).length;
  console.log(`t=${t.toFixed(3)}  false rejects ${fr}/${gen.length} (${(100 * fr / gen.length).toFixed(1)}%)  false accepts ${fa}/${imp.length} (${(100 * fa / imp.length).toFixed(2)}%)`);
}
console.log('top impostors', impPairs.sort((a, b) => b[0] - a[0]).slice(0, 6).map(p => `${f(p[0])} ${p[1]} ~ ${p[2]}`));
console.log('lowest genuine', genPairs.sort((a, b) => a[0] - b[0]).slice(0, 10).map(p => `${f(p[0])} ${p[1]} ~ ${p[2]}`));
console.log('genuine max', genPairs.sort((a, b) => b[0] - a[0]).slice(0, 5).map(p => `${f(p[0])} ${p[1]} ~ ${p[2]}`));
const hs = []; for (let i = 0; i < use.length; i++) for (let j = i + 1; j < use.length; j++) if (use[i].person === use[j].person) hs.push(hamming(use[i].hash, use[j].hash));
console.log(`genuine crop-hash distance min ${Math.min(...hs)} p5 ${pct(hs, .05)} p50 ${pct(hs, .5)}`);
console.log('pose yaw  p5/p50/p95', f(pct(use.map(i => i.pose.yaw), .05)), f(pct(use.map(i => i.pose.yaw), .5)), f(pct(use.map(i => i.pose.yaw), .95)));
console.log('pose |yaw| p50/p90', f(pct(use.map(i => Math.abs(i.pose.yaw)), .5)), f(pct(use.map(i => Math.abs(i.pose.yaw)), .9)));
console.log('pose pitch p5/p50/p95', f(pct(use.map(i => i.pose.pitch), .05)), f(pct(use.map(i => i.pose.pitch), .5)), f(pct(use.map(i => i.pose.pitch), .95)));
console.log('pose roll |p90|', f(pct(use.map(i => Math.abs(i.pose.roll)), .9)));

// Near-copies: the same photo re-encoded, resized, cropped, brightened, framed like a screenshot, rotated.
const copies: number[] = [], copyHash: number[] = [];
for (const it of use.slice(0, 40)) {
  const buf = fs.readFileSync(path.join(ROOT, it.person, it.file));
  const m = await sharp(buf).metadata();
  const variants = [
    await sharp(buf).jpeg({ quality: 50 }).toBuffer(),
    await sharp(buf).resize(Math.round(m.width! / 2)).toBuffer(),
    await sharp(buf).extract({ left: Math.round(m.width! * .05), top: Math.round(m.height! * .05), width: Math.round(m.width! * .9), height: Math.round(m.height! * .9) }).toBuffer(),
    await sharp(buf).modulate({ brightness: 1.2, saturation: 0.8 }).toBuffer(),
    await sharp(buf).extend({ top: 120, bottom: 200, left: 30, right: 30, background: '#111' }).jpeg({ quality: 80 }).toBuffer(),
    await sharp(buf).rotate(12, { background: '#fff' }).toBuffer(),
  ];
  for (const v of variants) {
    const a = await analyse(v);
    if (!a.main) continue;
    const c = cosine(a.main.embedding, it.emb);
        copies.push(c); copyHash.push(hamming(a.main.hash, it.hash));
  }
}
for (const [c, h] of [[0.9, 6], [0.93, 6], [0.93, 8], [0.95, 6], [0.95, 10]]) {
  const caught = copies.filter((x, i) => x >= c || copyHash[i] <= h).length;
  const genFlag = gen.filter(x => x >= c).length;
  console.log(`near-copy rule cos>=${c} or hash<=${h}: catches ${caught}/${copies.length} variants; flags ${genFlag}/${gen.length} genuine different-photo pairs by cosine`);
}
console.log(`same-source genuine pairs excluded: ${genHashes.filter(([c, h]) => SAME_SOURCE(c, h)).length}`);
console.log(`near-copy cosine min ${f(Math.min(...copies))} p5 ${f(pct(copies, .05))} p50 ${f(pct(copies, .5))}; hash dist p50 ${pct(copyHash, .5)} p95 ${pct(copyHash, .95)} max ${Math.max(...copyHash)}`);

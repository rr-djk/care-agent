// Runs the image-quality gate on the 80 specimen pages, the 5 real photos and synthetic degradations, and writes
// warp previews. Usage: node --import tsx tools/quality-eval.mjs   (or: make quality-eval)
// Read-only on DATASETS_DIR; outputs go to eval-results/quality/ (git-ignored, or OUT_DIR).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { assess, loadCv, warpPage } from '@care-agent/quality';
import { cropLeft, exposure, gaussianBlur, glareBlob, MILD, motionBlur, onTable, STRONG, syntheticPage } from '@care-agent/quality/synthetic';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = resolve(repo, process.env.DATASETS_DIR ?? '../datasets', 'data/Paper Registry');
const out = resolve(repo, process.env.OUT_DIR ?? 'eval-results/quality');
mkdirSync(out, { recursive: true });

const load = async (path) => {
  const { data, info } = await sharp(path).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height, channels: 3 };
};
const toSharp = (img) => sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: img.channels } });
const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const row = (name, a) => {
  const { result: r, details: d } = a;
  return { name, outcome: r.outcome, blur: +f(r.metrics.blur), iso: +f(d.blur.isotropy, 2), brightness: +f(r.metrics.brightness, 0), glare: +f(r.metrics.glare, 3), framing: +f(r.metrics.framing, 2), skew: +f(d.skewDeg, 0), spread: d.exposure.spread, clipped: +f(d.exposure.clipped, 3), black: +f(d.exposure.black, 3), tiles: d.blur.tiles, messages: r.messages };
};

await loadCv();
const results = { specimens: [], photos: [], synthetic: [] };

// 1. the 80 clean specimen pages: all must be OK
const pages = JSON.parse(readFileSync(resolve(repo, 'tools/eval/data/pages.json'), 'utf8')).pages;
for (const p of pages) results.specimens.push(row(`p${p.page_no}`, assess(await load(resolve(registry, p.files[0])))));
const spec = results.specimens;
console.log(`specimens: ${spec.length} pages, OK ${spec.filter((r) => r.outcome === 'OK').length}, WARNING ${spec.filter((r) => r.outcome === 'WARNING').length}, REJECT ${spec.filter((r) => r.outcome === 'REJECT').length}`);
const range = (k) => `${Math.min(...spec.map((r) => r[k]))}..${Math.max(...spec.map((r) => r[k]))}`;
console.log(`  blur ${range('blur')}  brightness ${range('brightness')}  glare ${range('glare')}  spread ${range('spread')}`);
for (const r of spec.filter((r) => r.outcome !== 'OK')) console.log('  not OK:', r.name, r.messages.join(' | '));

// 2. the 5 real photos + warp previews (rectified page next to the original)
for (let i = 1; i <= 5; i++) {
  const img = await load(resolve(registry, `1-${i}.jpg`));
  const a = assess(img);
  const w = warpPage(img);
  results.photos.push({ ...row(`1-${i}.jpg`, a), quad: a.details.quad, warped: w.warped });
  const h = 800;
  // the detected quad (green) on the original
  const q = a.details.quad;
  const poly = q ? q.map((p) => `${p.x * img.width * (h / img.height)},${p.y * h}`).join(' ') : '';
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(img.width * (h / img.height))}" height="${h}"><polygon points="${poly}" fill="none" stroke="lime" stroke-width="3"/></svg>`);
  const left = await toSharp(img).resize({ height: h }).composite([{ input: overlay }]).png().toBuffer();
  const right = await toSharp(w.image).resize({ height: h }).png().toBuffer();
  const lm = await sharp(left).metadata();
  const rm = await sharp(right).metadata();
  await sharp({ create: { width: lm.width + rm.width + 10, height: h, channels: 3, background: w.warped ? '#ffffff' : '#ff0000' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: lm.width + 10, top: 0 }])
    .png()
    .toFile(`${out}/warp-${i}.png`);
}

// 3. synthetic degradations of 3 specimen pages (clean page = OK; blurry, dark, cropped = WARNING or REJECT)
const variants = {
  clean: (x) => x,
  'blur s2': (x) => gaussianBlur(x, 2),
  'blur s4': (x) => gaussianBlur(x, 4),
  'blur s8': (x) => gaussianBlur(x, 8),
  'motion 25px': (x) => motionBlur(x, 25),
  dark: (x) => exposure(x, 0.4),
  'very dark': (x) => exposure(x, 0.08),
  overexposed: (x) => exposure(x, 1.3, 70),
  'glare blob': (x) => glareBlob(x, 0.08),
  'cropped 20%': (x) => cropLeft(x, 0.2),
  'on table, mild': (x) => onTable(x, MILD),
  'strong perspective': (x) => onTable(x, STRONG),
};
const sources = [2, 3, 4].map((n) => ({ name: `p${n}`, file: pages.find((p) => p.page_no === n).files[0] }));
const grid = [];
for (const src of sources) {
  const base = await load(resolve(registry, src.file));
  for (const [name, make] of Object.entries(variants)) {
    const img = make(base);
    results.synthetic.push(row(`${src.name} ${name}`, assess(img)));
    if (src.name === 'p3') grid.push({ name, png: await toSharp(img).resize({ height: 400 }).png().toBuffer() });
  }
}
// contact sheet of the p3 variants, to look at them
const widths = await Promise.all(grid.map(async (g) => (await sharp(g.png).metadata()).width));
let x = 0;
await sharp({ create: { width: widths.reduce((a, b) => a + b + 4, 0), height: 400, channels: 3, background: '#888' } })
  .composite(grid.map((g, i) => ({ input: g.png, left: (x += i ? widths[i - 1] + 4 : 0), top: 0 })))
  .png()
  .toFile(`${out}/synthetic-p3.png`);

writeFileSync(`${out}/quality-eval.json`, JSON.stringify(results, null, 1));
console.table(results.photos.map(({ quad, messages, ...r }) => r));
for (const r of results.photos) console.log(r.name, r.outcome, '|', r.messages.join(' | ') || '-', '| quad', r.quad ? 'found' : 'NOT found', '| warped', r.warped);
console.table(results.synthetic.map(({ messages, spread, tiles, ...r }) => r));
console.log(`wrote ${out}/ (quality-eval.json, warp-1..5.png, synthetic-p3.png)`);

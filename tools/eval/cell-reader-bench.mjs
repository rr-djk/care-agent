// Cell-reader experiment, phase 1 (docs/cell-reader.md): reads every INKED text cell of a page with a per-cell recogniser
// and compares with the ground truth under the eval rule (run.mjs isCorrect). No model server, no cache: pure timing.
// Usage (from the repo root): node --import tsx tools/eval/cell-reader-bench.mjs
//   [--readers paddle,trocr-fp32,trocr-q8] [--page-nos 10,11,...] [--real 1-1] [--prep stretch|gray|raw] [--crop ink|box] [--pad 4] [--margin-x 8]
//   [--constrain] [--variants blur-s2,dark-0.6|all] [--out dir]
// --crop box = the cell box widened by --pad px; ink = widened by --pad, printed lines whitened, cut to the ink (inkTrimCrop).
// Defaults = the phase 1 choice (paddle, stretch, ink, 4). --constrain (paddle only, phase 2): reading under the field type
// (ctc.ts readField: pattern for dates/numbers/BP, best allowed value for enums); the free reading is kept beside it.
// --variants adds the degraded images of the pages (data/degraded, make degrade --split tune), rectified like uploads
// (as make predict does); the clean pages stay included.
// Default pages: the 12 tune pages of layouts identification, pregnancy, delivery (page types 2-4 of the tune patients).
// Cells are cut from the MASKED page (maskPage first), like crop.ts. Output: one JSONL record per cell + a summary.
// Never run on calibrate/verify; the real photo is report-only (labels by hand, never tuned on).
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadPageSchema } from '@care-agent/schema/node';
import { loadCellBoxes, loadLayoutImage, pagePngPath, realPhotoPath, repoRoot } from '../../apps/server/src/cli/pages.ts';
import { maskPage } from '../../apps/server/src/vision/crop.ts';
import { rectify } from '../../apps/server/src/vision/rectify.ts';
import { cellHasInk, checkboxInkRatio, inkRatio } from '../../apps/server/src/vision/ink.ts';
import { cellCrop, INK_CROP, inkTrimCrop, prepCrop } from '../../apps/server/src/vision/readers/common.ts';
import { greedy, readField } from '../../apps/server/src/vision/readers/ctc.ts';
import { paddleReader } from '../../apps/server/src/vision/readers/paddle.ts';
import { trocrReader } from '../../apps/server/src/vision/readers/trocr.ts';
import { isCorrect } from './run.mjs';

const { values } = parseArgs({
  options: {
    readers: { type: 'string', default: 'paddle' },
    'page-nos': { type: 'string' },
    real: { type: 'string' },
    prep: { type: 'string', default: 'stretch' },
    crop: { type: 'string', default: 'ink' },
    pad: { type: 'string', default: '4' },
    'margin-x': { type: 'string', default: '8' },
    constrain: { type: 'boolean', default: false },
    variants: { type: 'string' },
    out: { type: 'string', default: resolve(repoRoot, 'eval-results') },
  },
});
const here = import.meta.dirname;
const gt = JSON.parse(await readFile(join(here, 'data/ground_truth.json'), 'utf8'));
const split = JSON.parse(await readFile(join(here, 'data/split.json'), 'utf8'));
const tune = new Set(split.groups.tune.pages);
const pageNos = values['page-nos']
  ? values['page-nos'].split(',').map(Number)
  : [...tune].filter((no) => [2, 3, 4].includes(gt[no].page_type)).sort((a, b) => a - b);
for (const no of pageNos) if (!tune.has(no)) throw new Error(`page ${no} is not in the tune split (never tune on calibrate/verify)`);

const jobs = pageNos.map((no) => ({ id: String(no), variant: 'clean', layout: gt[no].layout, path: pagePngPath(no), slots: gt[no].slots }));
if (values.variants) {
  const manifest = JSON.parse(await readFile(resolve(repoRoot, 'data/degraded/manifest.json'), 'utf8'));
  const wanted = values.variants === 'all' ? null : new Set(values.variants.split(','));
  for (const e of manifest.variants) {
    if (!pageNos.includes(e.page_no) || (wanted && !wanted.has(e.variant))) continue;
    if (e.group !== 'tune') throw new Error(`variant ${e.file} is not a tune page (leakage)`);
    jobs.push({ id: `${e.page_no}/${e.variant}`, variant: e.variant, layout: gt[e.page_no].layout, path: resolve(repoRoot, 'data/degraded', e.file), slots: gt[e.page_no].slots });
  }
}
if (values.real) {
  const labels = JSON.parse(await readFile(join(here, 'data/real_photos_labels.json'), 'utf8'));
  const slots = labels.photos[`${values.real}.jpg`].fields.filter((s) => s.value !== '?' && s.value !== null);
  jobs.push({ id: values.real, variant: 'real', layout: 'real_cover', path: realPhotoPath(values.real), slots, real: true });
}

const makers = {
  paddle: () => paddleReader(resolve(repoRoot, 'models/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx')),
  'trocr-fp32': () => trocrReader(resolve(repoRoot, 'models'), undefined, 'fp32'),
  'trocr-q8': () => trocrReader(resolve(repoRoot, 'models'), undefined, 'q8'),
};
const pad = Number(values.pad);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(values.out, { recursive: true });
const outFile = join(values.out, `cell-bench-${stamp}.jsonl`);
console.log(`pages ${jobs.map((j) => j.id).join(',')} | prep ${values.prep} | crop ${values.crop} | pad ${pad}${values.constrain ? ' | constrained' : ''} -> ${outFile}`);

const summary = [];
const cellRows = []; // per text cell, for the by-type table
const typeKey = (f) => (f.validators.includes('bp') ? 'bp' : f.type === 'number' ? `number${f.unit ? ` ${f.unit}` : ''}` : f.type);
for (const name of values.readers.split(',')) {
  if (!makers[name]) throw new Error(`unknown reader ${name} (${Object.keys(makers).join(', ')})`);
  const t0 = performance.now();
  const reader = await makers[name]();
  console.log(`${name}: loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  for (const job of jobs) {
    const schema = loadPageSchema(job.layout);
    const boxes = loadCellBoxes(job.layout);
    const fields = new Map(schema.fields.map((f) => [f.id, f]));
    const tPage = performance.now();
    // like make predict: variants are rectified like uploads, clean specimens are read as they are
    const page = job.variant === 'clean' || job.real ? await loadLayoutImage(job.path, job.layout) : await rectify(await loadLayoutImage(job.path, job.layout));
    const masked = maskPage(page, schema.masks);
    const s = { reader: name, page: job.id, variant: job.variant, layout: job.layout, real: !!job.real, text_ne: [0, 0], text_e: [0, 0], cb_ne: [0, 0], cb_e: [0, 0], read_ms: 0, cells_read: 0 };
    const lines = [];
    for (const slot of job.slots) {
      const f = fields.get(slot.key);
      const box = boxes.get(slot.key);
      if (!f || !box) continue;
      const nonEmpty = !(slot.value === '' || slot.value === false);
      if (slot.kind === 'checkbox') {
        // same as the pipeline: checkboxes are decided by ink alone
        const ok = isCorrect(slot, cellHasInk(checkboxInkRatio(page, box.bbox_frac), 'checkbox', job.layout));
        const b = nonEmpty ? s.cb_ne : s.cb_e;
        b[0]++; b[1] += +ok;
        continue;
      }
      const ink = inkRatio(page, box.bbox_frac);
      let reading = null;
      if (cellHasInk(ink, 'text', job.layout)) {
        const crop = values.crop === 'ink' ? inkTrimCrop(masked, box.bbox_frac, pad, { ...INK_CROP, marginX: Number(values['margin-x']) }) : cellCrop(masked, box.bbox_frac, pad);
        if (values.constrain) {
          if (!reader.frames) throw new Error('--constrain needs the paddle reader');
          const t = performance.now();
          const fr = await reader.frames(prepCrop(crop, values.prep));
          const g = greedy(fr);
          const field = readField(fr, f);
          reading = { ...g, text: field.text, free: g.text, field, ms: performance.now() - t };
        } else reading = await reader.read(prepCrop(crop, values.prep));
        s.read_ms += reading.ms;
        s.cells_read++;
      }
      const predicted = reading?.text ?? '';
      const ok = isCorrect(slot, predicted);
      const okFree = isCorrect(slot, reading?.free ?? predicted);
      cellRows.push({ reader: name, layout: job.real ? 'real_cover (photo)' : job.variant === 'clean' ? job.layout : `${job.layout} (variants)`, type: typeKey(f), nonEmpty, ok, okFree });
      const b = nonEmpty ? s.text_ne : s.text_e;
      b[0]++; b[1] += +ok;
      lines.push(JSON.stringify({
        reader: name, page: job.id, variant: job.variant, layout: job.layout, real: !!job.real, key: slot.key, type: f.type, category: f.category,
        truth: slot.value, ink: +ink.toFixed(4), read: !!reading, reading: reading?.text ?? null, ok,
        steps: reading?.steps.map((st) => ({ t: st.text, p: +st.p.toFixed(4), alt: st.alt, pa: st.p_alt === undefined ? undefined : +st.p_alt.toFixed(4) })),
        seq_logprob: reading ? +reading.seq_logprob.toFixed(4) : null, ms: reading ? +reading.ms.toFixed(1) : 0,
        ...(reading?.field && {
          reading_free: reading.free, ok_free: okFree, method: reading.field.method, rank: reading.field.rank,
          logp: +reading.field.logp.toFixed(4), logp_free: +reading.field.logp_free.toFixed(4), posterior: +reading.field.posterior.toFixed(4),
          runner_up: reading.field.runner_up && { text: reading.field.runner_up.text, logp: +reading.field.runner_up.logp.toFixed(4) },
        }),
      }));
    }
    s.page_s = (performance.now() - tPage) / 1000;
    await appendFile(outFile, lines.join('\n') + '\n');
    summary.push(s);
    const pct = ([n, k]) => (n ? `${k}/${n}` : '-');
    console.log(`${name} ${job.layout.padEnd(14)} ${job.id.padStart(4)}: text non-empty ${pct(s.text_ne)}, text empty ${pct(s.text_e)}, ${s.cells_read} cells read, ${(s.read_ms / Math.max(1, s.cells_read)).toFixed(0)} ms/cell, page ${s.page_s.toFixed(1)} s`);
  }
}

// summary per reader x layout; "all" = text + checkbox slots, the same denominator as `make eval` (README section 4)
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const pc = ([n, k]) => (n ? `${((100 * k) / n).toFixed(1)}% (${k}/${n})` : 'n/a');
console.log('\nreader       layout          handwritten(all)       handwritten(text)      blank(all)        ms/cell  s/page');
const groups = new Map();
for (const s of summary) {
  const k = `${s.reader}|${s.real ? 'real_cover (photo)' : s.variant === 'clean' ? s.layout : `${s.layout} (variants)`}`;
  const g = groups.get(k) ?? { ne: [0, 0], tne: [0, 0], e: [0, 0], ms: 0, cells: 0, pages: 0, page_s: 0 };
  g.ne = add(g.ne, add(s.text_ne, s.cb_ne)); g.tne = add(g.tne, s.text_ne); g.e = add(g.e, add(s.text_e, s.cb_e));
  g.ms += s.read_ms; g.cells += s.cells_read; g.pages++; g.page_s += s.page_s;
  groups.set(k, g);
}
for (const [k, g] of groups) {
  const [reader, layout] = k.split('|');
  console.log(`${reader.padEnd(12)} ${layout.padEnd(15)} ${pc(g.ne).padEnd(22)} ${pc(g.tne).padEnd(22)} ${pc(g.e).padEnd(17)} ${(g.ms / Math.max(1, g.cells)).toFixed(0).padStart(7)} ${(g.page_s / g.pages).toFixed(1).padStart(7)}`);
}
if (values.constrain) {
  // handwritten text cells by field type: free (greedy) reading vs reading under the field type
  console.log('\nreader       layout             field type      handwritten free        handwritten constrained   blank free -> constrained');
  const by = new Map();
  for (const r of cellRows) {
    const k = `${r.reader}|${r.layout}|${r.type}`;
    const g = by.get(k) ?? { ne: [0, 0, 0], e: [0, 0, 0] };
    const b = r.nonEmpty ? g.ne : g.e;
    b[0]++; b[1] += +r.okFree; b[2] += +r.ok;
    by.set(k, g);
  }
  const fmt = (n, k) => (n ? `${((100 * k) / n).toFixed(1)}% (${k}/${n})` : 'n/a');
  for (const [k, g] of [...by].sort()) {
    const [reader, layout, type] = k.split('|');
    console.log(`${reader.padEnd(12)} ${layout.padEnd(18)} ${type.padEnd(15)} ${fmt(g.ne[0], g.ne[1]).padEnd(23)} ${fmt(g.ne[0], g.ne[2]).padEnd(25)} ${g.e[1]}/${g.e[0]} -> ${g.e[2]}/${g.e[0]}`);
  }
}
console.log(`wrote ${outFile}`);

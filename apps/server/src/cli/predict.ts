// Usage: npm run predict -w @care-agent/server -- [--split tune|calibrate|verify|all] [--pages p1,..,p8] [--page-nos 27,59] [--limit N]
//        [--variants all|blur-s2,glare] [--no-clean] [--real 1-1]
// Writes eval-results/predictions-<ts>.jsonl, one JSON record per line, appended page by page (a crashed run keeps what it read):
// the fields of a page (status, verbatim, normalized value, category, signals) + the gate metrics of its image + timings.
// `make eval --extractor <file>.jsonl` reads the values of the clean pages. --variants adds the degraded images of the selected
// pages (data/degraded/manifest.json, make degrade; ground truth = the source page's); --real reads a photo of the real
// form (layout real_cover; use --limit 0 for the photo alone). Details: docs/calibration.md.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { PageLayout } from '@care-agent/schema';
import { loadPageSchema } from '@care-agent/schema/node';
import { assess, loadCv } from '@care-agent/quality';
import { pipelineHash, qualityFactor } from '../calibration';
import { analyzePage } from '../vision/analyze';
import { readerMode } from '../vision/cellReader';
import { modelConfig } from '../vision/model';
import { rectify } from '../vision/rectify';
import { defaultDeps, loadPageImage, pageEntries, pageLayout, pagePngPath, realPhotoPath, repoRoot } from './pages';

const { values } = parseArgs({
  options: {
    split: { type: 'string', default: 'all' },
    pages: { type: 'string', default: 'p1,p2,p3,p4,p5,p6,p7,p8' },
    'page-nos': { type: 'string' },
    limit: { type: 'string' },
    variants: { type: 'string' },
    'no-clean': { type: 'boolean', default: false },
    real: { type: 'string' },
  },
});
const gt = JSON.parse(await readFile(`${repoRoot}/tools/eval/data/ground_truth.json`, 'utf8'));
const split = JSON.parse(await readFile(`${repoRoot}/tools/eval/data/split.json`, 'utf8'));
const types = new Set(values.pages.split(',').map((p) => Number(/^p(\d)$/.exec(p.trim())?.[1])));
const allowed: Set<number> | null = values.split === 'all' ? null : new Set(split.groups[values.split]?.pages);
const only = values['page-nos'] ? new Set(values['page-nos'].split(',').map(Number)) : null;
const pageNos = pageEntries
  .map((p) => p.page_no)
  .filter((no) => types.has(gt[no].page_type) && pageLayout(no) && (!allowed || allowed.has(no)) && (!only || only.has(no)))
  .slice(0, values.limit ? Number(values.limit) : undefined);
const groupOf = (no: number) => Object.keys(split.groups).find((g) => split.groups[g].pages.includes(no));

interface Job {
  page_no?: number;
  photo?: string;
  variant: string;
  variant_file?: string;
  layout: PageLayout;
  path: string;
}
const jobs: Job[] = [];
let manifest: { variants: { page_no: number; variant: string; group: string; file: string }[] } | undefined;
if (values.variants) {
  manifest = JSON.parse(await readFile(`${repoRoot}/data/degraded/manifest.json`, 'utf8'));
  for (const e of manifest!.variants) if (e.group !== groupOf(e.page_no)) throw new Error(`variant ${e.file}: group ${e.group} differs from its source page's (leakage): rerun make degrade`);
}
const wanted = values.variants && values.variants !== 'all' ? new Set(values.variants.split(',')) : null;
for (const no of pageNos) {
  const layout = gt[no].layout as PageLayout;
  if (!values['no-clean']) jobs.push({ page_no: no, variant: 'clean', layout, path: pagePngPath(no) });
  for (const e of manifest?.variants ?? []) {
    if (e.page_no === no && (!wanted || wanted.has(e.variant))) jobs.push({ page_no: no, variant: e.variant, layout, path: `${repoRoot}/data/degraded/${e.file}` });
  }
}
if (values.real) jobs.push({ photo: values.real, variant: 'real', layout: 'real_cover', path: realPhotoPath(values.real) });

await loadCv();
await mkdir(`${repoRoot}/eval-results`, { recursive: true });
const file = `${repoRoot}/eval-results/predictions-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
const hash = pipelineHash();
const model = modelConfig().model;
const reader = readerMode(); // READER=cell|hybrid: recorded so calibrate and report know which reader made the file
for (const job of jobs) {
  const raw = await loadPageImage(job.path);
  const { result, details } = assess({ data: new Uint8Array(raw.data), width: raw.width, height: raw.height, channels: 3 });
  const quality = qualityFactor(result.outcome);
  // like the server: photos and variants are rectified before reading; the clean specimens are read as they are
  const analysis = await analyzePage(job.variant === 'clean' ? raw : await rectify(raw), job.layout, defaultDeps(job.layout));
  const defs = new Map(loadPageSchema(job.layout).fields.map((f) => [f.id, f]));
  const sum = (f: (z: (typeof analysis.zones)[number]) => number) => analysis.zones.reduce((a, z) => a + f(z), 0);
  const record = {
    page_no: job.page_no ?? null,
    photo: job.photo,
    variant: job.variant,
    layout: job.layout,
    group: job.page_no ? groupOf(job.page_no) : 'held_out',
    patient: pageEntries.find((p) => p.page_no === job.page_no)?.patient,
    pipeline_hash: hash,
    model,
    ...(reader !== 'gemma' && { reader }),
    gate: {
      outcome: result.outcome,
      quality,
      blur: result.metrics.blur,
      isotropy: details.blur.isotropy,
      brightness: result.metrics.brightness,
      glare: result.metrics.glare,
      framing: result.metrics.framing,
      spread: details.exposure.spread,
      clipped: details.exposure.clipped,
      black: details.exposure.black,
      skew_deg: details.skewDeg,
      messages: result.messages,
    },
    // model time as measured by Ollama (kept in the cache, so also valid on a cache hit) and wall time of this run
    latency: { model_s: sum((z) => z.timings.prefill_s + z.timings.gen_s), wall_s: sum((z) => z.wall_s), zones: analysis.zones.length, skipped: analysis.zones.filter((z) => z.skipped).length, cache_hits: analysis.zones.filter((z) => z.cache_hit).length },
    fields: analysis.cells.map((c) => ({
      field_id: c.field_id,
      category: defs.get(c.field_id)!.category,
      type: defs.get(c.field_id)!.type,
      status: c.status,
      verbatim: c.verbatim,
      value: c.value,
      reason: c.reason ?? c.review_reason,
      signals: { agreement: c.agreement ?? null, validators_passed: !c.failed_validators.length, ink: c.ink ?? null, quality, ...(c.reader_score !== undefined && { reader_score: c.reader_score }) },
    })),
  };
  await appendFile(file, JSON.stringify(record) + '\n');
  console.log(`${job.photo ? `photo ${job.photo}` : `page ${job.page_no}`} ${job.variant} (${job.layout}): ${record.fields.length} cells, gate ${result.outcome}, ${record.latency.cache_hits}/${record.latency.zones} zones from cache`);
}
console.log(jobs.length ? `wrote ${file}` : 'nothing to read (no page matches)');

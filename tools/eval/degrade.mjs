// Degraded variants of specimen pages at graded levels -> data/degraded/<page_no>/<variant>.png (git-ignored) + manifest.json
// linking every variant to its source page_no, patient and split group (variants never change group).
// Usage: node --import tsx tools/eval/degrade.mjs [--split calibrate|tune|verify|all] [--pages p1,..,p8] [--page-nos 27,59]
//                                              [--limit N] [--variants blur-s2,glare|all] [--out data/degraded]
// (or: make degrade ARGS='...'). Read-only on DATASETS_DIR; refuses an output folder inside it. Re-running adds to the manifest.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { loadCv } from '@care-agent/quality';
import { exposure, gaussianBlur, glareBlob, MILD, motionBlur, onTable, STRONG } from '@care-agent/quality/synthetic';
import { manifestEntry, VARIANTS, verifyManifest } from './variants.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = (f) => JSON.parse(readFileSync(resolve(repo, 'tools/eval/data', f), 'utf8'));

const toSharp = (img) => sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: img.channels } });
const fromSharp = async (s) => {
  const { data: d, info } = await s.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(d), width: info.width, height: info.height, channels: 3 };
};

/** variant id -> (RawImage) => RawImage | Promise<RawImage> */
export const OPERATIONS = {
  'blur-s1': (i) => gaussianBlur(i, 1),
  'blur-s2': (i) => gaussianBlur(i, 2),
  'blur-s4': (i) => gaussianBlur(i, 4),
  'motion-15': (i) => motionBlur(i, 15),
  'dark-0.6': (i) => exposure(i, 0.6),
  'dark-0.4': (i) => exposure(i, 0.4),
  glare: (i) => glareBlob(i, 0.08),
  'jpeg-q30': async (i) => fromSharp(sharp(await toSharp(i).jpeg({ quality: 30 }).toBuffer())), // decoded again: the artefacts stay
  'down-0.5': (i) => fromSharp(toSharp(i).resize({ width: Math.round(i.width * 0.5) })), // cell boxes are fractions: the page stays valid
  'persp-mild': (i) => onTable(i, MILD, 1500, 2000),
  'persp-strong': (i) => onTable(i, STRONG, 1500, 2000),
};

async function main() {
  const { values } = parseArgs({
    options: {
      split: { type: 'string', default: 'calibrate' },
      pages: { type: 'string', default: 'p1,p2,p3,p4,p5,p6,p7,p8' },
      'page-nos': { type: 'string' },
      limit: { type: 'string' },
      variants: { type: 'string', default: 'all' },
      out: { type: 'string', default: 'data/degraded' },
    },
  });
  const split = data('split.json');
  const pages = data('pages.json').pages;
  const gt = data('ground_truth.json');
  const out = resolve(repo, values.out);
  const datasets = resolve(repo, process.env.DATASETS_DIR ?? '../datasets');
  if (!relative(datasets, out).startsWith('..')) throw new Error(`refusing to write inside DATASETS_DIR (${datasets})`);
  const ids = values.variants === 'all' ? VARIANTS.map((v) => v.id) : values.variants.split(',');
  for (const id of ids) if (!OPERATIONS[id]) throw new Error(`unknown variant "${id}" (known: ${Object.keys(OPERATIONS).join(', ')})`);

  const types = new Set(values.pages.split(',').map((p) => Number(/^p(\d)$/.exec(p.trim())?.[1])));
  const allowed = values.split === 'all' ? null : new Set(split.groups[values.split]?.pages);
  if (allowed === undefined) throw new Error(`--split must be tune, calibrate, verify or all, got "${values.split}"`);
  const only = values['page-nos'] ? new Set(values['page-nos'].split(',').map(Number)) : null;
  const selected = pages
    .filter((p) => types.has(p.page_type) && gt[p.page_no] && (!allowed || allowed.has(p.page_no)) && (!only || only.has(p.page_no)))
    .slice(0, values.limit ? Number(values.limit) : undefined);

  await loadCv();
  const manifestFile = resolve(out, 'manifest.json');
  let manifest = { generated: new Date().toISOString(), variants: [] };
  try {
    manifest = { ...JSON.parse(readFileSync(manifestFile, 'utf8')), generated: manifest.generated };
  } catch {} // first run
  const registry = resolve(datasets, 'data/Paper Registry');
  for (const page of selected) {
    const source = await fromSharp(sharp(resolve(registry, page.files[0])));
    for (const id of ids) {
      const entry = manifestEntry(page, id, split);
      const image = await OPERATIONS[id](source);
      mkdirSync(dirname(resolve(out, entry.file)), { recursive: true });
      await toSharp(image).png().toFile(resolve(out, entry.file));
      manifest.variants = [...manifest.variants.filter((e) => e.id !== entry.id), entry];
      console.log(`page ${page.page_no} (${entry.group}, patient ${entry.patient}) ${id} -> ${entry.file}`);
    }
  }
  manifest.variants.sort((a, b) => a.page_no - b.page_no || VARIANTS.findIndex((v) => v.id === a.variant) - VARIANTS.findIndex((v) => v.id === b.variant));
  verifyManifest(manifest, split, pages);
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${manifestFile} (${manifest.variants.length} variants of ${new Set(manifest.variants.map((e) => e.page_no)).size} pages)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`degrade failed: ${e.message}`);
    process.exit(1);
  });
}

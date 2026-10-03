#!/usr/bin/env node
// Deterministic 3-way patient split (tune / calibrate / verify) from data/pages.json -> data/split.json.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Fixed seed: changing it changes the split, so it is recorded in split.json.
export const SEED = 20261003;
export const SIZES = { tune: 4, calibrate: 3, verify: 3 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of `patients`, then cut by SIZES. Lists are sorted for readability. */
export function splitPatients(patients, seed = SEED) {
  const rand = mulberry32(seed);
  const a = [...patients].sort((x, y) => x - y);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const total = Object.values(SIZES).reduce((s, n) => s + n, 0);
  if (a.length !== total) throw new Error(`expected ${total} patients, got ${a.length}`);
  const out = {};
  let at = 0;
  for (const [group, n] of Object.entries(SIZES)) out[group] = a.slice(at, (at += n)).sort((x, y) => x - y);
  return out;
}

/** pages: unique pages from pages.json; held_out: JPG list. */
export function buildSplit(pages, held_out, seed = SEED) {
  const patients = [...new Set(pages.map((p) => p.patient))];
  const groups = splitPatients(patients, seed);
  const out = { seed, groups: {}, held_out: held_out.map((h) => h.file) };
  for (const [g, list] of Object.entries(groups)) {
    out.groups[g] = {
      patients: list,
      pages: pages.filter((p) => list.includes(p.patient)).map((p) => p.page_no),
    };
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { pages, held_out } = JSON.parse(await readFile(join(here, 'data', 'pages.json'), 'utf8'));
    const split = buildSplit(pages, held_out);
    await writeFile(join(here, 'data', 'split.json'), JSON.stringify(split, null, 2) + '\n');
    console.log(`seed: ${split.seed}`);
    for (const [g, v] of Object.entries(split.groups)) console.log(`${g}: patients ${v.patients.join(', ')} (${v.pages.length} pages)`);
  } catch (e) {
    console.error(`split failed (run dedupe.mjs first?): ${e.message}`);
    process.exit(1);
  }
}

#!/usr/bin/env node
// Groups the specimen PNGs by content hash into the 80 unique pages and writes data/pages.json. Read-only on the dataset.
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256 } from '../check-datasets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PDF = 'dossiers_specimen_10_patientes.pdf';
const PAGES_PER_PATIENT = 8;

// Parses NN from dossiers_specimen_10_patientes-NN.png or ...-NN__<suffix>.png.
export function parsePageNo(file) {
  const m = /-(\d{2})(?:__.*)?\.png$/.exec(file);
  return m ? Number(m[1]) : null;
}

export const patientOf = (pageNo) => Math.ceil(pageNo / PAGES_PER_PATIENT);
export const pageTypeOf = (pageNo) => ((pageNo - 1) % PAGES_PER_PATIENT) + 1;

/** hashes: [{file, sha256}] -> unique pages sorted by page_no. Throws if one page number has several contents. */
export function buildPages(hashes) {
  const byPage = new Map();
  for (const { file, sha256: digest } of hashes) {
    const page_no = parsePageNo(file);
    if (page_no === null) throw new Error(`cannot parse page number from ${file}`);
    const page = byPage.get(page_no) ?? { page_no, sha256: digest, files: [] };
    if (page.sha256 !== digest) throw new Error(`page ${page_no}: files differ in content (${file})`);
    page.files.push(file);
    byPage.set(page_no, page);
  }
  return [...byPage.values()]
    .sort((a, b) => a.page_no - b.page_no)
    .map((p) => ({
      page_no: p.page_no,
      patient: patientOf(p.page_no),
      page_type: pageTypeOf(p.page_no),
      sha256: p.sha256,
      files: p.files.sort(),
    }));
}

/** Patient index "n°k/10" printed on a PDF page, or null if pdftotext is unavailable. */
export async function pdfPatient(pdf, pageNo) {
  try {
    const { stdout } = await promisify(execFile)('pdftotext', ['-f', String(pageNo), '-l', String(pageNo), pdf, '-']);
    const m = /n°\s*(\d+)\s*\/\s*10/.exec(stdout);
    return m ? Number(m[1]) : undefined;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const datasets = resolve(process.env.DATASETS_DIR || join(here, '..', '..', '..', 'datasets'));
  const dir = join(datasets, 'data', 'Paper Registry');
  try {
    const names = await readdir(dir);
    const pngs = names.filter((n) => n.endsWith('.png')).sort();
    const jpgs = names.filter((n) => n.endsWith('.jpg')).sort();
    const pages = buildPages(await Promise.all(pngs.map(async (file) => ({ file, sha256: await sha256(join(dir, file)) }))));
    const held_out = await Promise.all(jpgs.map(async (file) => ({ file, sha256: await sha256(join(dir, file)) })));

    // Cross-check patient index against the PDF text.
    let crossCheck = 'ok';
    for (const p of pages) {
      const k = await pdfPatient(join(dir, PDF), p.page_no);
      if (k === null) { crossCheck = 'skipped (pdftotext unavailable)'; console.warn('warning: pdftotext not found, skipping PDF cross-check'); break; }
      if (k !== p.patient) throw new Error(`page ${p.page_no}: filename says patient ${p.patient}, PDF says ${k}`);
    }

    await mkdir(join(here, 'data'), { recursive: true });
    await writeFile(join(here, 'data', 'pages.json'), JSON.stringify({ pages, held_out }, null, 2) + '\n');
    console.log(`PNG files: ${pngs.length} -> unique pages: ${pages.length}`);
    console.log(`duplicate files: ${pngs.length - pages.length}`);
    console.log(`patients: ${new Set(pages.map((p) => p.patient)).size}`);
    console.log(`held-out JPGs: ${held_out.length}`);
    console.log(`pdftotext cross-check: ${crossCheck}`);
  } catch (e) {
    console.error(`dedupe failed: ${e.message}`);
    process.exit(1);
  }
}

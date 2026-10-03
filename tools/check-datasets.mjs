#!/usr/bin/env node
// Dataset guard: verifies every manifest.json entry (existence, bytes, sha256). Read-only.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/**
 * Entries are resolved under `dir`, then under its parent (the manifest lists
 * consignes-fr-en.pdf at its root although it lives one level above datasets/).
 */
export async function checkDatasets(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const bases = [dir, dirname(dir)];
  const problems = [];
  const parentUsed = [];
  const seen = new Map();
  let ok = 0;

  for (const entry of manifest.files) {
    seen.set(entry.sha256, (seen.get(entry.sha256) ?? 0) + 1);
    let found = null;
    for (const base of bases) {
      const p = join(base, entry.path);
      const s = await stat(p).catch(() => null);
      if (s?.isFile()) { found = { p, base, size: s.size }; break; }
    }
    if (!found) { problems.push(`MISSING ${entry.path}`); continue; }
    if (found.base !== dir) parentUsed.push(entry.path);
    if (found.size !== entry.bytes) {
      problems.push(`SIZE ${entry.path}: expected ${entry.bytes}, got ${found.size}`);
      continue;
    }
    const digest = await sha256(found.p);
    if (digest !== entry.sha256) problems.push(`SHA256 ${entry.path}: expected ${entry.sha256}, got ${digest}`);
    else ok++;
  }

  // Number of manifest entries whose sha256 is shared with at least one other entry.
  const duplicates = manifest.files.filter((e) => seen.get(e.sha256) > 1).length;
  return { total: manifest.files.length, ok, problems, duplicates, parentUsed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = resolve(process.env.DATASETS_DIR || join(here, '..', '..', 'datasets'));
  try {
    const r = await checkDatasets(dir);
    console.log(`datasets: ${dir}`);
    for (const p of r.parentUsed) console.log(`  base: parent directory (${dirname(dir)}) used for ${p}`);
    console.log(`entries: ${r.total}, ok: ${r.ok}, mismatches/missing: ${r.problems.length}`);
    console.log(`info: ${r.duplicates} entries share an identical sha256 with another entry`);
    for (const p of r.problems) console.log(`  ${p}`);
    process.exit(r.problems.length ? 1 : 0);
  } catch (e) {
    console.error(`cannot check datasets in ${dir}: ${e.message}`);
    process.exit(1);
  }
}

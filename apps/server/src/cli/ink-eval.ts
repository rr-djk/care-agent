// Evaluates the ink detector against the ground truth (no model): empty vs non-empty text slots, ticked vs unticked
// checkboxes, per layout, over every page of the layouts that have a schema.
// Usage: npm run ink-eval -w @care-agent/server
import { readFileSync } from 'node:fs';
import { PAGE_LAYOUTS, type PageLayout } from '@care-agent/schema';
import { checkboxInkRatio, inkRatio } from '../vision/ink';
import { loadCellBoxes, loadPageImage, pagePngPath, repoRoot } from './pages';

const THRESHOLDS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1];
const gt = JSON.parse(readFileSync(`${repoRoot}/tools/eval/data/ground_truth.json`, 'utf8'));
const templates = Object.fromEntries(PAGE_LAYOUTS.map((l) => [l, loadCellBoxes(l)]));
const samples: Record<string, { ratio: number; positive: boolean }[]> = {};
for (const pageNo of Object.keys(gt)) {
  const page = gt[pageNo];
  if (!(PAGE_LAYOUTS as readonly string[]).includes(page.layout)) continue;
  const img = await loadPageImage(pagePngPath(Number(pageNo)));
  for (const s of page.slots) {
    const box = templates[page.layout as PageLayout].get(s.key); // the geometry the analyzer has at run time
    if (!box) continue;
    (samples[`${page.layout}/${s.kind}`] ??= []).push({ ratio: (s.kind === 'checkbox' ? checkboxInkRatio : inkRatio)(img, box.bbox_frac), positive: s.value !== false && s.value !== '' });
  }
}
for (const [kind, list] of Object.entries(samples)) {
  const pos = list.filter((s) => s.positive).length;
  console.log(`${kind}: ${list.length} slots, ${pos} non-empty`);
  for (const t of THRESHOLDS) {
    const tp = list.filter((s) => s.positive && s.ratio >= t).length;
    const fp = list.filter((s) => !s.positive && s.ratio >= t).length;
    console.log(`  t=${t}  precision=${(tp / (tp + fp || 1)).toFixed(3)} recall=${(tp / (pos || 1)).toFixed(3)} (tp=${tp} fp=${fp} fn=${pos - tp})`);
  }
}

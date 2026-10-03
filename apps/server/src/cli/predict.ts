// Usage: npm run predict -w @care-agent/server -- [--split tune|calibrate|verify|all] [--pages p1,p2,p3,p4,p5,p6,p7,p8] [--limit N]
// Writes eval-results/predictions-<ts>.json ({page_no: {key: verbatim | true/false for checkboxes}}) for `make eval`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { PageLayout } from '@care-agent/schema';
import { analyzePage } from '../vision/analyze';
import { defaultDeps, loadPageImage, pageEntries, pageLayout, pagePngPath, repoRoot } from './pages';

const { values } = parseArgs({
  options: { split: { type: 'string', default: 'all' }, pages: { type: 'string', default: 'p1,p2,p3,p4,p5,p6,p7,p8' }, limit: { type: 'string' } },
});
const gt = JSON.parse(await readFile(`${repoRoot}/tools/eval/data/ground_truth.json`, 'utf8'));
const split = JSON.parse(await readFile(`${repoRoot}/tools/eval/data/split.json`, 'utf8'));
const types = new Set(values.pages.split(',').map((p) => Number(/^p(\d)$/.exec(p.trim())?.[1])));
const allowed: Set<number> | null = values.split === 'all' ? null : new Set(split.groups[values.split]?.pages);
const pageNos = pageEntries
  .map((p) => p.page_no)
  .filter((no) => types.has(gt[no].page_type) && pageLayout(no) && (!allowed || allowed.has(no)))
  .slice(0, values.limit ? Number(values.limit) : undefined);

const predictions: Record<number, Record<string, string | boolean>> = {};
for (const no of pageNos) {
  const layout = gt[no].layout as PageLayout;
  const { cells } = await analyzePage(await loadPageImage(pagePngPath(no)), layout, defaultDeps(layout));
  predictions[no] = Object.fromEntries(cells.map((c) => [c.field_id, typeof c.value === 'boolean' ? c.value : (c.verbatim ?? '')]));
  console.log(`page ${no} (${layout}): ${cells.length} cells`);
}
await mkdir(`${repoRoot}/eval-results`, { recursive: true });
const file = `${repoRoot}/eval-results/predictions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(file, JSON.stringify(predictions, null, 2) + '\n');
console.log(`wrote ${file}`);

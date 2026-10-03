// Usage: npm run analyze -w @care-agent/server -- <page.png | page_no> [--layout L] [--zones id1,id2] [--json out.json] [--save-crops dir]
// --save-crops writes, per zone sent to the model: <zone>.png (the crop), <zone>.prompt.txt and <zone>.answer.json.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PAGE_LAYOUTS, type PageLayout } from '@care-agent/schema';
import { analyzePage } from '../vision/analyze';
import { ModelError } from '../vision/model';
import { defaultDeps, loadPageImage, pageLayout, pagePngPath } from './pages';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { layout: { type: 'string' }, zones: { type: 'string' }, json: { type: 'string' }, 'save-crops': { type: 'string' } },
});
const target = positionals[0];
if (!target) {
  console.error('usage: analyze <page.png | page_no> [--layout L] [--zones id1,id2] [--json out.json] [--save-crops dir]');
  process.exit(1);
}
const pageNo = /^\d+$/.test(target) ? Number(target) : undefined;
const layout = (values.layout ?? (pageNo !== undefined ? pageLayout(pageNo) : undefined)) as PageLayout | undefined;
if (!layout || !PAGE_LAYOUTS.includes(layout)) {
  console.error(`--layout ${PAGE_LAYOUTS.join('|')} is required (page_no ${pageNo ?? '-'} has no known layout)`);
  process.exit(1);
}

const pad = (v: unknown, n: number) => String(v ?? '-').slice(0, n).padEnd(n);
const f = (n: number, d = 1) => n.toFixed(d);
let totals = { prefill: 0, gen: 0, tokens: 0, wall: 0, skipped: 0, hits: 0 };
try {
  const page = await loadPageImage(pageNo !== undefined ? pagePngPath(pageNo) : resolve(target));
  console.log(`${pad('zone', 18)} ${pad('field', 44)} ${pad('verbatim', 22)} ${pad('status', 14)} ${pad('ink', 6)}`);
  const deps = defaultDeps(layout);
  const cropDir = values['save-crops'] && resolve(process.env.INIT_CWD ?? '.', values['save-crops']);
  if (cropDir) {
    await mkdir(cropDir, { recursive: true });
    deps.onModelCall = async ({ zone_id, prompt, crop, content }) => {
      await writeFile(`${cropDir}/${zone_id}.png`, crop);
      await writeFile(`${cropDir}/${zone_id}.prompt.txt`, prompt + '\n');
      await writeFile(`${cropDir}/${zone_id}.answer.json`, content + '\n');
    };
  }
  const result = await analyzePage(page, layout, deps, {
    zones: values.zones?.split(','),
    onProgress: (z) => {
      for (const c of z.cells) {
        console.log(`${pad(z.zone_id, 18)} ${pad(c.field_id, 44)} ${pad(c.verbatim === null ? 'null' : JSON.stringify(c.verbatim), 22)} ${pad(c.status, 14)} ${pad(c.ink?.toFixed(4), 6)}`);
      }
      const t = z.timings;
      console.log(`  -> ${z.zone_id}: ${z.skipped ? 'SKIPPED (no ink)' : `prefill ${f(t.prefill_s)} s (${t.prompt_tokens} tok), gen ${f(t.gen_s)} s (${t.output_tokens} tok)`}${z.cache_hit ? ' [cache hit]' : ''}, wall ${f(z.wall_s)} s`);
      totals = { prefill: totals.prefill + t.prefill_s, gen: totals.gen + t.gen_s, tokens: totals.tokens + t.output_tokens, wall: totals.wall + z.wall_s, skipped: totals.skipped + +z.skipped, hits: totals.hits + +z.cache_hit };
    },
  });
  console.log(`total: prefill ${f(totals.prefill)} s, gen ${f(totals.gen)} s, ${totals.tokens} output tokens, wall ${f(totals.wall)} s; ${totals.skipped} zones skipped, ${totals.hits} cache hits`);
  if (values.json) await writeFile(resolve(process.env.INIT_CWD ?? '.', values.json), JSON.stringify(result, null, 2) + '\n');
} catch (e) {
  if (!(e instanceof ModelError)) throw e;
  console.error(`model error (${e.kind}): ${e.message}`);
  process.exit(2);
}
